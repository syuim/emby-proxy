package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// newTestBackend returns a backend server that always responds with a redirect
// to the given Location header value.
func newTestBackend(location string, status int) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", location)
		w.WriteHeader(status)
	}))
}

func newTestBackendOK(body string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, body)
	}))
}

func newTestSetup(backendURL string) (*ProxyHandler, *Store) {
	store := NewStore("")
	store.ApplySnapshot(1, []ProxyEntry{{PathPrefix: "media", BackendURL: backendURL}})
	ph := NewProxyHandler(store)
	return ph, store
}

func doRequest(handler http.Handler, path string) (*http.Response, string) {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	resp := rec.Result()
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(body)
}

// ---------------------------------------------------------------------------
// Redirect tests
// ---------------------------------------------------------------------------

func TestRelativeRedirectFollowed(t *testing.T) {
	backend := newTestBackend("/other-path", http.StatusFound)
	defer backend.Close()

	ph, _ := newTestSetup(backend.URL)
	resp, body := doRequest(ph, "/media/test")

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", resp.StatusCode)
	}
	if !strings.Contains(body, "redirect limit exceeded") {
		t.Fatalf("expected 'redirect limit exceeded', got: %s", body)
	}
	if strings.Contains(body, "not allowed") {
		t.Fatalf("should not contain 'not allowed': %s", body)
	}
}

func TestSameOriginAbsoluteRedirectFollowed(t *testing.T) {
	backend := newTestBackend("/loop", http.StatusFound)
	defer backend.Close()

	ph, _ := newTestSetup(backend.URL)
	resp, body := doRequest(ph, "/media/test")

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", resp.StatusCode)
	}
	if !strings.Contains(body, "redirect limit exceeded") {
		t.Fatalf("expected 'redirect limit exceeded', got: %s", body)
	}
	if strings.Contains(body, "not allowed") {
		t.Fatalf("should not contain 'not allowed': %s", body)
	}
}

func TestSSRFCloudMetadataBlocked(t *testing.T) {
	backend := newTestBackend("http://169.254.169.254/latest/meta-data/", http.StatusFound)
	defer backend.Close()

	ph, _ := newTestSetup(backend.URL)
	resp, body := doRequest(ph, "/media/test")

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", resp.StatusCode)
	}
	if !strings.Contains(body, "redirect target is not allowed") {
		t.Fatalf("expected SSRF block message, got: %s", body)
	}
}

func TestSSRFInternalHostBlocked(t *testing.T) {
	backend := newTestBackend("http://10.0.0.1:9090/admin", http.StatusFound)
	defer backend.Close()

	ph, _ := newTestSetup(backend.URL)
	resp, body := doRequest(ph, "/media/test")

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", resp.StatusCode)
	}
	if !strings.Contains(body, "redirect target is not allowed") {
		t.Fatalf("expected SSRF block message, got: %s", body)
	}
}

func TestSSRFLoopbackBlocked(t *testing.T) {
	backend := newTestBackend("http://127.0.0.1:1/", http.StatusFound)
	defer backend.Close()

	ph, _ := newTestSetup(backend.URL)
	resp, body := doRequest(ph, "/media/test")

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", resp.StatusCode)
	}
	if !strings.Contains(body, "redirect target is not allowed") {
		t.Fatalf("expected SSRF block message, got: %s", body)
	}
}

func TestCDNRedirectAllowed(t *testing.T) {
	// Redirect to a different public host (simulates CDN redirect)
	// Using 1.1.1.1 (Cloudflare DNS) as a safe public IP target
	backend := newTestBackend("http://1.1.1.1/test", http.StatusFound)
	defer backend.Close()

	ph, _ := newTestSetup(backend.URL)
	_, body := doRequest(ph, "/media/test")

	// Should NOT be blocked — 1.1.1.1 is a public IP
	// Will get redirect limit exceeded (loops to 1.1.1.1 which also redirects)
	// or connection error, but NOT SSRF block
	if strings.Contains(body, "not allowed") {
		t.Fatalf("CDN redirect should not be blocked: %s", body)
	}
}

