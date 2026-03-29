import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { isAdmin, getSessionUserId } from "@/lib/sessionHelpers";

const VALID_ROLES = ["admin", "member"] as const;
type Role = (typeof VALID_ROLES)[number];

function isValidRole(role: unknown): role is Role {
  return VALID_ROLES.includes(role as Role);
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const invites = await prisma.teamInvite.findMany({
    where: { used: false, expiresAt: { gt: new Date() } },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ users, invites });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session)) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = await request.json();

  // ── Invite ──────────────────────────────────────────────────────────────────
  if (body.action === "invite") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = body.role;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }
    if (!isValidRole(role)) {
      return NextResponse.json({ error: "Role must be 'admin' or 'member'" }, { status: 400 });
    }

    const token = crypto.randomBytes(32).toString("hex");
    await prisma.teamInvite.create({
      data: {
        email,
        token,
        role,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdBy: getSessionUserId(session),
      },
    });

    // Return only the token scalar — not the full Prisma row
    return NextResponse.json({ token });
  }

  // ── Remove member ───────────────────────────────────────────────────────────
  if (body.action === "remove") {
    const userId = typeof body.userId === "string" ? body.userId : "";
    if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

    // Prevent removing the last admin
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

    if (target.role === "admin") {
      const adminCount = await prisma.user.count({ where: { role: "admin" } });
      if (adminCount <= 1) {
        return NextResponse.json(
          { error: "Cannot remove the last admin" },
          { status: 400 }
        );
      }
    }

    await prisma.user.delete({ where: { id: userId } });
    return NextResponse.json({ success: true });
  }

  // ── Update role ─────────────────────────────────────────────────────────────
  if (body.action === "updateRole") {
    const userId = typeof body.userId === "string" ? body.userId : "";
    const newRole = body.role;

    if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
    if (!isValidRole(newRole)) {
      return NextResponse.json({ error: "Role must be 'admin' or 'member'" }, { status: 400 });
    }

    // Prevent self-demotion
    if (userId === getSessionUserId(session)) {
      return NextResponse.json({ error: "You cannot change your own role" }, { status: 400 });
    }

    // Prevent demoting the last admin
    if (newRole === "member") {
      const target = await prisma.user.findUnique({ where: { id: userId } });
      if (target?.role === "admin") {
        const adminCount = await prisma.user.count({ where: { role: "admin" } });
        if (adminCount <= 1) {
          return NextResponse.json(
            { error: "Cannot demote the last admin" },
            { status: 400 }
          );
        }
      }
    }

    await prisma.user.update({ where: { id: userId }, data: { role: newRole } });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

// ── Register via invite token (public — no session required) ──────────────────
export async function PUT(request: Request) {
  const body = await request.json();

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const name  = typeof body.name  === "string" ? body.name.trim()  : "";
  const password = typeof body.password === "string" ? body.password : "";

  // Validate token format before hitting the DB
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return NextResponse.json({ error: "Invalid invite token" }, { status: 400 });
  }
  if (!name || name.length < 2 || name.length > 100) {
    return NextResponse.json({ error: "Name must be 2–100 characters" }, { status: 400 });
  }
  // Enforce password complexity server-side
  if (password.length < 12) {
    return NextResponse.json(
      { error: "Password must be at least 12 characters" },
      { status: 400 }
    );
  }

  const invite = await prisma.teamInvite.findUnique({ where: { token } });

  if (!invite || invite.used || invite.expiresAt < new Date()) {
    return NextResponse.json({ error: "Invalid or expired invite" }, { status: 400 });
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  await prisma.user.create({
    data: {
      email: invite.email,
      name,
      password: hashedPassword,
      role: invite.role,
    },
  });

  await prisma.teamInvite.update({ where: { id: invite.id }, data: { used: true } });

  return NextResponse.json({ success: true });
}
