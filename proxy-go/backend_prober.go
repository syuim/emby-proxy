package main

import (
	"log"
	"net"
	"net/url"
	"time"
)

// BackendProber periodically measures TCP connect latency to each emby backend.
type BackendProber struct {
	store  *Store
	interval time.Duration
	stopCh   chan struct{}
}

func NewBackendProber(store *Store, interval time.Duration) *BackendProber {
	return &BackendProber{store: store, interval: interval, stopCh: make(chan struct{})}
}

func (bp *BackendProber) Start() {
	go bp.loop()
}

func (bp *BackendProber) Stop() {
	close(bp.stopCh)
}

func (bp *BackendProber) loop() {
	ticker := time.NewTicker(bp.interval)
	defer ticker.Stop()

	// probe once immediately
	bp.probeAll()

	for {
		select {
		case <-ticker.C:
			bp.probeAll()
		case <-bp.stopCh:
			return
		}
	}
}

func (bp *BackendProber) probeAll() {
	state := bp.store.GetState()
	proxiesRaw, ok := state["proxies"].([]ProxyEntry)
	if !ok || len(proxiesRaw) == 0 {
		return
	}
	for _, entry := range proxiesRaw {
		prefix := entry.PathPrefix
		backendURL := entry.BackendURL
		if prefix == "" || backendURL == "" {
			continue
		}
		ms := probeLatency(backendURL)
		bp.store.SetBackendLatency(prefix, ms)
	}
}

// probeLatency measures TCP connect time to the host:port of a backend URL.
// Returns -1 on failure.
func probeLatency(rawURL string) int64 {
	u, err := url.Parse(rawURL)
	if err != nil {
		return -1
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		switch u.Scheme {
		case "https":
			port = "443"
		default:
			port = "80"
		}
	}
	addr := net.JoinHostPort(host, port)
	start := time.Now()
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		log.Printf("[probe] tcp dial fail prefix=%s err=%v", host, err)
		return -1
	}
	conn.Close()
	ms := time.Since(start).Milliseconds()
	log.Printf("[probe] tcp ok prefix=%s addr=%s latency=%dms", extractPrefix(rawURL, host), addr, ms)
	return ms
}

// extractPrefix returns a short label for log output.
func extractPrefix(rawURL, host string) string {
	if len(rawURL) > 60 {
		return rawURL[:60] + "..."
	}
	return host
}
