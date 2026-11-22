import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";

const DEFAULT_PATTERNS = [
  // connection failures
  "connection timeout",
  "connection refused",
  "connection reset",
  "connection timed out",
  "unable to connect",
  // pool / resource exhaustion
  "pool exhausted",
  "too many connections",
  // memory
  "out of memory",
  "heap out of memory",
  "oom killer",
  "killed process",
  "memory limit exceeded",
  // process crashes
  "fatal error",
  "panic:",
  "segfault",
  "segmentation fault",
  "core dumped",
  "unhandled exception",
  // concurrency / data
  "deadlock detected",
  // health / i/o
  "health check failed",
  "no space left",
  "i/o error",
  "read-only file system",
].join("\n");

export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const config = await prisma.healthMonitor.findUnique({ where: { id: "singleton" } });

  return NextResponse.json({
    enabled:     config?.enabled     ?? false,
    prefixes:    config?.prefixes    ?? "",
    logWindow:   config?.logWindow   ?? 300,
    cooldown:    config?.cooldown    ?? 10,
    logPatterns: config?.logPatterns ?? DEFAULT_PATTERNS,
  });
}

export async function PUT(request: Request) {
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};

  if (body.enabled !== undefined) {
    data.enabled = Boolean(body.enabled);
  }

  if (typeof body.prefixes === "string") {
    data.prefixes = body.prefixes.trim().slice(0, 2000);
  }

  if (typeof body.logPatterns === "string") {
    const patterns = body.logPatterns
      .split("\n")
      .map((p: string) => p.trim())
      .filter(Boolean);
    if (patterns.length === 0) {
      return NextResponse.json(
        { error: "logPatterns must contain at least one non-empty pattern" },
        { status: 400 }
      );
    }
    data.logPatterns = body.logPatterns.trim().slice(0, 5000);
  }

  if (body.logWindow !== undefined) {
    const val = Number(body.logWindow);
    if (!Number.isInteger(val) || val < 60 || val > 900) {
      return NextResponse.json(
        { error: "logWindow must be an integer between 60 and 900" },
        { status: 400 }
      );
    }
    data.logWindow = val;
  }

  if (body.cooldown !== undefined) {
    const val = Number(body.cooldown);
    if (!Number.isInteger(val) || val < 1 || val > 60) {
      return NextResponse.json(
        { error: "cooldown must be an integer between 1 and 60" },
        { status: 400 }
      );
    }
    data.cooldown = val;
  }

  try {
    await prisma.healthMonitor.upsert({
      where:  { id: "singleton" },
      update: data,
      create: {
        id:          "singleton",
        enabled:     (data.enabled     as boolean) ?? false,
        prefixes:    (data.prefixes    as string)  ?? "",
        logWindow:   (data.logWindow   as number)  ?? 300,
        cooldown:    (data.cooldown    as number)  ?? 10,
        logPatterns: (data.logPatterns as string)  ?? DEFAULT_PATTERNS,
      },
    });
  } catch (err) {
    console.error("[health-monitor] Save failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }

  await audit({
    actor: { id: gate.user.id, email: gate.user.email },
    ip: clientIp(request),
    action: "settings.health_monitor",
    message: `${gate.user.email} changed health monitor settings: ${Object.keys(data).join(", ") || "nothing"}`,
  });
  return NextResponse.json({ success: true });
}
