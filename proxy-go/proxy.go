package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxRedirects = 5
const maxRequestBodySize = 64 << 20 // 64 MiB

// hopByHop headers that must not be forwarded (RFC 7230 §6.1).
var hopByHop = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailers":            true,
	"transfer-encoding":   true,
	"upgrade":             true,
	"host":                true,
	"cf-connecting-ip":    true,
	"cf-ipcountry":        true,
	"cf-ray":              true,
	"cf-visitor":          true,
	"expect":              true,
}

var redirectStatuses = map[int]bool{
	301: true, 302: true, 303: true, 307: true, 308: true,
}

func corsHeaders() http.Header {
	h := make(http.Header)
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH")
	h.Set("Access-Control-Allow-Headers", "*")
	h.Set("Access-Control-Max-Age", "86400")
	return h
}

// ProxyHandler implements the reverse proxy with redirect following and SSRF guard.
type ProxyHandler struct {
	store      *Store
	httpClient *http.Client
}

func NewProxyHandler(store *Store) *ProxyHandler {
	return &ProxyHandler{
		store: store,
		httpClient: &http.Client{
			Timeout: 0, // no overall timeout; let the backend control timing
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse // we handle redirects manually
			},
		},
	}
}

func (ph *ProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	prefix, subPath := splitPrefix(r.URL.Path)
	if prefix == "" {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}

	backendURL := ph.store.GetBackend(prefix)
	if backendURL == "" {
		log.Printf("req: %s %s → 404 (unknown prefix %q)", r.Method, r.URL.Path, prefix)
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}

	// OPTIONS preflight
	if r.Method == http.MethodOptions {
		for k, v := range corsHeaders() {
			w.Header()[k] = v
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Build target URL
	targetURL := backendURL + subPath
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	// Remember the configured backend's origin for redirect validation
	allowedHost, allowedPort, _ := normalizeOrigin(backendURL)

	started := time.Now()
	log.Printf("req: %s %s → %s", r.Method, r.URL.Path, shortenURL(targetURL))

	// Read request body for non-GET/HEAD methods (buffered for redirect replay)
	var bodyBytes []byte
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		var err error
		limited := http.MaxBytesReader(nil, r.Body, maxRequestBodySize)
		bodyBytes, err = io.ReadAll(limited)
		if err != nil {
			if isMaxBytesError(err) {
				http.Error(w, "Payload Too Large", http.StatusRequestEntityTooLarge)
			} else {
				http.Error(w, fmt.Sprintf("Bad Gateway: read body: %v", err), http.StatusBadGateway)
			}
			return
		}
		r.Body.Close()
	}

	// Filter request headers once
	reqHeaders := filterRequestHeaders(r.Header)

	currentURL := targetURL
	currentMethod := r.Method
	redirectsLeft := maxRedirects
	followCount := 0

	for {
		var bodyReader io.Reader
		if bodyBytes != nil {
			bodyReader = bytes.NewReader(bodyBytes)
		}

		req, err := http.NewRequest(currentMethod, currentURL, bodyReader)
		if err != nil {
			http.Error(w, fmt.Sprintf("Bad Gateway: %v", err), http.StatusBadGateway)
			return
		}

		// Copy filtered headers
		for k, vv := range reqHeaders {
			for _, v := range vv {
				req.Header.Set(k, v)
			}
		}
		// Set Host to backend host
		if u, err := url.Parse(currentURL); err == nil {
			req.Host = u.Host
		}
		if len(bodyBytes) > 0 {
			req.ContentLength = int64(len(bodyBytes))
		}

		resp, err := ph.httpClient.Do(req)
		if err != nil {
			log.Printf("upstream error %s %s: %v", currentMethod, shortenURL(currentURL), err)
			http.Error(w, fmt.Sprintf("Bad Gateway: %v", err), http.StatusBadGateway)
			return
		}

		if !redirectStatuses[resp.StatusCode] {
			// Final response — break out of redirect loop
			defer resp.Body.Close()

			// Filter response headers
			filteredHeaders := filterResponseHeaders(resp.Header)
			for k, vv := range filteredHeaders {
				for i, v := range vv {
					if i == 0 {
						w.Header().Set(k, v)
					} else {
						w.Header().Add(k, v)
					}
				}
			}
			if w.Header().Get("Access-Control-Allow-Origin") == "" {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			}

			w.WriteHeader(resp.StatusCode)

			var n int64
			if resp.Body != nil {
				n, err = io.Copy(w, resp.Body)
				if err != nil {
					log.Printf("stream error: %v", err)
				}
			}

			elapsed := time.Since(started).Milliseconds()
			log.Printf("done: %s %s → %d in %dms (%d follow) | transferred=%d",
				r.Method, r.URL.Path, resp.StatusCode, elapsed, followCount, n)
			return
		}

		// Redirect handling
		if redirectsLeft <= 0 {
			resp.Body.Close()
			log.Printf("redirect limit hit (%d) at %s", maxRedirects, shortenURL(currentURL))
			http.Error(w, fmt.Sprintf("Bad Gateway: redirect limit exceeded (%d hops)", maxRedirects), http.StatusBadGateway)
			return
		}

		loc := resp.Header.Get("Location")
		if loc == "" {
			resp.Body.Close()
			log.Printf("redirect %d without Location header at %s", resp.StatusCode, shortenURL(currentURL))
			// Treat as final response
			filteredHeaders := filterResponseHeaders(resp.Header)
			for k, vv := range filteredHeaders {
				for i, v := range vv {
					if i == 0 {
						w.Header().Set(k, v)
					} else {
						w.Header().Add(k, v)
					}
				}
			}
			w.WriteHeader(resp.StatusCode)
			return
		}

		nextURL, err := url.Parse(loc)
		if err != nil {
			resp.Body.Close()
			http.Error(w, "Bad Gateway: invalid redirect URL", http.StatusBadGateway)
			return
		}
		// Resolve relative URLs
		if !nextURL.IsAbs() {
			base, _ := url.Parse(currentURL)
			nextURL = base.ResolveReference(nextURL)
		}
		nextURLStr := nextURL.String()

		// Redirect validation:
		// 1. Same origin as configured backend → always allow
		// 2. Cross-origin → block only if target is a dangerous IP (private/loopback/link-local)
		nextHost, nextPort, ok := normalizeOrigin(nextURLStr)
		sameOrigin := ok && nextHost == allowedHost && nextPort == allowedPort
		if !sameOrigin && isDangerousRedirect(nextURLStr) {
			resp.Body.Close()
			log.Printf("redirect to dangerous target blocked: %s → %s",
				shortenURL(currentURL), shortenURL(nextURLStr))
			http.Error(w, "Bad Gateway: redirect target is not allowed", http.StatusBadGateway)
			return
		}

		resp.Body.Close()

		// 303 → GET; 301/302 + POST → GET
		if resp.StatusCode == 303 || (resp.StatusCode == 301 || resp.StatusCode == 302) && currentMethod == http.MethodPost {
			currentMethod = http.MethodGet
			bodyBytes = nil
		}

		followCount++
		log.Printf("follow #%d: %d %s → %s", followCount, resp.StatusCode, shortenURL(currentURL), shortenURL(nextURLStr))
		currentURL = nextURLStr
		redirectsLeft--
	}
}

func filterRequestHeaders(src http.Header) http.Header {
	out := make(http.Header)
	for k, vv := range src {
		if hopByHop[strings.ToLower(k)] {
			continue
		}
		out[k] = vv
	}
	return out
}

func filterResponseHeaders(src http.Header) http.Header {
	out := make(http.Header)
	for k, vv := range src {
		kl := strings.ToLower(k)
		if hopByHop[kl] {
			continue
		}
		if kl == "set-cookie" {
			filtered := make([]string, len(vv))
			for i, v := range vv {
				filtered[i] = sanitizeSetCookie(v)
			}
			out[k] = filtered
		} else {
			out[k] = vv
		}
	}
	return out
}

func sanitizeSetCookie(cookie string) string {
	parts := strings.Split(cookie, ";")
	kept := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		pl := strings.ToLower(p)
		if strings.HasPrefix(pl, "domain=") || strings.HasPrefix(pl, "path=") {
			continue
		}
		kept = append(kept, p)
	}
	return strings.Join(kept, "; ")
}

