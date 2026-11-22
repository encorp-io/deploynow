/**
 * Application environment variables, Portainer style.
 *
 *   plain   stored and shown as typed
 *   secret  encrypted at rest (AES-256-GCM), never sent back to the browser,
 *           masked in deploy logs
 *   vault   the value is a Vault reference (mount/path#field), read from
 *           Vault at deploy time and masked in deploy logs
 */
import { decryptSecret, encryptSecret } from "../secretsCrypto";
import { loadVaultConfig, parseVaultRef, VaultReader } from "../vault";

export const ENV_KINDS = ["plain", "secret", "vault"] as const;
export type EnvKind = (typeof ENV_KINDS)[number];
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const MAX_VALUE = 64 * 1024;

export interface StoredEnvVar {
  key: string;
  kind: EnvKind;
  /** plain: the value; secret: ciphertext; vault: the reference */
  value: string;
}

/** What the browser sees: secret values are never included. */
export interface ClientEnvVar {
  key: string;
  kind: EnvKind;
  value: string | null;
  hasValue?: boolean;
}

export class EnvError extends Error {}

export function readStoredEnv(json: string): StoredEnvVar[] {
  try {
    const list = JSON.parse(json || "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter((e) => e && typeof e.key === "string")
      .map((e) => ({ key: e.key, kind: (ENV_KINDS as readonly string[]).includes(e.kind) ? e.kind : "plain", value: String(e.value ?? "") }));
  } catch {
    return [];
  }
}

export function envForClient(json: string): ClientEnvVar[] {
  return readStoredEnv(json).map((e) => (e.kind === "secret" ? { key: e.key, kind: e.kind, value: null, hasValue: !!e.value } : { key: e.key, kind: e.kind, value: e.value }));
}

/**
 * Validate the list the browser sends. A secret with value null or omitted
 * keeps its stored value (matched by key), so the UI never has to send it back.
 */
export function parseEnvInput(input: unknown, existingJson = "[]"): StoredEnvVar[] {
  let list: unknown = input;
  if (typeof input === "string") {
    try {
      list = JSON.parse(input);
    } catch {
      throw new EnvError("Environment variables must be a list");
    }
  }
  if (!Array.isArray(list)) throw new EnvError("Environment variables must be a list");
  if (list.length > 300) throw new EnvError("Too many environment variables");
  const existing = new Map(readStoredEnv(existingJson).map((e) => [e.key, e]));
  const seen = new Set<string>();
  const out: StoredEnvVar[] = [];

  for (const raw of list) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const key = String(r.key ?? "").trim();
    if (!key) continue;
    if (!ENV_KEY_RE.test(key) || key.length > 128) throw new EnvError(`Invalid variable name "${key}"`);
    if (seen.has(key)) throw new EnvError(`${key} is listed twice`);
    seen.add(key);
    const kind = (ENV_KINDS as readonly string[]).includes(r.kind as string) ? (r.kind as EnvKind) : "plain";
    const value = r.value === null || r.value === undefined ? null : String(r.value);
    if (value !== null && value.length > MAX_VALUE) throw new EnvError(`${key} is longer than 64 KB`);

    if (kind === "secret") {
      if (value === null || value === "") {
        const prev = existing.get(key);
        if (prev?.kind === "secret" && prev.value) out.push(prev);
        else if (prev?.kind === "plain" && prev.value) out.push({ key, kind, value: encryptSecret(prev.value) });
        else throw new EnvError(`Enter a value for ${key}`);
      } else {
        out.push({ key, kind, value: encryptSecret(value) });
      }
    } else if (kind === "vault") {
      const ref = (value ?? "").trim();
      try {
        parseVaultRef(ref);
      } catch (err) {
        throw new EnvError(`${key}: ${(err as Error).message}`);
      }
      out.push({ key, kind, value: ref });
    } else {
      out.push({ key, kind, value: value ?? "" });
    }
  }
  return out;
}

export interface ResolvedEnv {
  vars: { key: string; value: string }[];
  /** values to mask in logs */
  sensitive: string[];
}

/** Decrypt secrets and read Vault references for a deployment. */
export async function resolveEnv(stored: StoredEnvVar[], opts: { vault?: VaultReader | null } = {}): Promise<ResolvedEnv> {
  const vars: { key: string; value: string }[] = [];
  const sensitive: string[] = [];
  let vault = opts.vault ?? null;
  for (const e of stored) {
    if (e.kind === "plain") {
      vars.push({ key: e.key, value: e.value });
    } else if (e.kind === "secret") {
      const v = decryptSecret(e.value);
      if (!v && e.value) throw new EnvError(`Couldn't decrypt ${e.key}: was AUTH_SECRET changed? Enter the value again.`);
      vars.push({ key: e.key, value: v });
      sensitive.push(v);
    } else {
      if (!vault) {
        const cfg = await loadVaultConfig();
        if (!cfg) throw new EnvError(`${e.key} comes from Vault, but Vault isn't set up in Settings`);
        vault = new VaultReader(cfg);
      }
      const v = await vault.read(e.value);
      vars.push({ key: e.key, value: v });
      sensitive.push(v);
    }
  }
  return { vars, sensitive };
}

/** Replace every sensitive value in log output with ***. Longest first. */
export function makeMasker(values: string[]): (text: string) => string {
  const list = [...new Set(values.filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length);
  if (!list.length) return (t) => t;
  return (text) => {
    let out = text;
    for (const v of list) out = out.split(v).join("***");
    return out;
  };
}
