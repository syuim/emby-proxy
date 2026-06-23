package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	log.SetFlags(log.Ldate | log.Ltime)
	log.SetOutput(os.Stdout)

	syncToken := os.Getenv("EMBY_SYNC_TOKEN")
	if syncToken == "" {
		log.Fatal("EMBY_SYNC_TOKEN is required")
	}

	port := os.Getenv("EMBY_PROXY_PORT")
	if port == "" {
		port = "8080"
	}

	dataDir := os.Getenv("EMBY_DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}

	store := NewStore(dataDir)
	store.LoadFromDisk()

	proxyHandler := NewProxyHandler(store)
	adminHandler := NewAdminHandler(store, syncToken)

	mux := http.NewServeMux()

	// Health check — 同时返回当前 applied_version，worker 一次 fetch 拿完
	mux.HandleFunc("/__health", func(w http.ResponseWriter, r *http.Request) {
		state := store.GetState()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":              true,
			"applied_version": state["version"],
		})
	})

	// Admin endpoints
	mux.HandleFunc("/admin/sync", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		adminHandler.HandleSync(w, r)
	})
	mux.HandleFunc("/admin/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		adminHandler.HandleStatus(w, r)
	})

	// Catch-all proxy route (must be last)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/favicon.ico" {
			http.NotFound(w, r)
			return
		}
		proxyHandler.ServeHTTP(w, r)
	})

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadTimeout:       0, // no timeout for streaming
		ReadHeaderTimeout: 30 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigCh
		log.Printf("received signal %v, shutting down...", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("shutdown error: %v", err)
		}
	}()

	log.Printf("Emby proxy listening on 0.0.0.0:%s", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
	log.Println("Emby proxy stopped")
}
