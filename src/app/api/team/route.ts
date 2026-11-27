import { NextResponse } from "next/server";
import { publicOrigin } from "@/lib/publicOrigin";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { requireUser, requireStepUp, readJson } from "@/lib/apiAuth";
import { BINDABLE_ROLES, can, canAssignRole, isRole, normalizeRole, roleAtLeast, type Role } from "@/lib/rbac";
import { hashPassword, validatePasswordStrength } from "@/lib/password";
import { revokeAllSessions } from "@/lib/sessions";
import { audit, clientIp } from "@/lib/audit";

const ID_RE = /^c[a-z0-9]{24}$/;

export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const me = gate.user;
  // Everyone may see who is on the team and their role. Who still has a live invite,
  // who has 2FA off, when people last signed in and everyone's endpoint grants are
  // for the people who manage users.
  const manager = can(me, "users.manage");

  const [users, invites, endpoints] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        lastLoginAt: true,
        disabledAt: true,
        totpEnabledAt: true,
        roleBindings: { select: { id: true, role: true, scopeType: true, scopeId: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    manager
      ? prisma.teamInvite.findMany({
          where: { used: false, expiresAt: { gt: new Date() } },
          select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
    prisma.endpoint.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const ownEndpointIds = new Set(me.bindings.filter((b) => b.scopeType === "endpoint").map((b) => b.scopeId));
  return NextResponse.json({
    users: users.map(({ totpEnabledAt, lastLoginAt, roleBindings, ...u }) => {
      const role = normalizeRole(u.role);
      if (manager) return { ...u, role, lastLoginAt, roleBindings, totpEnabled: !!totpEnabledAt };
      return { id: u.id, email: u.email, name: u.name, role, createdAt: u.createdAt, disabledAt: u.disabledAt, roleBindings: u.id === me.id ? roleBindings : [] };
    }),
    invites,
    endpoints: manager ? endpoints : endpoints.filter((e) => ownEndpointIds.has(e.id)),
    me: { id: me.id, role: me.role },
  });
}

export async function POST(request: Request) {
  const gate = await requireUser("users.manage");
  if (!gate.ok) return gate.response;
  const { user } = gate;
  const body = await readJson(request);
  const actor = { id: user.id, email: user.email };
  const ip = clientIp(request);

  // ── Invite ────────────────────────────────────────────────────────────────
  if (body.action === "invite") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }
    if (!isRole(body.role) || !canAssignRole(user.role, body.role)) {
      return NextResponse.json({ error: "You can't invite someone with that role" }, { status: 400 });
    }
    if (await prisma.user.findUnique({ where: { email } })) {
      return NextResponse.json({ error: "That person already has an account" }, { status: 409 });
    }
    const token = crypto.randomBytes(32).toString("hex");
    await prisma.teamInvite.create({
      data: { email, token, role: body.role, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000), createdBy: user.id },
    });
    await audit({ actor, ip, action: "user.invite", message: `${user.email} invited ${email} as ${body.role}` });
    return NextResponse.json({ token, link: `${publicOrigin(request)}/setup?token=${token}` });
  }

  // Everything below acts on an existing user
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!ID_RE.test(userId)) return NextResponse.json({ error: "userId required" }, { status: 400 });
  if (userId === user.id) return NextResponse.json({ error: "You can't change your own account here" }, { status: 400 });
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const targetRole = normalizeRole(target.role);
  // Admins manage people below them; only owners manage admins and owners
  if (user.role !== "owner" && roleAtLeast(targetRole, user.role)) {
    return NextResponse.json({ error: "Only an owner can change an admin or owner" }, { status: 403 });
  }
  const ownerCount = () => prisma.user.count({ where: { role: "owner", disabledAt: null } });

  switch (body.action) {
    case "updateRole": {
      if (!isRole(body.role) || !canAssignRole(user.role, body.role)) {
        return NextResponse.json({ error: "You can't assign that role" }, { status: 400 });
      }
      if (targetRole === "owner" && body.role !== "owner" && (await ownerCount()) <= 1) {
        return NextResponse.json({ error: "There must be at least one owner" }, { status: 400 });
      }
      await prisma.user.update({ where: { id: userId }, data: { role: body.role as Role } });
      await audit({ actor, ip, action: "user.role_change", message: `${user.email} changed ${target.email} from ${targetRole} to ${body.role}`, targetType: "user", targetId: userId });
      return NextResponse.json({ success: true });
    }

    case "disable":
    case "enable": {
      const disabling = body.action === "disable";
      if (disabling && targetRole === "owner" && (await ownerCount()) <= 1) {
        return NextResponse.json({ error: "There must be at least one owner" }, { status: 400 });
      }
      await prisma.user.update({ where: { id: userId }, data: { disabledAt: disabling ? new Date() : null } });
      if (disabling) await revokeAllSessions(userId);
      await audit({ actor, ip, action: `user.${body.action}`, message: `${user.email} ${disabling ? "disabled" : "re-enabled"} ${target.email}`, targetType: "user", targetId: userId });
      return NextResponse.json({ success: true });
    }

    case "remove": {
      if (targetRole === "owner" && (await ownerCount()) <= 1) {
        return NextResponse.json({ error: "There must be at least one owner" }, { status: 400 });
      }
      await prisma.$transaction([
        prisma.teamInvite.deleteMany({ where: { createdBy: userId } }),
        prisma.user.delete({ where: { id: userId } }),
      ]);
      await audit({ actor, ip, action: "user.remove", message: `${user.email} removed ${target.email}`, targetType: "user", targetId: userId });
      return NextResponse.json({ success: true });
    }

    case "reset2fa": {
      const stepUp = requireStepUp(user);
      if (stepUp) return stepUp;
      await prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: { totpSecret: "", totpPending: "", totpEnabledAt: null, totpLastStep: 0 } }),
        prisma.recoveryCode.deleteMany({ where: { userId } }),
      ]);
      await revokeAllSessions(userId);
      await audit({ actor, ip, action: "user.2fa_reset", message: `${user.email} reset 2FA for ${target.email}`, targetType: "user", targetId: userId });
      return NextResponse.json({ success: true });
    }

    case "grant": {
      // One endpoint or one project
      const scopeType = typeof body.projectId === "string" ? "project" : "endpoint";
      const scopeId = String(scopeType === "project" ? body.projectId : body.endpointId ?? "");
      const exists =
        ID_RE.test(scopeId) &&
        (scopeType === "project"
          ? await prisma.project.findUnique({ where: { id: scopeId } })
          : await prisma.endpoint.findUnique({ where: { id: scopeId } }));
      if (!exists) return NextResponse.json({ error: scopeType === "project" ? "Project not found" : "Endpoint not found" }, { status: 404 });
      if (!(BINDABLE_ROLES as readonly string[]).includes(body.role as string)) {
        return NextResponse.json({ error: "Role must be viewer, operator or admin" }, { status: 400 });
      }
      await prisma.roleBinding.upsert({
        where: { userId_scopeType_scopeId: { userId, scopeType, scopeId } },
        create: { userId, scopeType, scopeId, role: body.role as string },
        update: { role: body.role as string },
      });
      await audit({
        actor,
        ip,
        action: "user.grant",
        message: `${user.email} gave ${target.email} ${body.role} on a${scopeType === "project" ? " project" : "n endpoint"}`,
        targetType: "user",
        targetId: userId,
        endpointId: scopeType === "endpoint" ? scopeId : null,
        details: `${scopeType}:${scopeId}`,
      });
      return NextResponse.json({ success: true });
    }

    case "revokeGrant": {
      const bindingId = typeof body.bindingId === "string" ? body.bindingId : "";
      const res = await prisma.roleBinding.deleteMany({ where: { id: bindingId, userId } });
      await audit({ actor, ip, action: "user.revoke_grant", message: `${user.email} removed a grant from ${target.email}`, targetType: "user", targetId: userId });
      return NextResponse.json({ success: res.count > 0 });
    }
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

