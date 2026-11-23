/**
 * The agent hub's private CA.
 *
 * DeployNow creates a CA on first use and keeps it in Settings (key encrypted).
 * It signs:
 *  - the hub's own server certificate, which agents verify against the CA
 *    whose fingerprint they were given in the join command;
 *  - one client certificate per agent (CN = endpoint id), from the agent's CSR.
 * Revoking an agent clears its certificate serial, so the hub refuses it.
 */
import crypto from "crypto";
import forge from "node-forge";
import { prisma } from "../prisma";
import { decryptSecret, encryptSecret } from "../secretsCrypto";

export interface HubPki {
  caCert: string;
  caKey: string;
  serverCert: string;
  serverKey: string;
}

const YEAR = 365 * 24 * 3600 * 1000;

function rsaKeyPair(): { publicKey: forge.pki.rsa.PublicKey; privateKey: forge.pki.rsa.PrivateKey; privatePem: string } {
  // Node generates the key (fast, native); forge only builds certificates
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const priv = forge.pki.privateKeyFromPem(privatePem) as forge.pki.rsa.PrivateKey;
  const pub = forge.pki.setRsaPublicKey(priv.n, priv.e);
  return { publicKey: pub, privateKey: priv, privatePem };
}

function serial(): string {
  // Positive 128-bit serial in hex
  const b = crypto.randomBytes(16);
  b[0] &= 0x7f;
  return b.toString("hex");
}

export function createCa(): { cert: string; key: string } {
  const keys = rsaKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 20 * YEAR);
  const attrs = [{ name: "commonName", value: "DeployNow agent CA" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: keys.privatePem };
}

function issue(
  caCertPem: string,
  caKeyPem: string,
  publicKey: forge.pki.PublicKey,
  commonName: string,
  usage: "server" | "client",
  years: number,
): { cert: string; serial: string } {
  const ca = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + years * YEAR);
  cert.setSubject([{ name: "commonName", value: commonName }]);
  cert.setIssuer(ca.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: usage === "server", clientAuth: usage === "client" },
    ...(usage === "server" ? [{ name: "subjectAltName", altNames: [{ type: 2, value: "deploynow-hub" }] }] : []),
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), serial: cert.serialNumber };
}

export function createServerCert(caCert: string, caKey: string): { cert: string; key: string } {
  const keys = rsaKeyPair();
  const { cert } = issue(caCert, caKey, keys.publicKey, "deploynow-hub", "server", 10);
  return { cert, key: keys.privatePem };
}

export class CsrError extends Error {}

/** Sign an agent's certificate request. The CN is set to the endpoint id, whatever the CSR asked for. */
export function signAgentCsr(caCert: string, caKey: string, csrPem: string, endpointId: string): { cert: string; serial: string } {
  let csr: forge.pki.CertificateSigningRequest;
  try {
    csr = forge.pki.certificationRequestFromPem(csrPem);
  } catch {
    throw new CsrError("Invalid certificate request (an RSA key is required)");
  }
  if (!csr.verify()) throw new CsrError("The certificate request's signature is invalid");
  const pub = csr.publicKey as forge.pki.rsa.PublicKey | null;
  if (!pub || pub.n.bitLength() < 2048) throw new CsrError("The agent key must be RSA, 2048 bits or more");
  return issue(caCert, caKey, pub, endpointId, "client", 5);
}

/** "sha256:<hex>" of a PEM certificate's DER bytes. */
export function certFingerprint(pem: string): string {
  return "sha256:" + new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();
}

let cached: HubPki | null = null;

/** Load the hub PKI, creating the CA and server certificate the first time. */
export async function ensureHubPki(): Promise<HubPki> {
  if (cached) return cached;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (s?.agentCaCert && s.agentCaKey && s.agentServerCert && s.agentServerKey) {
    const caKey = decryptSecret(s.agentCaKey);
    const serverKey = decryptSecret(s.agentServerKey);
    if (caKey && serverKey) {
      cached = { caCert: s.agentCaCert, caKey, serverCert: s.agentServerCert, serverKey };
      return cached;
    }
    throw new Error("The agent CA key can't be decrypted: was AUTH_SECRET changed? Agents must be enrolled again after resetting the CA.");
  }
  const ca = createCa();
  const server = createServerCert(ca.cert, ca.key);
  const data = { agentCaCert: ca.cert, agentCaKey: encryptSecret(ca.key), agentServerCert: server.cert, agentServerKey: encryptSecret(server.key) };
  await prisma.settings.upsert({ where: { id: "singleton" }, update: data, create: { id: "singleton", ...data } });
  cached = { caCert: ca.cert, caKey: ca.key, serverCert: server.cert, serverKey: server.key };
  return cached;
}

/** For tests. */
export function resetPkiCache() {
  cached = null;
}
