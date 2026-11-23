package agent

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Version is set at build time.
var Version = "dev"

var streamIDRe = regexp.MustCompile(`^[a-f0-9]{32}$`)

// Options configure a running agent.
type Options struct {
	DataDir        string
	DockerSocket   string
	MetricsEvery   time.Duration
	Logger         *log.Logger
	DiskPath       string
}

type session struct {
	opts  Options
	state State
	tls   *tls.Config
	wsURL string
}

func load(opts Options) (*session, error) {
	read := func(name string) ([]byte, error) { return os.ReadFile(filepath.Join(opts.DataDir, name)) }
	raw, err := read(stateFile)
	if err != nil {
		return nil, errors.New("this agent is not enrolled yet: run `deploynow-agent join` first")
	}
	var st State
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil, err
	}
	certPEM, err := read(certFile)
	if err != nil {
		return nil, err
	}
	keyPEM, err := read(keyFile)
	if err != nil {
		return nil, err
	}
	caPEM, err := read(caFile)
	if err != nil {
		return nil, err
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("invalid agent certificate: %w", err)
	}
	cfg, err := caConfig(caPEM, pair)
	if err != nil {
		return nil, err
	}
	u, _ := url.Parse(st.URL)
	return &session{opts: opts, state: st, tls: cfg, wsURL: "wss://" + u.Host}, nil
}

func (s *session) dialOpts() *websocket.DialOptions {
	return &websocket.DialOptions{HTTPClient: &http.Client{Transport: &http.Transport{TLSClientConfig: s.tls}, Timeout: 0}}
}

// Run keeps the control connection open, reconnecting with backoff, until ctx ends.
func Run(ctx context.Context, opts Options) error {
	if opts.MetricsEvery == 0 {
		opts.MetricsEvery = 30 * time.Second
	}
	if opts.Logger == nil {
		opts.Logger = log.New(os.Stderr, "", log.LstdFlags)
	}
	s, err := load(opts)
	if err != nil {
		return err
	}
	backoff := time.Second
	for {
		started := time.Now()
		err := s.connectOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		wait := backoff
		var refused *refusedError
		if errors.As(err, &refused) {
			wait = time.Minute
		}
		opts.Logger.Printf("disconnected from DeployNow: %v; retrying in %s", err, wait)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

type refusedError struct{ status int }

func (e *refusedError) Error() string {
	return fmt.Sprintf("DeployNow refused this agent (HTTP %d): it may have been revoked", e.status)
}

type message struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
}

func (s *session) connectOnce(ctx context.Context) error {
	dctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	conn, res, err := websocket.Dial(dctx, s.wsURL+"/connect", s.dialOpts())
	cancel()
	if err != nil {
		if res != nil && (res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden) {
			return &refusedError{status: res.StatusCode}
		}
		return err
	}
	conn.SetReadLimit(1 << 20)
	defer conn.CloseNow()
	s.opts.Logger.Printf("connected to DeployNow at %s", s.state.URL)

	cctx, stop := context.WithCancel(ctx)
	defer stop()
	var writeMu sync.Mutex
	send := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		b, _ := json.Marshal(v)
		wctx, c := context.WithTimeout(cctx, 10*time.Second)
		defer c()
		return conn.Write(wctx, websocket.MessageText, b)
	}

	hostname, _ := os.Hostname()
	if err := send(map[string]any{"type": "hello", "version": Version, "hostname": hostname, "os": runtime.GOOS, "arch": runtime.GOARCH}); err != nil {
		return err
	}

	go func() {
		t := time.NewTicker(s.opts.MetricsEvery)
		defer t.Stop()
		p := time.NewTicker(20 * time.Second)
		defer p.Stop()
		_ = send(map[string]any{"type": "metrics", "metrics": CollectMetrics(s.opts.DiskPath)})
		for {
			select {
			case <-cctx.Done():
				return
			case <-t.C:
				if err := send(map[string]any{"type": "metrics", "metrics": CollectMetrics(s.opts.DiskPath)}); err != nil {
					stop()
					return
				}
			case <-p.C:
				pctx, c := context.WithTimeout(cctx, 15*time.Second)
				err := conn.Ping(pctx)
				c()
				if err != nil {
					conn.CloseNow()
					stop()
					return
				}
			}
		}
	}()

	for {
		typ, data, err := conn.Read(cctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			continue
		}
		var m message
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.Type {
		case "open":
			if streamIDRe.MatchString(m.ID) {
				go s.serveStream(ctx, m.ID)
			}
		}
	}
}

// serveStream dials back to the hub for one Docker connection and pipes it
// to the local Docker socket.
func (s *session) serveStream(ctx context.Context, id string) {
	docker, err := net.DialTimeout("unix", s.opts.DockerSocket, 10*time.Second)
	if err != nil {
		s.opts.Logger.Printf("can't reach Docker at %s: %v", s.opts.DockerSocket, err)
		return
	}
	defer docker.Close()
	dctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	ws, _, err := websocket.Dial(dctx, s.wsURL+"/stream?id="+id, s.dialOpts())
	cancel()
	if err != nil {
		s.opts.Logger.Printf("stream %s: %v", id[:8], err)
		return
	}
	ws.SetReadLimit(-1)
	remote := websocket.NetConn(ctx, ws, websocket.MessageBinary)
	defer remote.Close()
	pipe(remote, docker)
}

func pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if c, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		} else {
			_ = dst.Close()
		}
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	<-done
}

// MaskToken shortens a token for log lines.
func MaskToken(t string) string {
	if len(t) <= 6 {
		return "***"
	}
	return t[:3] + strings.Repeat("*", 6)
}
