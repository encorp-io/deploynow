/**
 * Passkeys end to end with a software authenticator (P-256, "none" attestation),
 * against a real temp database. The relying party is NEXTAUTH_URL (https://localhost:9444).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-pk-"));
  process.env.DATABASE_URL = `file:${d}/pk.db`;
  return d as string;
});

import { prisma } from "@/lib/prisma";
import { authenticationOptions, finishAuthentication, finishRegistration, registrationOptions, relyingParty, serializePasskey } from "@/lib/passkeys";

const ORIGIN = "https://localhost:9444";
const RP_ID = "localhost";
const req = () => new Request(`${ORIGIN}/api/passkeys/register`);
const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

/** A minimal authenticator: one P-256 key, a counter, user verification always on. */
class SoftAuthenticator {
  key = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  credentialId = crypto.randomBytes(16);
  counter = 0;

  private authData(withCredential: boolean, rpId = RP_ID) {
    const rpIdHash = crypto.createHash("sha256").update(rpId).digest();
    const flags = Buffer.from([0x01 | 0x04 | (withCredential ? 0x40 : 0)]);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.counter);
    if (!withCredential) return Buffer.concat([rpIdHash, flags, count]);
    const jwk = this.key.publicKey.export({ format: "jwk" });
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([rpIdHash, flags, count, Buffer.alloc(16), len, this.credentialId, Buffer.from(isoCBOR.encode(cose))]);
  }

  register(challenge: string, origin = ORIGIN) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData(true)]]) as never);
    return { id: b64(this.credentialId), rawId: b64(this.credentialId), type: "public-key" as const, clientExtensionResults: {}, response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ["internal", "hybrid"] } };
  }

  login(challenge: string, origin = ORIGIN) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    const authenticatorData = this.authData(false);
    const signature = crypto.sign("sha256", Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientDataJSON).digest()]), this.key.privateKey);
    return { id: b64(this.credentialId), rawId: b64(this.credentialId), type: "public-key" as const, clientExtensionResults: {}, response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(signature) } };
  }
}

let user: { id: string; email: string; name: string };

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  user = await prisma.user.create({ data: { email: "pk@acme.com", name: "Pat", password: "x", role: "admin" } });
}, 60_000);
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("passkeys", () => {
  const device = new SoftAuthenticator();

  it("uses the public URL as the relying party", () => {
    expect(relyingParty(req())).toEqual({ origin: ORIGIN, rpID: RP_ID });
  });

  it("registers a passkey and refuses a replayed or foreign registration", async () => {
    const options = await registrationOptions(user, req());
    expect(options.rp).toEqual({ name: "DeployNow", id: RP_ID });
    expect(options.authenticatorSelection?.residentKey).toBe("required");
    const pk = await finishRegistration(user.id, device.register(options.challenge) as never, "MacBook", req());
    expect(serializePasskey(pk)).toMatchObject({ name: "MacBook", transports: ["internal", "hybrid"] });
    // The challenge is single-use
    await expect(finishRegistration(user.id, device.register(options.challenge) as never, "Again", req())).rejects.toThrow(/expired/);

    const other = new SoftAuthenticator();
    const o2 = await registrationOptions(user, req());
    expect(o2.excludeCredentials).toHaveLength(1);
    await expect(finishRegistration(user.id, other.register(o2.challenge, "https://evil.example") as never, "Evil", req())).rejects.toThrow(/couldn't be verified/);
    const o3 = await registrationOptions(user, req());
    await expect(finishRegistration(user.id, device.register(o3.challenge) as never, "Dup", req())).rejects.toThrow(/already registered/);
  });

  it("signs in with the passkey, bumps the counter, and refuses replays and strangers", async () => {
    const options = await authenticationOptions(req());
    expect(options.userVerification).toBe("required");
    const response = device.login(options.challenge);
    const pk = await finishAuthentication(response as never, req());
    expect(pk.userId).toBe(user.id);
    const row = await prisma.passkey.findUniqueOrThrow({ where: { id: pk.id } });
    expect(row.counter).toBe(device.counter);
    expect(row.lastUsedAt).not.toBeNull();
    await expect(finishAuthentication(response as never, req())).rejects.toThrow(/expired/);

    const o2 = await authenticationOptions(req());
    await expect(finishAuthentication(new SoftAuthenticator().login(o2.challenge) as never, req())).rejects.toThrow(/isn't registered/);
    const o3 = await authenticationOptions(req());
    await expect(finishAuthentication(device.login(o3.challenge, "https://evil.example") as never, req())).rejects.toThrow(/couldn't be verified/);
    await expect(finishAuthentication({ id: "x", response: { clientDataJSON: "!!" } } as never, req())).rejects.toThrow(/malformed/);
  });

  it("refuses a disabled account", async () => {
    await prisma.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
    const o = await authenticationOptions(req());
    await expect(finishAuthentication(device.login(o.challenge) as never, req())).rejects.toThrow(/disabled/);
    await prisma.user.update({ where: { id: user.id }, data: { disabledAt: null } });
  });
});
