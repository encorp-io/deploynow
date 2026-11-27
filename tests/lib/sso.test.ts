/** Single sign-on and login tickets against a real temp database and a fake OIDC provider. */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from "jose";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-sso-"));
  process.env.DATABASE_URL = `file:${d}/sso.db`;
  return d as string;
});
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "9.9.9.9" }));
// next-auth's error classes need Next's runtime; stand-ins with the same codes
vi.mock("@/lib/authErrors", () => {
  class E extends Error {
    code = "";
  }
  return {
    TwoFactorRequired: class extends E { code = "2fa_required"; },
    InvalidTwoFactorCode: class extends E { code = "invalid_code"; },
    TooManyAttempts: class extends E { code = "rate_limited"; },
  };
});

import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/secretsCrypto";
import { generateTotpSecret, totpAt, currentStep } from "@/lib/totp";
import * as sso from "@/lib/sso";
import { authorizeTicket } from "@/lib/ticketLogin";

const ISSUER = "https://idp.example.com";
let keys: ReturnType<typeof createLocalJWKSet>;
let privateKey: CryptoKey;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
}, 60_000);
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

const idToken = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(opts.iss ?? ISSUER).setAudience(opts.aud ?? "client-1").setIssuedAt().setExpirationTime("5m").sign(privateKey);

