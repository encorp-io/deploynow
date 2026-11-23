import { NextResponse } from "next/server";
import { BackupConfigError } from "./config";

/** Validation errors become 400s; anything else a 500 with the message. */
export function backupError(err: unknown): NextResponse {
  if (err instanceof BackupConfigError) return NextResponse.json({ error: err.message }, { status: 400 });
  const msg = err instanceof Error ? err.message : "Something went wrong";
  if (/Record to (update|delete) not found|No .* found/.test(msg)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  console.error("[backup api]", msg);
  return NextResponse.json({ error: msg.slice(0, 500) }, { status: 500 });
}

export const ID_RE = /^c[a-z0-9]{20,30}$/;
