import crypto from "crypto";

/** GitHub's X-Hub-Signature-256: "sha256=" + hex HMAC of the raw body. */
export function verifySignature(secret: string, raw: Buffer, header: string | null): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex"));
  const got = Buffer.from(header);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
