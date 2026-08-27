package main

import (
	"encoding/json"
	"log"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	dnsCacheTTL        = 10 * time.Minute
	dnsCacheMaxEntries = 1024
)

type dnsCacheEntry struct {
	ips       []net.IP
	expiresAt time.Time
}

var (
	dnsCacheMu sync.Mutex
	dnsCache   = map[string]dnsCacheEntry{}
)

// cachedLookupIP resolves host to IPs with a bounded TTL cache.
func cachedLookupIP(host string) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	now := time.Now()
	dnsCacheMu.Lock()
	if entry, ok := dnsCache[host]; ok {
		if now.Before(entry.expiresAt) {
			dnsCacheMu.Unlock()
			return entry.ips, nil
		}
		delete(dnsCache, host)
	}
	dnsCacheMu.Unlock()

	ips, err := net.LookupIP(host)
	if err != nil {
		return nil, err
	}
	dnsCacheMu.Lock()
	if len(dnsCache) >= dnsCacheMaxEntries {
		// 先清过期条目，仍满则整体清空（DNS 重解析成本低）
		for k, e := range dnsCache {
			if !now.Before(e.expiresAt) {
				delete(dnsCache, k)
			}
		}
		if len(dnsCache) >= dnsCacheMaxEntries {
			dnsCache = map[string]dnsCacheEntry{}
		}
	}
	dnsCache[host] = dnsCacheEntry{ips: ips, expiresAt: now.Add(dnsCacheTTL)}
	dnsCacheMu.Unlock()
	return ips, nil
}

// 与 cf-worker 的 EMBY_NAME_RE / RESERVED_NAMES 保持一致
var reservedPrefixes = map[string]bool{
	"admin":       true,
	"api":         true,
	"health":      true,
	"__health":    true,
	"favicon.ico": true,
	"robots.txt":  true,
	".well-known": true,
	"_":           true,
	"tmdb":        true,
}

func isValidPathPrefix(p string) bool {
	if len(p) == 0 || len(p) > 32 {
		return false
	}
	for _, c := range p {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return !reservedPrefixes[p]
}

type ProxyEntry struct {
	PathPrefix string `json:"path_prefix"`
	BackendURL string `json:"backend_url"`
}

type Snapshot struct {
	Version  int          `json:"version"`
	Proxies  []ProxyEntry `json:"proxies"`
	SyncedAt string       `json:"synced_at,omitempty"`
}

// Store holds the in-memory proxy config with thread-safe access and disk persistence.
type Store struct {
	mu               sync.RWMutex
	proxies          map[string]string // prefix → backend_url
	version          int
	dataDir          string
	backendLatencies map[string]int64 // prefix → latency_ms (updated by BackendProber)
}

func NewStore(dataDir string) *Store {
	return &Store{
		proxies:          make(map[string]string),
		dataDir:          dataDir,
		backendLatencies: make(map[string]int64),
	}
}

func (s *Store) configPath() string {
	return filepath.Join(s.dataDir, "emby_slave_config.json")
}

// LoadFromDisk reads config from JSON file at startup.
func (s *Store) LoadFromDisk() {
	p := s.configPath()
	data, err := os.ReadFile(p)
	if err != nil {
		log.Printf("slave config not found at %s — starting empty", p)
		return
	}

	var snap Snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		log.Printf("failed to parse slave config: %v — starting empty", err)
		return
	}

	s.mu.Lock()
	s.version = snap.Version
	s.proxies = make(map[string]string, len(snap.Proxies))
	for _, p := range snap.Proxies {
		if isDangerousBackendURL(p.BackendURL) {
			log.Printf("slave config skipped dangerous backend: prefix=%s backend=%s", p.PathPrefix, p.BackendURL)
			continue
		}
		s.proxies[p.PathPrefix] = p.BackendURL
	}
	s.mu.Unlock()
	log.Printf("slave config loaded: version=%d proxies=%d", snap.Version, len(s.proxies))
}

// GetBackend returns the backend URL for a prefix, or "" if not found.
func (s *Store) GetBackend(prefix string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.proxies[prefix]
}

// SetBackendLatency stores a latency measurement for a backend prefix.
func (s *Store) SetBackendLatency(prefix string, latencyMs int64) {
	s.mu.Lock()
	s.backendLatencies[prefix] = latencyMs
	s.mu.Unlock()
}

