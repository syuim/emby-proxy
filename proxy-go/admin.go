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
	if !ah.checkAuth(r) {
		log.Printf("sync auth failed: remote=%s ua=%s", r.RemoteAddr, r.Header.Get("User-Agent"))
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var data struct {
		Version int          `json:"version"`
		Proxies []ProxyEntry `json:"proxies"`
	}
	if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	if data.Proxies == nil {
		data.Proxies = []ProxyEntry{}
	}

	ah.store.ApplySnapshot(data.Version, data.Proxies)
	log.Printf("sync push accepted: remote=%s version=%d proxies=%d",
		r.RemoteAddr, data.Version, len(data.Proxies))
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
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
