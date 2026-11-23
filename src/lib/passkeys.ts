/**
 * Passkeys (WebAuthn). Signing in with a passkey ends in the same one-time
 * login ticket as single sign-on, and counts as two-factor.
 */
import crypto from "crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Passkey } from "@prisma/client";
import { prisma } from "./prisma";
import { requestOrigin } from "./publicOrigin";

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_PASSKEYS = 20;

export class PasskeyError extends Error {}

type RegistrationResponse = Parameters<typeof verifyRegistrationResponse>[0]["response"];
type AuthenticationResponse = Parameters<typeof verifyAuthenticationResponse>[0]["response"];
type Transport = NonNullable<Parameters<typeof verifyAuthenticationResponse>[0]["authenticator"]["transports"]>[number];

/**
 * The relying party: the address the browser is on and its host name. A passkey
 * only works on the host it was added on, so passkeys added at the platform
 * domain work there, and ones added at the server's own address work there.
 */
export function relyingParty(request: Request) {
  const origin = requestOrigin(request);
  const rpID = new URL(origin).hostname;
  return { origin, rpID };
}

export function serializePasskey(p: Passkey) {
  return { id: p.id, name: p.name, rpId: p.rpId, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, transports: p.transports ? p.transports.split(",") : [] };
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64url");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

async function saveChallenge(id: string, kind: string, userId: string, challenge: string) {
  await prisma.authChallenge.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date() } }, { id }] } });
  await prisma.authChallenge.create({ data: { id, kind, userId, data: challenge, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) } });
}

async function takeChallenge(id: string, kind: string) {
  const row = await prisma.authChallenge.findUnique({ where: { id } });
  if (!row) return null;
  await prisma.authChallenge.delete({ where: { id } }).catch(() => {});
  if (row.kind !== kind || row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

export async function registrationOptions(user: { id: string; email: string; name: string }, request: Request) {
  const { rpID } = relyingParty(request);
  const existing = await prisma.passkey.findMany({ where: { userId: user.id } });
  if (existing.length >= MAX_PASSKEYS) throw new PasskeyError(`You can have up to ${MAX_PASSKEYS} passkeys`);
  const options = await generateRegistrationOptions({
    rpName: "DeployNow",
    rpID,
    userID: user.id,
    userName: user.email,
    userDisplayName: user.name || user.email,
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: unb64(p.credentialId), type: "public-key" as const, transports: (p.transports ? p.transports.split(",") : []) as Transport[] })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  await saveChallenge(`wa-reg:${user.id}`, "webauthn-register", user.id, options.challenge);
  return options;
}

export async function finishRegistration(userId: string, response: RegistrationResponse, name: string, request: Request) {
  const row = await takeChallenge(`wa-reg:${userId}`, "webauthn-register");
  if (!row) throw new PasskeyError("The passkey request expired; try again");
  const { origin, rpID } = relyingParty(request);
  let result;
  try {
    result = await verifyRegistrationResponse({ response, expectedChallenge: row.data, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  } catch (err) {
    throw new PasskeyError(`The passkey couldn't be verified: ${(err as Error).message}`);
  }
  if (!result.verified || !result.registrationInfo) throw new PasskeyError("The passkey couldn't be verified");
  const info = result.registrationInfo;
  const credentialId = b64(info.credentialID);
  if (await prisma.passkey.findUnique({ where: { credentialId } })) throw new PasskeyError("That passkey is already registered");
  const transports = Array.isArray(response.response?.transports) ? response.response.transports.filter((t) => /^[a-z-]{2,20}$/.test(t)).join(",") : "";
  return prisma.passkey.create({
    data: {
      userId,
      credentialId,
      publicKey: b64(info.credentialPublicKey),
      counter: info.counter,
      transports,
      rpId: rpID,
      name: (name || "Passkey").trim().slice(0, 60) || "Passkey",
    },
  });
}

/** Options for a passkey sign-in. Discoverable credentials: no email needed. */
export async function authenticationOptions(request: Request) {
  const { rpID } = relyingParty(request);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  await saveChallenge(`wa-login:${crypto.createHash("sha256").update(options.challenge).digest("hex")}`, "webauthn-login", "", options.challenge);
  return options;
}

/** Verify a passkey sign-in. Returns the passkey and its user. */
export async function finishAuthentication(response: AuthenticationResponse, request: Request) {
  const clientData = (() => {
    try {
      return JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString()) as { challenge?: string };
    } catch {
      return {};
    }
  })();
  if (typeof clientData.challenge !== "string") throw new PasskeyError("The passkey response is malformed");
  const row = await takeChallenge(`wa-login:${crypto.createHash("sha256").update(clientData.challenge).digest("hex")}`, "webauthn-login");
  if (!row) throw new PasskeyError("The sign-in request expired; try again");
  const passkey = await prisma.passkey.findUnique({ where: { credentialId: String(response.id) }, include: { user: true } });
  if (!passkey) throw new PasskeyError("This passkey isn't registered with DeployNow");
  if (passkey.user.disabledAt) throw new PasskeyError("This account is disabled");
  const { origin, rpID } = relyingParty(request);
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.data,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      authenticator: {
        credentialID: unb64(passkey.credentialId),
        credentialPublicKey: unb64(passkey.publicKey),
        counter: passkey.counter,
        transports: (passkey.transports ? passkey.transports.split(",") : []) as Transport[],
      },
    });
  } catch (err) {
    throw new PasskeyError(`The passkey couldn't be verified: ${(err as Error).message}`);
  }
  if (!result.verified) throw new PasskeyError("The passkey couldn't be verified");
  await prisma.passkey.update({ where: { id: passkey.id }, data: { counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() } });
  return passkey;
}
