import crypto from "crypto";

const CODE_COUNT = 10;
// No 0/O/1/I/L: easy to read off paper
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomChunk(len: number): string {
  let out = "";
  while (out.length < len) {
    const b = crypto.randomBytes(1)[0];
    // Rejection sampling keeps the distribution uniform
    if (b < 256 - (256 % ALPHABET.length)) out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

export function normaliseRecoveryCode(code: string): string {
  return (code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(normaliseRecoveryCode(code)).digest("hex");
}

export function looksLikeRecoveryCode(code: string): boolean {
  return normaliseRecoveryCode(code).length === 10;
}

/** Returns the plain codes (show once) and their hashes (store). */
export function generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: CODE_COUNT }, () => `${randomChunk(5)}-${randomChunk(5)}`);
  return { codes, hashes: codes.map(hashRecoveryCode) };
}
