package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

// AdminHandler handles /admin/sync and /admin/status endpoints.
type AdminHandler struct {
	store     *Store
	syncToken string
}

func NewAdminHandler(store *Store, syncToken string) *AdminHandler {
	return &AdminHandler{store: store, syncToken: syncToken}
}

func (ah *AdminHandler) checkAuth(r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return false
	}
	return auth[len("Bearer "):] == ah.syncToken
}

// HandleSync receives config snapshot pushes from master: POST /admin/sync
func (ah *AdminHandler) HandleSync(w http.ResponseWriter, r *http.Request) {
	log.Printf("sync: incoming remote=%s ua=%q content_length=%d",
		r.RemoteAddr, r.Header.Get("User-Agent"), r.ContentLength)

	if !ah.checkAuth(r) {
		log.Printf("sync: auth failed remote=%s", r.RemoteAddr)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var data struct {
		Version int          `json:"version"`
		Proxies []ProxyEntry `json:"proxies"`
	}
	if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
		log.Printf("sync: bad json remote=%s err=%v", r.RemoteAddr, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	if data.Proxies == nil {
		data.Proxies = []ProxyEntry{}
	}

	diff := ah.store.ApplySnapshot(data.Version, data.Proxies)
	log.Printf("sync: applied remote=%s old_version=%d new_version=%d incoming_proxies=%d added=%v removed=%v changed=%v",
		r.RemoteAddr, diff.OldVersion, diff.NewVersion, len(data.Proxies),
		diff.Added, diff.Removed, diff.Changed)

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":              true,
		"applied_version": data.Version,
	})
}

// HandleStatus returns current config state: GET /admin/status
func (ah *AdminHandler) HandleStatus(w http.ResponseWriter, r *http.Request) {
	if !ah.checkAuth(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	writeJSON(w, http.StatusOK, ah.store.GetState())
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