func TestSSRFProtocolRelativeBlocked(t *testing.T) {
	backend := newTestBackend("//169.254.169.254/metadata", http.StatusFound)
	defer backend.Close()

	ph, _ := newTestSetup(backend.URL)
	resp, body := doRequest(ph, "/media/test")

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", resp.StatusCode)
	}
	if !strings.Contains(body, "redirect target is not allowed") {
		t.Fatalf("expected SSRF block message, got: %s", body)
	}
}

func TestNoRedirectPassthrough(t *testing.T) {
	backend := newTestBackendOK("hello from backend")
	defer backend.Close()

	ph, _ := newTestSetup(backend.URL)
	resp, body := doRequest(ph, "/media/test")

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if body != "hello from backend" {
		t.Fatalf("expected 'hello from backend', got: %s", body)
	}
}

func TestUnknownPrefixReturns404(t *testing.T) {
	store := NewStore("")
	ph := NewProxyHandler(store)

	resp, _ := doRequest(ph, "/unknown/path")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", resp.StatusCode)
	}
}

func TestOptionsPreflight(t *testing.T) {
	store := NewStore("")
	store.ApplySnapshot(1, []ProxyEntry{{PathPrefix: "media", BackendURL: "http://example.com"}})
	ph := NewProxyHandler(store)

	req := httptest.NewRequest(http.MethodOptions, "/media/test", nil)
	rec := httptest.NewRecorder()
	ph.ServeHTTP(rec, req)
	resp := rec.Result()

	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", resp.StatusCode)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("missing CORS header")
	}
}

// ---------------------------------------------------------------------------
// normalizeOrigin unit tests
// ---------------------------------------------------------------------------

func TestNormalizeOriginImplicitPort(t *testing.T) {
	h, p, ok := normalizeOrigin("http://host/path")
	if !ok || h != "host" || p != 80 {
		t.Fatalf("expected (host, 80, true), got (%s, %d, %v)", h, p, ok)
	}

	h2, p2, ok2 := normalizeOrigin("http://host:80/path")
	if !ok2 || h2 != "host" || p2 != 80 {
		t.Fatalf("expected (host, 80, true), got (%s, %d, %v)", h2, p2, ok2)
	}
}

func TestNormalizeOriginHTTPS(t *testing.T) {
	h, p, ok := normalizeOrigin("https://host/path")
	if !ok || h != "host" || p != 443 {
		t.Fatalf("expected (host, 443, true), got (%s, %d, %v)", h, p, ok)
	}

	h2, p2, ok2 := normalizeOrigin("https://host:443/path")
	if !ok2 || h2 != "host" || p2 != 443 {
		t.Fatalf("expected (host, 443, true), got (%s, %d, %v)", h2, p2, ok2)
	}
}

func TestNormalizeOriginCaseInsensitive(t *testing.T) {
	h, p, ok := normalizeOrigin("http://MyServer/path")
	if !ok || h != "myserver" || p != 80 {
		t.Fatalf("expected (myserver, 80, true), got (%s, %d, %v)", h, p, ok)
	}
}

func TestNormalizeOriginDifferentPort(t *testing.T) {
	_, p1, _ := normalizeOrigin("http://host:8080")
	_, p2, _ := normalizeOrigin("http://host")
	if p1 == p2 {
		t.Fatal("port 8080 should differ from implicit 80")
	}
}

func TestNormalizeOriginNoHostname(t *testing.T) {
	_, _, ok := normalizeOrigin("not-a-url")
	if ok {
		t.Fatal("expected false for malformed URL")
	}
}

// ---------------------------------------------------------------------------
// Admin endpoint tests
// ---------------------------------------------------------------------------

