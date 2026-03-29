/**
 * AES-256-GCM encryption for secrets stored in the database (portainerApiKey, githubToken).
 * The encryption key is derived from AUTH_SECRET via PBKDF2 — never stored separately.
 *
 * Format of ciphertext: base64( iv[16] || authTag[16] || encrypted )
 */

import crypto from "crypto";

const SALT = "encorp-deployer-secrets-v1";
const ITERATIONS = 100_000;

function deriveKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return crypto.pbkdf2Sync(secret, SALT, ITERATIONS, 32, "sha256");
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return "";
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(ciphertext: string): string {
  if (!ciphertext) return "";
  try {
    const key = deriveKey();
    const buf = Buffer.from(ciphertext, "base64");
    const iv = buf.subarray(0, 16);
    const authTag = buf.subarray(16, 32);
    const encrypted = buf.subarray(32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
  } catch {
    // Key rotation or corruption — return empty so caller can re-prompt
    return "";
  }
}

/** Returns true if the value looks like an AES-GCM ciphertext (base64, correct length) */
export function isEncrypted(value: string): boolean {
  if (!value) return false;
  try {
    const buf = Buffer.from(value, "base64");
    return buf.length > 32; // iv(16) + authTag(16) + at least 1 byte
  } catch {
    return false;
  }
}
