import { NextResponse } from "next/server";
import { readJson, requireUser } from "@/lib/apiAuth";
import { encryptSecret } from "@/lib/secretsCrypto";
import { validateDestination } from "@/lib/backup/config";
import { testDestination } from "@/lib/backup/service";
import { backupError } from "@/lib/backup/http";
import type { BackupDestination } from "@prisma/client";

/** Test credentials before saving them. */
export async function POST(request: Request) {
  const gate = await requireUser("backup.manage");
  if (!gate.ok) return gate.response;
  try {
    const v = validateDestination(await readJson(request));
    const d = { ...v, id: "", secretKey: encryptSecret(v.secret ?? ""), pruneSecretKey: "", createdAt: new Date(), updatedAt: new Date() } as unknown as BackupDestination;
    return NextResponse.json(await testDestination(d));
  } catch (err) {
    return backupError(err);
  }
}