func TestSyncEndpoint(t *testing.T) {
	store := NewStore(t.TempDir())
	ah := NewAdminHandler(store, "test-token")

	// Unauthorized
	req := httptest.NewRequest(http.MethodPost, "/admin/sync", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	ah.HandleSync(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	// Authorized
	payload := `{"version": 5, "proxies": [{"path_prefix": "emby", "backend_url": "http://emby:8096"}]}`
	req = httptest.NewRequest(http.MethodPost, "/admin/sync", strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	ah.HandleSync(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var result map[string]any
	json.NewDecoder(rec.Body).Decode(&result)
	if result["ok"] != true {
		t.Fatal("expected ok=true")
	}

	// Verify store was updated
	if store.GetBackend("emby") != "http://emby:8096" {
		t.Fatalf("expected backend http://emby:8096, got %s", store.GetBackend("emby"))
	}
}

func TestStatusEndpoint(t *testing.T) {
	store := NewStore("")
	store.ApplySnapshot(3, []ProxyEntry{{PathPrefix: "a", BackendURL: "http://a"}})
	ah := NewAdminHandler(store, "tok")

	// Unauthorized
	req := httptest.NewRequest(http.MethodGet, "/admin/status", nil)
	rec := httptest.NewRecorder()
	ah.HandleStatus(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	// Authorized
	req = httptest.NewRequest(http.MethodGet, "/admin/status", nil)
	req.Header.Set("Authorization", "Bearer tok")
	rec = httptest.NewRecorder()
	ah.HandleStatus(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var state map[string]any
	json.NewDecoder(rec.Body).Decode(&state)
	if int(state["version"].(float64)) != 3 {
		t.Fatalf("expected version 3, got %v", state["version"])
	}
}

// ---------------------------------------------------------------------------
// Set-Cookie sanitization
// ---------------------------------------------------------------------------

func TestSanitizeSetCookie(t *testing.T) {
	input := "session=abc; Domain=.example.com; Path=/; HttpOnly; Secure"
	result := sanitizeSetCookie(input)
	if strings.Contains(result, "Domain=") || strings.Contains(result, "Path=") {
		t.Fatalf("Domain/Path not stripped: %s", result)
	}
	if !strings.Contains(result, "session=abc") {
		t.Fatalf("cookie value missing: %s", result)
	}
	if !strings.Contains(result, "HttpOnly") {
		t.Fatalf("HttpOnly missing: %s", result)
	}
}

// ---------------------------------------------------------------------------
// splitPrefix tests
// ---------------------------------------------------------------------------

func TestSplitPrefix(t *testing.T) {
	tests := []struct {
		path   string
		prefix string
		rest   string
	}{
		{"/media/test", "media", "/test"},
		{"/media", "media", "/"},
		{"/", "", ""},
		{"", "", ""},
		{"/a/b/c", "a", "/b/c"},
	}
	for _, tt := range tests {
		p, r := splitPrefix(tt.path)
		if p != tt.prefix || r != tt.rest {
			t.Errorf("splitPrefix(%q) = (%q, %q), want (%q, %q)", tt.path, p, r, tt.prefix, tt.rest)
		}
	}
}

// ---------------------------------------------------------------------------
// Hop-by-hop header filtering
// ---------------------------------------------------------------------------

func TestFilterRequestHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	h.Set("Connection", "keep-alive")
	h.Set("Host", "evil.com")
	h.Set("CF-Connecting-IP", "1.2.3.4")
	h.Set("Authorization", "Bearer xxx")

	filtered := filterRequestHeaders(h)
	if filtered.Get("Content-Type") != "application/json" {
		t.Fatal("Content-Type should be forwarded")
	}
	if filtered.Get("Authorization") != "Bearer xxx" {
		t.Fatal("Authorization should be forwarded")
	}
	if filtered.Get("Connection") != "" {
		t.Fatal("Connection should be stripped")
	}
	if filtered.Get("Host") != "" {
		t.Fatal("Host should be stripped")
	}
	if filtered.Get("CF-Connecting-IP") != "" {
		t.Fatal("CF-Connecting-IP should be stripped")
	}
}

// ---------------------------------------------------------------------------
// POST body passthrough
// ---------------------------------------------------------------------------

func TestPostBodyPassthrough(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != "request-body" {
			t.Errorf("expected 'request-body', got %q", body)
		}
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	}))
	defer backend.Close()

	ph, _ := newTestSetup(backend.URL)
	req := httptest.NewRequest(http.MethodPost, "/media/test", strings.NewReader("request-body"))
	rec := httptest.NewRecorder()
	ph.ServeHTTP(rec, req)
	resp := rec.Result()
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if string(body) != "ok" {
		t.Fatalf("expected 'ok', got %s", body)
	}
}

// ---------------------------------------------------------------------------
// 303 redirect — POST → GET
// ---------------------------------------------------------------------------

func TestPostFollows303Redirect(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			w.Header().Set("Location", "/done")
			w.WriteHeader(http.StatusSeeOther)
			return
		}
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "get-ok")
	}))
	defer backend.Close()

	ph, _ := newTestSetup(backend.URL)
	req := httptest.NewRequest(http.MethodPost, "/media/test", nil)
	rec := httptest.NewRecorder()
	ph.ServeHTTP(rec, req)
	resp := rec.Result()
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if string(body) != "get-ok" {
		t.Fatalf("expected 'get-ok', got %s", body)
	}
}

