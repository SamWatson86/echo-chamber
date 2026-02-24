package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/pion/turn/v4"
)

func main() {
	// Configuration — set via environment variables
	publicIP := envOrDefault("TURN_PUBLIC_IP", "")
	if publicIP == "" {
		log.Fatal("TURN_PUBLIC_IP is required (set env var)")
	}
	listenPort := envOrDefaultInt("TURN_PORT", 3478)
	relayMinPort := envOrDefaultInt("TURN_RELAY_MIN", 40000)
	relayMaxPort := envOrDefaultInt("TURN_RELAY_MAX", 40099)
	realm := envOrDefault("TURN_REALM", "echo-chamber")
	username := envOrDefault("TURN_USER", "")
	if username == "" {
		log.Fatal("TURN_USER is required (set env var)")
	}
	password := envOrDefault("TURN_PASS", "")
	if password == "" {
		log.Fatal("TURN_PASS is required (set env var)")
	}

	listenAddr := fmt.Sprintf("0.0.0.0:%d", listenPort)

	// Create UDP listener
	udpListener, err := net.ListenPacket("udp4", listenAddr)
	if err != nil {
		log.Fatalf("Failed to listen on %s: %v", listenAddr, err)
	}

	// Pre-generate the auth key for our single user
	authKey := turn.GenerateAuthKey(username, realm, password)

	log.Printf("Echo Chamber TURN Server")
	log.Printf("  Listen:    %s (UDP)", listenAddr)
	log.Printf("  Public IP: %s", publicIP)
	log.Printf("  Relay:     %d-%d", relayMinPort, relayMaxPort)
	log.Printf("  Realm:     %s", realm)
	log.Printf("  User:      %s", username)

	s, err := turn.NewServer(turn.ServerConfig{
		Realm: realm,
		AuthHandler: func(u string, r string, srcAddr net.Addr) ([]byte, bool) {
			if u == username {
				return authKey, true
			}
			log.Printf("Auth rejected: user=%q from=%v", u, srcAddr)
			return nil, false
		},
		PacketConnConfigs: []turn.PacketConnConfig{
			{
				PacketConn: udpListener,
				RelayAddressGenerator: &turn.RelayAddressGeneratorPortRange{
					RelayAddress: net.ParseIP(publicIP),
					Address:      "0.0.0.0",
					MinPort:      uint16(relayMinPort),
					MaxPort:      uint16(relayMaxPort),
				},
			},
		},
	})
	if err != nil {
		log.Fatalf("Failed to create TURN server: %v", err)
	}

	log.Printf("TURN server running. Press Ctrl+C to stop.")

	// Wait for shutdown signal
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	<-sigs

	log.Printf("Shutting down TURN server...")
	if err := s.Close(); err != nil {
		log.Printf("Error closing server: %v", err)
	}
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); strings.TrimSpace(v) != "" {
		return v
	}
	return def
}

func envOrDefaultInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