func isMaxBytesError(err error) bool {
	var maxErr *http.MaxBytesError
	return errors.As(err, &maxErr)
}

func shortenURL(u string, maxLen ...int) string {
	max := 80
	if len(maxLen) > 0 {
		max = maxLen[0]
	}
	parsed, err := url.Parse(u)
	if err != nil {
		if len(u) > max {
			return u[:max-3] + "..."
		}
		return u
	}
	out := parsed.Host + parsed.Path
	if len(out) > max {
		out = out[:max-3] + "..."
	}
	return out
}

// isDangerousRedirect returns true if the redirect target points to an
// internal/private network address that should not be accessed via SSRF.
// Allows public CDN hosts (common for Emby video stream redirects).
func isDangerousRedirect(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return true // can't parse → block
	}

	host := u.Hostname()
	if host == "" {
		return true // no host → block
	}

	// Block protocol-relative / empty scheme
	if u.Scheme == "" {
		return true
	}

	// Resolve hostname to IP and check ranges
	ips, err := net.LookupIP(host)
	if err != nil {
		// Can't resolve — check if it looks like a raw IP
		ip := net.ParseIP(host)
		if ip == nil {
			// Unresolvable hostname — allow it (will fail at connect time)
			return false
		}
		ips = []net.IP{ip}
	}

	for _, ip := range ips {
		if isPrivateOrReserved(ip) {
			return true
		}
	}

	return false
}

// isPrivateOrReserved returns true for IPs that should never be proxied to.
func isPrivateOrReserved(ip net.IP) bool {
	// Loopback
	if ip.IsLoopback() {
		return true
	}
	// Private ranges (10.x, 172.16-31.x, 192.168.x)
	if ip.IsPrivate() {
		return true
	}
	// Link-local (169.254.x.x — cloud metadata, fe80::)
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return true
	}
	// Unspecified (0.0.0.0, ::)
	if ip.IsUnspecified() {
		return true
	}
	return false
}