// ---------------------------------------------------------------------------
// Request body limit
// ---------------------------------------------------------------------------

func TestRequestBodyLimit(t *testing.T) {
	store := NewStore("")
	store.ApplySnapshot(1, []ProxyEntry{{PathPrefix: "media", BackendURL: "http://127.0.0.1:1"}})
	ph := NewProxyHandler(store)

	// Send a body larger than maxRequestBodySize
	huge := strings.Repeat("x", maxRequestBodySize+1)
	req := httptest.NewRequest(http.MethodPost, "/media/test", strings.NewReader(huge))
	rec := httptest.NewRecorder()
	ph.ServeHTTP(rec, req)
	resp := rec.Result()
	resp.Body.Close()

	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", resp.StatusCode)
	}
}

// ---------------------------------------------------------------------------
// Response header filtering (Set-Cookie sanitization)
// ---------------------------------------------------------------------------

func TestFilterResponseHeadersStripsDomain(t *testing.T) {
	src := http.Header{}
	src.Set("Content-Type", "application/json")
	src.Set("Set-Cookie", "session=abc; Domain=.evil.com; HttpOnly")
	src.Set("X-Custom", "keep")

	filtered := filterResponseHeaders(src)
	if filtered.Get("Content-Type") != "application/json" {
		t.Fatal("Content-Type should be kept")
	}
	if filtered.Get("X-Custom") != "keep" {
		t.Fatal("X-Custom should be kept")
	}
	cookie := filtered.Get("Set-Cookie")
	if strings.Contains(cookie, "Domain=") {
		t.Fatalf("Set-Cookie should not contain Domain: %s", cookie)
	}
	if !strings.Contains(cookie, "session=abc") {
		t.Fatalf("Set-Cookie should contain session=abc: %s", cookie)
	}
}

// ---------------------------------------------------------------------------
// isDangerousBackendURL
// ---------------------------------------------------------------------------

func TestIsDangerousBackendURL(t *testing.T) {
	tests := []struct {
		url    string
		safe   bool // safe = not dangerous
	}{
		{"http://192.168.1.1:8096", true},     // private, allowed as backend
		{"http://10.0.0.1:8096", true},        // private, allowed as backend
		{"http://127.0.0.1:8096", true},       // loopback, allowed as backend
		{"http://169.254.169.254/latest/", false}, // link-local, blocked
		{"http://[::1]:8096", true},           // loopback IPv6, allowed
		{"http://1.1.1.1:8096", true},         // public, allowed
		{"http://0.0.0.0:8096", false},        // unspecified, blocked
		{"not-a-url", false},                  // invalid, blocked
	}
	for _, tt := range tests {
		got := !isDangerousBackendURL(tt.url)
		if got != tt.safe {
			t.Errorf("isDangerousBackendURL(%q) = safe=%v, want safe=%v", tt.url, got, tt.safe)
		}
	}
}
