package agent

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
)

// Fingerprint is "sha256:<hex>" of a certificate's DER bytes.
func Fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// NormalizeFingerprint accepts "sha256:AB:CD..." or plain hex and returns "sha256:abcd...".
func NormalizeFingerprint(fp string) string {
	fp = strings.TrimSpace(strings.ToLower(fp))
	fp = strings.TrimPrefix(fp, "sha256:")
	fp = strings.ReplaceAll(fp, ":", "")
	return "sha256:" + fp
}

// pinnedCAConfig trusts only a server whose chain includes the CA with this
// fingerprint. The hub is reached by IP or any name, so hostnames aren't checked:
// the pinned CA is the identity.
func pinnedCAConfig(caFingerprint string) *tls.Config {
	want := NormalizeFingerprint(caFingerprint)
	return &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, // replaced by VerifyPeerCertificate below
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return errors.New("server sent no certificate")
			}
			var ca *x509.Certificate
			for _, der := range raw {
				if Fingerprint(der) == want {
					c, err := x509.ParseCertificate(der)
					if err != nil {
						return err
					}
					ca = c
				}
			}
			if ca == nil {
				return fmt.Errorf("the server's CA does not match the pinned fingerprint %s", want)
			}
			return verifyLeaf(raw[0], ca)
		},
	}
}

// caConfig trusts the stored CA (after enrolment) and presents the agent's certificate.
func caConfig(caPEM []byte, cert tls.Certificate) (*tls.Config, error) {
	block, _ := pem.Decode(caPEM)
	if block == nil {
		return nil, errors.New("invalid CA certificate")
	}
	ca, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion:         tls.VersionTLS12,
		Certificates:       []tls.Certificate{cert},
		InsecureSkipVerify: true, // replaced by VerifyPeerCertificate below
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return errors.New("server sent no certificate")
			}
			return verifyLeaf(raw[0], ca)
		},
	}, nil
}

func verifyLeaf(leafDER []byte, ca *x509.Certificate) error {
	leaf, err := x509.ParseCertificate(leafDER)
	if err != nil {
		return err
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	_, err = leaf.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
	if err != nil {
		return fmt.Errorf("server certificate not signed by the DeployNow CA: %w", err)
	}
	return nil
}
