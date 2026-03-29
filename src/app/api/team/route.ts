import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import crypto from "crypto";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const invites = await prisma.teamInvite.findMany({
    where: { used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ users, invites });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if ((session.user as { role: string }).role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json();

  if (body.action === "invite") {
    const token = crypto.randomBytes(32).toString("hex");
    const invite = await prisma.teamInvite.create({
      data: {
        email: body.email,
        token,
        role: body.role || "member",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        createdBy: (session.user as { id: string }).id,
      },
    });
    return NextResponse.json({ invite, token });
  }

  if (body.action === "remove") {
    await prisma.user.delete({ where: { id: body.userId } });
    return NextResponse.json({ success: true });
  }

  if (body.action === "updateRole") {
    await prisma.user.update({
      where: { id: body.userId },
      data: { role: body.role },
    });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

// Register via invite token
export async function PUT(request: Request) {
  const body = await request.json();

  if (!body.token || !body.name || !body.password) {
    return NextResponse.json(
      { error: "token, name, and password required" },
      { status: 400 }
    );
  }

  const invite = await prisma.teamInvite.findUnique({
    where: { token: body.token },
  });

  if (!invite || invite.used || invite.expiresAt < new Date()) {
    return NextResponse.json(
      { error: "Invalid or expired invite" },
      { status: 400 }
    );
  }

  const hashedPassword = await bcrypt.hash(body.password, 12);

  await prisma.user.create({
    data: {
      email: invite.email,
      name: body.name,
      password: hashedPassword,
      role: invite.role,
    },
  });

  await prisma.teamInvite.update({
    where: { id: invite.id },
    data: { used: true },
  });

  return NextResponse.json({ success: true });
}
