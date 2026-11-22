import { describe, it, expect } from "vitest";
import crypto from "crypto";
import forge from "node-forge";
import { createCa, createServerCert, signAgentCsr, certFingerprint, CsrError } from "@/lib/agent/pki";

function csr(bits = 2048, cn = "whatever") {
  const keys = forge.pki.rsa.generateKeyPair(bits);
  const req = forge.pki.createCertificationRequest();
  req.publicKey = keys.publicKey;
  req.setSubject([{ name: "commonName", value: cn }]);
  req.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(req);
}

describe("agent PKI", () => {
  const ca = createCa();
  const caX = new crypto.X509Certificate(ca.cert);

  it("creates a CA and a server certificate it signed", () => {
    expect(caX.ca).toBe(true);
    const server = createServerCert(ca.cert, ca.key);
    const sx = new crypto.X509Certificate(server.cert);
    expect(sx.verify(caX.publicKey)).toBe(true);
    expect(sx.subject).toContain("CN=deploynow-hub");
    expect(sx.checkHost("deploynow-hub")).toBe("deploynow-hub");
  });

  it("signs an agent CSR with the endpoint id as CN, whatever it asked for", () => {
    const { cert, serial } = signAgentCsr(ca.cert, ca.key, csr(2048, "evil-admin"), "cendpoint00000000000000001");
    const x = new crypto.X509Certificate(cert);
    expect(x.verify(caX.publicKey)).toBe(true);
    expect(x.subject).toBe("CN=cendpoint00000000000000001");
    expect(x.serialNumber.toLowerCase().replace(/^0+/, "")).toBe(serial.replace(/^0+/, ""));
    expect(x.ca).toBe(false);
  });

  it("refuses bad requests", () => {
    expect(() => signAgentCsr(ca.cert, ca.key, "not a csr", "x")).toThrow(CsrError);
    expect(() => signAgentCsr(ca.cert, ca.key, csr(1024), "x")).toThrow(/2048/);
    const tampered = csr().replace(/A/, "B");
    expect(() => signAgentCsr(ca.cert, ca.key, tampered, "x")).toThrow(CsrError);
  });

  it("fingerprints the DER", () => {
    const fp = certFingerprint(ca.cert);
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fp).toBe("sha256:" + crypto.createHash("sha256").update(caX.raw).digest("hex"));
  });
});
