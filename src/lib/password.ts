/**
 * Password hashing.
 *
 * v2 uses scrypt (memory-hard, built into Node, no native dependency).
 * v1 hashes are bcrypt; they still verify, and `needsRehash` tells the caller
 * to replace them with a scrypt hash after a successful login.
 *
 * Format: scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
 */
import crypto from "crypto";
import bcrypt from "bcryptjs";

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;

export const MIN_PASSWORD_LENGTH = 12;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 256 * n * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  if (stored.startsWith("scrypt$")) {
    const parts = stored.split("$");
    if (parts.length !== 6) return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, "base64");
    const key = await scrypt(password, Buffer.from(saltB64, "base64"), Number(n), Number(r), Number(p));
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  }
  if (stored.startsWith("$2")) {
    return bcrypt.compare(password, stored);
  }
  return false;
}

export function needsRehash(stored: string): boolean {
  return !stored.startsWith(["scrypt", N, R, P, ""].join("$"));
}

export function validatePasswordStrength(password: unknown): string | null {
  if (typeof password !== "string" || !password) return "Password is required";
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > 256) return "Password is too long";
  return null;
}
