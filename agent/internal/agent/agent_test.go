package agent

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func makeCA(t *testing.T) (*x509.Certificate, []byte, *ecdsa.PrivateKey) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test CA"},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return c, der, key
}

func makeLeaf(t *testing.T, ca *x509.Certificate, caKey *ecdsa.PrivateKey, usage x509.ExtKeyUsage) []byte {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "deploynow-hub"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		ExtKeyUsage:  []x509.ExtKeyUsage{usage},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func TestNormalizeFingerprint(t *testing.T) {
	if got := NormalizeFingerprint(" SHA256:AB:cd:01 "); got != "sha256:abcd01" {
		t.Fatalf("got %q", got)
	}
	if got := NormalizeFingerprint("abcd"); got != "sha256:abcd" {
		t.Fatalf("got %q", got)
	}
}

func TestNormalizeURL(t *testing.T) {
	cases := map[string]string{"host:8444": "https://host:8444", "https://h.example:1/path/": "https://h.example:1"}
	for in, want := range cases {
		got, err := NormalizeURL(in)
		if err != nil || got != want {
			t.Fatalf("%s: got %q %v", in, got, err)
		}
	}
	if _, err := NormalizeURL("http://host"); err == nil {
		t.Fatal("http must be refused")
	}
}

func TestPinnedCA(t *testing.T) {
	ca, caDER, caKey := makeCA(t)
	leaf := makeLeaf(t, ca, caKey, x509.ExtKeyUsageServerAuth)
	cfg := pinnedCAConfig(Fingerprint(caDER))
	if err := cfg.VerifyPeerCertificate([][]byte{leaf, caDER}, nil); err != nil {
		t.Fatalf("valid chain refused: %v", err)
	}
	// Another CA with the same shape is refused
	_, otherDER, _ := makeCA(t)
	if err := pinnedCAConfig(Fingerprint(otherDER)).VerifyPeerCertificate([][]byte{leaf, caDER}, nil); err == nil || !strings.Contains(err.Error(), "pinned fingerprint") {
		t.Fatalf("wrong pin accepted: %v", err)
	}
	// A client-only certificate can't pose as the hub
	client := makeLeaf(t, ca, caKey, x509.ExtKeyUsageClientAuth)
	if err := cfg.VerifyPeerCertificate([][]byte{client, caDER}, nil); err == nil {
		t.Fatal("client certificate accepted as server")
	}
	if err := cfg.VerifyPeerCertificate(nil, nil); err == nil {
		t.Fatal("empty chain accepted")
	}
}

func TestEnrolledAndMask(t *testing.T) {
	dir := t.TempDir()
	if Enrolled(dir) {
		t.Fatal("empty dir is not enrolled")
	}
	for _, f := range []string{keyFile, certFile, caFile, stateFile} {
		_ = os.WriteFile(filepath.Join(dir, f), []byte("x"), 0o600)
	}
	if !Enrolled(dir) {
		t.Fatal("expected enrolled")
	}
	if MaskToken("dnj_abcdef") != "dnj******" || MaskToken("abc") != "***" {
		t.Fatal("mask")
	}
}

func TestCollectMetrics(t *testing.T) {
	m := CollectMetrics(t.TempDir())
	if m.CPUs <= 0 || m.DiskTotal == 0 {
		t.Fatalf("metrics look empty: %+v", m)
	}
}
