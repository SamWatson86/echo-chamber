package main

import (
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"

	"github.com/pion/turn/v2"
)

func envString(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if value := os.Getenv(key); value != "" {
		parsed, err := strconv.Atoi(value)
		if err == nil {
			return parsed
		}
	}
	return fallback
}

func main() {
	if logPath := os.Getenv("TURN_LOG_FILE"); logPath != "" {
		if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
			log.Fatalf("failed to create log dir: %v", err)
		}
		file, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			log.Fatalf("failed to open log file: %v", err)
		}
		log.SetOutput(io.MultiWriter(os.Stdout, file))
	}

	publicIP := envString("TURN_PUBLIC_IP", "")
	if publicIP == "" {
		log.Fatal("TURN_PUBLIC_IP is required")
	}

	realm := envString("TURN_REALM", "echo-chamber")
	user := envString("TURN_USER", "echo")
	pass := envString("TURN_PASS", "")
	if pass == "" {
		log.Fatal("TURN_PASS is required")
	}

	listenAddr := envString("TURN_LISTEN_ADDR", "0.0.0.0")
	port := envInt("TURN_PORT", 3478)
	minPort := envInt("TURN_MIN_PORT", 49152)
	maxPort := envInt("TURN_MAX_PORT", 49200)

	relayIP := net.ParseIP(publicIP)
	if relayIP == nil {
		log.Fatalf("invalid TURN_PUBLIC_IP: %s", publicIP)
	}

	authHandler := func(username, realm string, _ net.Addr) ([]byte, bool) {
		if username != user {
			return nil, false
		}
		return turn.GenerateAuthKey(username, realm, pass), true
	}

	udpListener, err := net.ListenPacket("udp4", fmt.Sprintf("%s:%d", listenAddr, port))
	if err != nil {
		log.Fatalf("failed to start UDP listener: %v", err)
	}

	relayGen := &turn.RelayAddressGeneratorPortRange{
		RelayAddress: relayIP,
		Address:      listenAddr,
		MinPort:      uint16(minPort),
		MaxPort:      uint16(maxPort),
	}

	_, err = turn.NewServer(turn.ServerConfig{
		Realm:       realm,
		AuthHandler: authHandler,
		PacketConnConfigs: []turn.PacketConnConfig{
			{
				PacketConn:           udpListener,
				RelayAddressGenerator: relayGen,
			},
		},
		ListenerConfigs: nil,
	})
	if err != nil {
		log.Fatalf("failed to start TURN server: %v", err)
	}

	log.Printf("TURN server ready on UDP %s:%d (realm=%s, user=%s, relay=%s, relay-ports=%d-%d)", listenAddr, port, realm, user, publicIP, minPort, maxPort)
	select {}
}
