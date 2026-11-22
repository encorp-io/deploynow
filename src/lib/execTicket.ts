/**
 * Short-lived, single-use tickets that let the browser open a console
 * WebSocket. The authenticated API route checks permissions and issues the
 * ticket; the WebSocket server verifies the signature, expiry and nonce.
 */
import crypto from "crypto";

export const EXEC_TICKET_TTL_MS = 30_000;
export const ALLOWED_SHELLS = ["/bin/sh", "/bin/bash", "/bin/ash"] as const;

export interface ExecTicket {
  uid: string;
  email: string;
  sid: string;
  endpointId: string;
  containerId: string;
  shell: string;
  exp: number;
  nonce: string;
}

function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return crypto.createHash("sha256").update(`deploynow-exec-ticket-v1:${secret}`).digest();
}

function sign(data: string): string {
  return crypto.createHmac("sha256", key()).update(data).digest("base64url");
}

export function issueExecTicket(input: Omit<ExecTicket, "exp" | "nonce">, now = Date.now()): string {
  const payload: ExecTicket = { ...input, exp: now + EXEC_TICKET_TTL_MS, nonce: crypto.randomBytes(12).toString("hex") };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(data)}`;
}

const usedNonces = new Map<string, number>();

/** Returns the ticket if valid, unexpired and not used before; consumes it. */
export function redeemExecTicket(ticket: string, now = Date.now()): ExecTicket | null {
  const [data, sig] = (ticket || "").split(".");
  if (!data || !sig) return null;
  const expected = Buffer.from(sign(data));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

  let payload: ExecTicket;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (!payload.nonce || usedNonces.has(payload.nonce)) return null;

  usedNonces.set(payload.nonce, payload.exp);
  for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n);
  return payload;
}
