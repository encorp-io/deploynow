// deploynow-agent connects a Docker host to DeployNow over an outbound,
// mutually authenticated TLS connection, so the host needs no open port.
//
//	deploynow-agent join --url https://deploynow.example.com:8444 --token <token> --ca sha256:<fingerprint>
//	deploynow-agent run
//
// Or set DEPLOYNOW_URL, DEPLOYNOW_TOKEN and DEPLOYNOW_CA and just run it: the
// agent enrols on first start and keeps its certificate in DEPLOYNOW_DATA (/data).
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/encorp-io/deploynow/agent/internal/agent"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	logger := log.New(os.Stderr, "deploynow-agent ", log.LstdFlags)
	dataDir := env("DEPLOYNOW_DATA", "/data")
	socket := env("DOCKER_SOCKET", "/var/run/docker.sock")
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cmd := "run"
	args := os.Args[1:]
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		cmd, args = args[0], args[1:]
	}

	switch cmd {
	case "version":
		fmt.Println(agent.Version)
	case "join":
		fs := flag.NewFlagSet("join", flag.ExitOnError)
		url := fs.String("url", env("DEPLOYNOW_URL", ""), "DeployNow agent address, e.g. https://deploynow.example.com:8444")
		token := fs.String("token", env("DEPLOYNOW_TOKEN", ""), "one-time join token from DeployNow")
		ca := fs.String("ca", env("DEPLOYNOW_CA", ""), "CA fingerprint shown by DeployNow (sha256:...)")
		_ = fs.Parse(args)
		if err := agent.Join(ctx, dataDir, *url, *token, *ca); err != nil {
			logger.Fatal(err)
		}
		logger.Printf("enrolled with %s", *url)
	case "run":
		if !agent.Enrolled(dataDir) {
			url, token, ca := os.Getenv("DEPLOYNOW_URL"), os.Getenv("DEPLOYNOW_TOKEN"), os.Getenv("DEPLOYNOW_CA")
			if url == "" || token == "" || ca == "" {
				logger.Fatal("not enrolled: set DEPLOYNOW_URL, DEPLOYNOW_TOKEN and DEPLOYNOW_CA, or run `deploynow-agent join`")
			}
			logger.Printf("enrolling with %s (token %s)", url, agent.MaskToken(token))
			if err := agent.Join(ctx, dataDir, url, token, ca); err != nil {
				logger.Fatal(err)
			}
		}
		if err := agent.Run(ctx, agent.Options{DataDir: dataDir, DockerSocket: socket, Logger: logger, DiskPath: os.Getenv("DEPLOYNOW_DISK_PATH")}); err != nil {
			logger.Fatal(err)
		}
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q; use join, run or version\n", cmd)
		os.Exit(2)
	}
}
