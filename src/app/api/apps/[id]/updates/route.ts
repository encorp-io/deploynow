import { NextResponse } from "next/server";
import { appGate } from "@/lib/apps/access";
import { checkAppUpdates, parseUpdateInfo } from "@/lib/apps/updateCheck";

type Params = { params: Promise<{ id: string }> };

/** What the last update check of the app found. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "project.view");
  if (!gate.ok) return gate.response;
  const { app } = gate;
  return NextResponse.json({ ...parseUpdateInfo(app.updateInfo), error: app.updateError, checkedAt: app.updateCheckedAt });
}

/** Check now: looks for a new image, commit or newer tag right away. Deploys nothing. */
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "project.view");
  if (!gate.ok) return gate.response;
  const result = await checkAppUpdates(id);
  return NextResponse.json({ ...result.info, summary: result.summary, error: result.error ?? "", checkedAt: new Date() });
}
