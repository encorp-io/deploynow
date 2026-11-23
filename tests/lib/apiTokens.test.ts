/** API tokens: creation, hashing, scope caps, expiry and revocation, through the real apiAuth. */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import fs from "fs";

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-tok-"));
  process.env.DATABASE_URL = `file:${d}/tok.db`;
  return { dir: d as string, headers: new Headers() };
});
vi.mock("next/headers", () => ({ headers: async () => h.headers }));
vi.mock("@/lib/auth", () => ({ auth: async () => null }));

import { prisma } from "@/lib/prisma";
import { bearerToken, createApiToken, hashToken, lowerRole, resolveToken, serializeToken } from "@/lib/apiTokens";
import { getCurrentUser, requireStepUp, requireUser } from "@/lib/apiAuth";

const use = (token: string) => h.headers.set("authorization", `Bearer ${token}`);
let admin: { id: string; role: string };

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  admin = await prisma.user.create({ data: { email: "root@acme.com", name: "Root", password: "x", role: "admin" } });
}, 60_000);
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe("API tokens", () => {
  it("creates dn_ tokens stored only as a hash", async () => {
    const { token, row } = await createApiToken(admin, { name: "CI", scope: "operator", expiresInDays: 30 });
    expect(token).toMatch(/^dn_[A-Za-z0-9_-]{43}$/);
    expect(row.hash).toBe(hashToken(token));
    expect(JSON.stringify(serializeToken(row))).not.toContain(token);
    expect(serializeToken(row)).toMatchObject({ name: "CI", scope: "operator", prefix: token.slice(0, 10), revoked: false, expired: false });
    await expect(createApiToken({ id: admin.id, role: "viewer" }, { name: "x", scope: "admin" })).rejects.toThrow(/more rights/);
    await expect(createApiToken(admin, { name: "", scope: "viewer" })).rejects.toThrow(/name/);
    await expect(createApiToken(admin, { name: "x", scope: "root" })).rejects.toThrow(/Scope/);
    await expect(createApiToken(admin, { name: "x", scope: "viewer", expiresInDays: 0.5 })).rejects.toThrow(/Expiry/);
  });

  it("parses bearer headers and picks the lower role", () => {
    expect(bearerToken("Bearer dn_" + "a".repeat(43))).toBe("dn_" + "a".repeat(43));
    expect(bearerToken("Bearer nope")).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(lowerRole("admin", "viewer")).toBe("viewer");
    expect(lowerRole("viewer", "admin")).toBe("viewer");
  });

  it("acts as its user, capped at the token's scope", async () => {
    const { token, row } = await createApiToken(admin, { name: "read", scope: "viewer" });
    use(token);
    const u = await getCurrentUser();
    expect(u).toMatchObject({ id: admin.id, role: "viewer", tokenId: row.id });
    expect((await requireUser("endpoint.view")).ok).toBe(true);
    const denied = await requireUser("settings.manage");
    expect(denied.ok).toBe(false);
    // Sensitive actions need a person
    expect(requireStepUp(u!)?.status).toBe(403);
    expect((await prisma.apiToken.findUniqueOrThrow({ where: { id: row.id } })).lastUsedAt).not.toBeNull();
  });

  it("stops working when revoked, expired, or the user is disabled", async () => {
    const a = await createApiToken(admin, { name: "a", scope: "admin" });
    use(a.token);
    expect((await getCurrentUser())?.role).toBe("admin");
    await prisma.apiToken.update({ where: { id: a.row.id }, data: { revokedAt: new Date() } });
    expect(await getCurrentUser()).toBeNull();

    const b = await createApiToken(admin, { name: "b", scope: "admin", expiresInDays: 1 });
    await prisma.apiToken.update({ where: { id: b.row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resolveToken(b.token)).toBeNull();

    const c = await createApiToken(admin, { name: "c", scope: "admin" });
    await prisma.user.update({ where: { id: admin.id }, data: { disabledAt: new Date() } });
    expect(await resolveToken(c.token)).toBeNull();
    await prisma.user.update({ where: { id: admin.id }, data: { disabledAt: null } });

    use("dn_" + "z".repeat(43));
    expect(await getCurrentUser()).toBeNull();
    h.headers.delete("authorization");
    expect(await getCurrentUser()).toBeNull(); // falls back to the (absent) session
  });
});