function fakeIdp(tokenBody: () => Promise<Record<string, unknown>>, seen: { body?: URLSearchParams } = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/.well-known/openid-configuration")) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
    }
    if (u === `${ISSUER}/token`) {
      seen.body = new URLSearchParams(String(init?.body));
      return Response.json(await tokenBody());
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

async function provider(over: Record<string, unknown> = {}) {
  const v = sso.validateProvider({ type: "oidc", name: "Acme ID", clientId: "client-1", clientSecret: "s3cret", issuer: ISSUER, ...over });
  return prisma.ssoProvider.create({ data: { ...v, clientSecret: v.clientSecret! } });
}

describe("provider settings", () => {
  it("validates and masks", () => {
    expect(() => sso.validateProvider({ type: "saml" })).toThrow(/Type/);
    expect(() => sso.validateProvider({ type: "google", clientId: "x" })).toThrow(/secret/);
    expect(() => sso.validateProvider({ type: "oidc", clientId: "x", clientSecret: "y", name: "X", issuer: "http://idp" })).toThrow(/https/);
    expect(() => sso.validateProvider({ type: "google", clientId: "x", clientSecret: "y", autoCreate: true })).toThrow(/allowed email domain/);
    expect(() => sso.validateProvider({ type: "google", clientId: "x", clientSecret: "y", allowedDomains: "not a domain!" })).toThrow(/Invalid domain/);
    expect(() => sso.validateProvider({ type: "google", clientId: "x", clientSecret: "y", defaultRole: "owner" })).toThrow(/viewer/);
    const ms = sso.validateProvider({ type: "microsoft", clientId: "x", clientSecret: "y", allowedDomains: "@Example.com, b.org" });
    expect(ms).toMatchObject({ name: "Microsoft", tenant: "organizations", allowedDomains: "example.com,b.org" });
    expect(sso.issuerFor({ type: "microsoft", tenant: "contoso.onmicrosoft.com", issuer: "" })).toBe("https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0");
    expect(sso.issuerFor({ type: "google", tenant: "", issuer: "" })).toBe("https://accounts.google.com");
    // Keeping the stored secret on update
    const kept = sso.validateProvider({ clientSecret: "••••••••" }, { ...ms, id: "x", clientSecret: "enc", createdAt: new Date(), updatedAt: new Date() } as never);
    expect(kept).not.toHaveProperty("clientSecret");
    expect(sso.serializeProvider({ ...ms, id: "x", clientSecret: "enc", createdAt: new Date(), updatedAt: new Date() } as never).clientSecret).toBe("••••••••");
  });

  it("trusts only verified emails, and Microsoft emails within the tenant or allowed domains", () => {
    const g = { type: "google", allowedDomains: "", tenant: "" } as never;
    expect(sso.trustedEmail(g, { email: "A@x.com", email_verified: true })).toBe("a@x.com");
    expect(sso.trustedEmail(g, { email: "a@x.com", email_verified: false })).toBe("");
    const multi = { type: "microsoft", allowedDomains: "acme.com", tenant: "organizations" } as never;
    // nOAuth: another tenant's admin can set any address, so multi-tenant needs xms_edov
    expect(sso.trustedEmail(multi, { preferred_username: "bob@acme.com" })).toBe("");
    expect(sso.trustedEmail(multi, { email: "bob@acme.com" })).toBe("");
    expect(sso.trustedEmail(multi, { email: "bob@acme.com", xms_edov: false })).toBe("");
    expect(sso.trustedEmail(multi, { email: "Bob@acme.com", xms_edov: true })).toBe("bob@acme.com");
    expect(sso.trustedEmail(multi, { preferred_username: "bob@acme.com", xms_edov: true })).toBe("");
    const common = { type: "microsoft", allowedDomains: "", tenant: "Common" } as never;
    expect(sso.trustedEmail(common, { email: "owner@acme.com" })).toBe("");
    const single = { type: "microsoft", allowedDomains: "", tenant: "11111111-2222-3333-4444-555555555555" } as never;
    expect(sso.trustedEmail(single, { email: "bob@evil.com" })).toBe("bob@evil.com");
    expect(sso.trustedEmail(single, { preferred_username: "bob@acme.com" })).toBe("bob@acme.com");
  });
});

describe("sign-in flow", () => {
  it("runs the code flow with PKCE, links an existing user and refuses replays", async () => {
    const p = await provider();
    const user = await prisma.user.create({ data: { email: "ann@acme.com", name: "Ann", password: "x", role: "operator" } });
    const seen: { body?: URLSearchParams } = {};
    let nonce = "";
    const f = fakeIdp(async () => ({ id_token: await idToken({ sub: "sub-ann", email: "ann@acme.com", email_verified: true, nonce }) }), seen);

    const url = new URL(await sso.startLogin(p, "https://dn.example.com", f));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/auth`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://dn.example.com/api/sso/callback");
    const state = url.searchParams.get("state")!;
    nonce = url.searchParams.get("nonce")!;

    const out = await sso.finishLogin({ state, code: "the-code" }, f, keys);
    expect(out.user.id).toBe(user.id);
    expect(out.origin).toBe("https://dn.example.com");
    expect(seen.body?.get("code_verifier")).toMatch(/^[\w-]{43}$/);
    expect(seen.body?.get("client_secret")).toBe("s3cret");
    expect(await prisma.userIdentity.count({ where: { userId: user.id } })).toBe(1);
    await expect(sso.finishLogin({ state, code: "the-code" }, f, keys)).rejects.toThrow(/expired or was already used/);

    // Second sign-in goes through the linked identity even if the email changed
    const url2 = new URL(await sso.startLogin(p, "https://dn.example.com", f));
    nonce = url2.searchParams.get("nonce")!;
    const f2 = fakeIdp(async () => ({ id_token: await idToken({ sub: "sub-ann", email: "ann.new@other.com", email_verified: true, nonce }) }));
    expect((await sso.finishLogin({ state: url2.searchParams.get("state")!, code: "c" }, f2, keys)).user.id).toBe(user.id);
  });

  it("rejects wrong nonces, audiences, issuers and refused codes", async () => {
    const p = await provider({ name: "Strict" });
    const go = async (claims: Record<string, unknown>, opts: { aud?: string; iss?: string } = {}, body?: Record<string, unknown>) => {
      const url = new URL(await sso.startLogin(p, "https://dn.example.com", fakeIdp(async () => ({}))));
      const nonce = url.searchParams.get("nonce")!;
      const f = fakeIdp(async () => body ?? { id_token: await idToken({ sub: "s", nonce, ...claims }, opts) });
      return sso.finishLogin({ state: url.searchParams.get("state")!, code: "c" }, f, keys);
    };
    await expect(go({ nonce: "other" })).rejects.toThrow(/nonce/);
    await expect(go({}, { aud: "someone-else" })).rejects.toThrow(/aud/);
    await expect(go({}, { iss: "https://evil.example.com" })).rejects.toThrow(/iss/);
    await expect(go({}, {}, { error: "invalid_grant", error_description: "Code expired" })).rejects.toThrow(/Code expired/);
    await expect(go({ email: "nobody@acme.com", email_verified: true })).rejects.toThrow(/no DeployNow account/);
    await expect(go({ email: "x@acme.com", email_verified: false })).rejects.toThrow(/didn't confirm an email/);
  });

  it("creates users within the allowed domains, never as owner, and keeps others out", async () => {
    const p = await provider({ name: "Auto", allowedDomains: "acme.io", autoCreate: true, defaultRole: "operator" });
    const claims = (email: string) => ({ sub: `sub-${email}`, email, email_verified: true, name: "New Person" });
    const u = await sso.resolveUser(p, claims("new@acme.io"));
    expect(u).toMatchObject({ email: "new@acme.io", role: "operator", name: "New Person" });
    await expect(sso.resolveUser(p, claims("new@other.io"))).rejects.toThrow(/limited to @acme.io/);
  });

  it("doesn't let another Entra tenant take over an account by email (nOAuth)", async () => {
    const owner = await prisma.user.create({ data: { email: "boss@victim.io", name: "Boss", role: "owner", password: "x" } });
    const v = sso.validateProvider({ type: "microsoft", clientId: "client-mt", clientSecret: "s", tenant: "organizations", allowedDomains: "victim.io", autoCreate: true });
    const p = await prisma.ssoProvider.create({ data: { ...v, clientSecret: v.clientSecret! } });
    const attacker = { sub: "attacker-sub", tid: "99999999-0000-0000-0000-000000000000", email: "boss@victim.io", preferred_username: "boss@victim.io" };
    await expect(sso.resolveUser(p, attacker)).rejects.toThrow(/limited to @victim.io/);
    expect(await prisma.userIdentity.count({ where: { providerId: p.id } })).toBe(0);
    // Same claims, but the issuing tenant verified the domain: that's the real owner
    const u = await sso.resolveUser(p, { ...attacker, sub: "real-sub", xms_edov: true });
    expect(u.id).toBe(owner.id);
  });

  it("checks the Microsoft tenant", async () => {
    const tenant = "11111111-2222-3333-4444-555555555555";
    const v = sso.validateProvider({ type: "microsoft", clientId: "client-1", clientSecret: "s", tenant });
    const p = await prisma.ssoProvider.create({ data: { ...v, clientSecret: v.clientSecret! } });
    const msIssuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
    const f = vi.fn(async () => Response.json({ issuer: msIssuer, authorization_endpoint: `${msIssuer}/a`, token_endpoint: `${msIssuer}/t`, jwks_uri: `${msIssuer}/k` })) as unknown as typeof fetch;
    await sso.discover(msIssuer, f);
    const good = await idToken({ sub: "s", nonce: "n", tid: tenant }, { iss: msIssuer });
    expect((await sso.verifyIdToken(p, good, "n", keys)).tid).toBe(tenant);
    const other = await idToken({ sub: "s", nonce: "n", tid: "99999999-2222-3333-4444-555555555555" }, { iss: msIssuer });
    await expect(sso.verifyIdToken(p, other, "n", keys)).rejects.toThrow(/another Microsoft tenant/);
  });
});

describe("login tickets", () => {
  const request = new Request("https://dn.example.com/api/auth/callback/ticket", { headers: { "user-agent": "test" } });

  it("turns a ticket into a session once, and only within its lifetime", async () => {
    const user = await prisma.user.create({ data: { email: "t1@acme.com", name: "T", password: "x", role: "viewer" } });
    const ticket = await sso.createTicket(user.id, "passkey", "MacBook");
    expect(await sso.peekTicket(ticket)).toMatchObject({ userId: user.id, method: "passkey" });
    const signedIn = await authorizeTicket({ ticket }, request);
    expect(signedIn).toMatchObject({ id: user.id, email: "t1@acme.com", role: "viewer" });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    expect(await authorizeTicket({ ticket }, request)).toBeNull();
    expect(await authorizeTicket({ ticket: "short" }, request)).toBeNull();

    const old = await sso.createTicket(user.id, "sso", "Acme ID");
    await prisma.authChallenge.update({ where: { id: sso.ticketHash(old) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await authorizeTicket({ ticket: old }, request)).toBeNull();
  });

  it("asks for the authenticator code after SSO, but not after a passkey", async () => {
    const secret = generateTotpSecret();
    const user = await prisma.user.create({ data: { email: "t2@acme.com", name: "T", password: "x", role: "admin", totpSecret: encryptSecret(secret), totpEnabledAt: new Date() } });
    const ticket = await sso.createTicket(user.id, "sso", "Acme ID");
    await expect(authorizeTicket({ ticket }, request)).rejects.toMatchObject({ code: "2fa_required" });
    await expect(authorizeTicket({ ticket, code: "000000" }, request)).rejects.toMatchObject({ code: "invalid_code" });
    // The ticket survives a wrong code
    const ok = await authorizeTicket({ ticket, code: totpAt(secret, currentStep()) }, request);
    expect(ok?.id).toBe(user.id);

    const pk = await sso.createTicket(user.id, "passkey", "YubiKey");
    expect((await authorizeTicket({ ticket: pk }, request))?.id).toBe(user.id);
  });

  it("refuses disabled accounts", async () => {
    const user = await prisma.user.create({ data: { email: "t3@acme.com", name: "T", password: "x", role: "viewer", disabledAt: new Date() } });
    expect(await authorizeTicket({ ticket: await sso.createTicket(user.id, "sso", "x") }, request)).toBeNull();
  });
});