// ListProxies returns a copy of the current prefix → backend entries.
func (s *Store) ListProxies() []ProxyEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ProxyEntry, 0, len(s.proxies))
	for k, v := range s.proxies {
		out = append(out, ProxyEntry{PathPrefix: k, BackendURL: v})
	}
	return out
}

// GetState returns the current config for /admin/status.
func (s *Store) GetState() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	proxies := make([]ProxyEntry, 0, len(s.proxies))
	for k, v := range s.proxies {
		proxies = append(proxies, ProxyEntry{PathPrefix: k, BackendURL: v})
	}
	latencies := make(map[string]int64, len(s.backendLatencies))
	for k, v := range s.backendLatencies {
		latencies[k] = v
	}
	return map[string]any{
		"version":           s.version,
		"proxies":           proxies,
		"backend_latencies": latencies,
	}
}

// SnapshotDiff records what changed during ApplySnapshot.
type SnapshotDiff struct {
	OldVersion int
	NewVersion int
	Added      []string
	Removed    []string
	Changed    []string // prefix existed in both but backend_url changed
}

// ApplySnapshot replaces config and persists to disk atomically. It returns a
// diff describing what changed so the caller can log it.
func (s *Store) ApplySnapshot(version int, proxies []ProxyEntry) SnapshotDiff {
	filtered := make([]ProxyEntry, 0, len(proxies))
	for _, p := range proxies {
		if !isValidPathPrefix(p.PathPrefix) {
			log.Printf("snapshot skipped invalid prefix: prefix=%q backend=%s", p.PathPrefix, p.BackendURL)
			continue
		}
		if isDangerousBackendURL(p.BackendURL) {
			log.Printf("snapshot skipped dangerous backend: prefix=%s backend=%s", p.PathPrefix, p.BackendURL)
			continue
		}
		filtered = append(filtered, p)
	}

	s.mu.Lock()
	// version 单调性：拒绝旧 snapshot 回退（过期推送/重放）
	if version < s.version {
		s.mu.Unlock()
		log.Printf("snapshot rejected: version=%d < current=%d", version, s.version)
		return SnapshotDiff{OldVersion: s.version, NewVersion: s.version}
	}
	diff := SnapshotDiff{OldVersion: s.version, NewVersion: version}
	oldProxies := s.proxies
	newProxies := make(map[string]string, len(filtered))
	for _, p := range filtered {
		newProxies[p.PathPrefix] = p.BackendURL
	}
	for k, v := range newProxies {
		if oldV, ok := oldProxies[k]; !ok {
			diff.Added = append(diff.Added, k)
		} else if oldV != v {
			diff.Changed = append(diff.Changed, k)
		}
	}
	for k := range oldProxies {
		if _, ok := newProxies[k]; !ok {
			diff.Removed = append(diff.Removed, k)
		}
	}
	s.version = version
	s.proxies = newProxies
	s.backendLatencies = make(map[string]int64)
	s.mu.Unlock()

	s.persist(version, filtered)
	log.Printf("snapshot applied: version=%d proxies=%d", version, len(filtered))
	return diff
}

func (s *Store) persist(version int, proxies []ProxyEntry) {
	if s.dataDir == "" {
		return // skip persistence in tests
	}
	payload := Snapshot{
		Version:  version,
		Proxies:  proxies,
		SyncedAt: time.Now().UTC().Format(time.RFC3339),
	}

	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		log.Printf("failed to marshal config: %v", err)
		return
	}

	if err := os.MkdirAll(s.dataDir, 0755); err != nil {
		log.Printf("failed to create data dir: %v", err)
		return
	}

	// Atomic write: write to .tmp then rename
	p := s.configPath()
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		log.Printf("failed to write config tmp: %v", err)
		return
	}
	if err := os.Rename(tmp, p); err != nil {
		log.Printf("failed to rename config: %v", err)
	}
}

// isDangerousBackendURL returns true if the backend points to link-local,
// unspecified or cloud metadata addresses. Loopback/private are allowed as
// legitimate local backends.
func isDangerousBackendURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return true
	}
	host := u.Hostname()
	if host == "" {
		return true
	}
	if host == "169.254.169.254" {
		return true
	}
	ips, err := cachedLookupIP(host)
	if err != nil {
		return false
	}
	for _, ip := range ips {
		if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
			return true
		}
	}
	return false
}
