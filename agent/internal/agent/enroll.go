package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// State is what the agent keeps in its data directory besides key and certificates.
type State struct {
	URL        string `json:"url"`
	EndpointID string `json:"endpointId"`
}

const (
	keyFile   = "agent.key"
	certFile  = "agent.crt"
	caFile    = "ca.crt"
	stateFile = "state.json"
)

// Enrolled reports whether the data directory holds a certificate.
func Enrolled(dataDir string) bool {
	for _, f := range []string{keyFile, certFile, caFile, stateFile} {
		if _, err := os.Stat(filepath.Join(dataDir, f)); err != nil {
			return false
		}
	}
	return true
}

// NormalizeURL turns "host:8444" or "https://host:8444/" into "https://host:8444".
func NormalizeURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("invalid DeployNow URL %q", raw)
	}
	if u.Scheme != "https" {
		return "", errors.New("the DeployNow agent URL must use https")
	}
	return "https://" + u.Host, nil
}

// Join enrols this agent: it creates a key, sends a certificate request with the
// one-time join token, and stores the signed certificate and the hub's CA.
func Join(ctx context.Context, dataDir, rawURL, token, caFingerprint string) error {
	base, err := NormalizeURL(rawURL)
	if err != nil {
		return err
	}
	if strings.TrimSpace(token) == "" || strings.TrimSpace(caFingerprint) == "" {
		return errors.New("a join token and the CA fingerprint are required")
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return err
	}
	hostname, _ := os.Hostname()
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "deploynow-agent", Organization: []string{hostname}}}, key)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{
		"token":    strings.TrimSpace(token),
		"csr":      string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER})),
		"hostname": hostname,
	})
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{TLSClientConfig: pinnedCAConfig(caFingerprint)}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/enroll", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("can't reach DeployNow at %s: %w", base, err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var out struct {
		Cert       string `json:"cert"`
		CA         string `json:"ca"`
		EndpointID string `json:"endpointId"`
		Error      string `json:"error"`
	}
	_ = json.Unmarshal(data, &out)
	if res.StatusCode != http.StatusOK {
		if out.Error == "" {
			out.Error = res.Status
		}
		return fmt.Errorf("enrolment refused: %s", out.Error)
	}
	caBlock, _ := pem.Decode([]byte(out.CA))
	if caBlock == nil || Fingerprint(caBlock.Bytes) != NormalizeFingerprint(caFingerprint) {
		return errors.New("the CA returned by DeployNow does not match the pinned fingerprint")
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	state, _ := json.Marshal(State{URL: base, EndpointID: out.EndpointID})
	for name, content := range map[string][]byte{keyFile: keyPEM, certFile: []byte(out.Cert), caFile: []byte(out.CA), stateFile: state} {
		if err := os.WriteFile(filepath.Join(dataDir, name), content, 0o600); err != nil {
			return err
		}
	}
	return nil
}