// ── Register via invite token (public: no session yet) ─────────────────────────
export async function PUT(request: Request) {
  const body = await readJson(request);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!/^[0-9a-f]{64}$/.test(token)) return NextResponse.json({ error: "Invalid invite token" }, { status: 400 });
  if (!name || name.length < 2 || name.length > 100) {
    return NextResponse.json({ error: "Name must be 2–100 characters" }, { status: 400 });
  }
  const weak = validatePasswordStrength(body.password);
  if (weak) return NextResponse.json({ error: weak }, { status: 400 });

  const invite = await prisma.teamInvite.findUnique({ where: { token } });
  if (!invite || invite.used || invite.expiresAt < new Date()) {
    return NextResponse.json({ error: "Invalid or expired invite" }, { status: 400 });
  }
  if (await prisma.user.findUnique({ where: { email: invite.email } })) {
    return NextResponse.json({ error: "Invalid or expired invite" }, { status: 400 });
  }

  // Mark used first so the same token can't create two accounts
  const claimed = await prisma.teamInvite.updateMany({ where: { id: invite.id, used: false }, data: { used: true } });
  if (claimed.count === 0) return NextResponse.json({ error: "Invalid or expired invite" }, { status: 400 });

  const created = await prisma.user.create({
    data: {
      email: invite.email,
      name,
      password: await hashPassword(body.password as string),
      role: normalizeRole(invite.role),
    },
  });
  await audit({
    actor: { id: created.id, email: created.email },
    ip: clientIp(request),
    action: "user.register",
    message: `${created.email} joined as ${created.role}`,
  });
  return NextResponse.json({ success: true });
}
