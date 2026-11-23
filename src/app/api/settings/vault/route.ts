import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { loadVaultConfig, testVault } from "@/lib/vault";

/** Test the saved Vault settings. */
export async function POST() {
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  const cfg = await loadVaultConfig();
  if (!cfg) return NextResponse.json({ error: "Save Vault's address first" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, message: await testVault(cfg) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
