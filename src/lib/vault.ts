/**
 * Optional HashiCorp Vault integration.
 *
 * An env var of kind "vault" holds a reference "<mount>/<path>#<field>", for
 * example "secret/acme/api#DATABASE_URL". At deploy time DeployNow reads it
 * from Vault's KV engine (v2, falling back to v1) and passes the value to the
 * app. Vault keeps the versions, rotation and audit trail; DeployNow stores
 * only the reference.
 *
 * Auth: a token, or AppRole (role id + secret id), which is the recommended
 * way for a service like this one.
 */
import https from "https";
import http from "http";
import { prisma } from "./prisma";
import { decryptSecret } from "./secretsCrypto";

export const VAULT_REF_RE = /^([\w.-]+)\/([\w./-]+)#([\w.-]+)$/;

export class VaultError extends Error {}

export interface VaultConfig {
  addr: string;
  namespace: string;
  auth: "token" | "approle";
  token: string;
  roleId: string;
  secretId: string;
  caCert: string;
}

export function parseVaultRef(ref: string): { mount: string; path: string; field: string } {
  const m = VAULT_REF_RE.exec(ref.trim());
  if (!m || m[2].split("/").includes("..")) throw new VaultError(`"${ref}" is not a Vault reference; use mount/path#field, e.g. secret/myapp#DB_PASSWORD`);
  return { mount: m[1], path: m[2].replace(/\/+$/, ""), field: m[3] };
}

export async function loadVaultConfig(): Promise<VaultConfig | null> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!s?.vaultAddr) return null;
  return {
    addr: s.vaultAddr.replace(/\/+$/, ""),
    namespace: s.vaultNamespace,
    auth: s.vaultAuth === "approle" ? "approle" : "token",
    token: s.vaultToken ? decryptSecret(s.vaultToken) : "",
    roleId: s.vaultRoleId,
    secretId: s.vaultSecretId ? decryptSecret(s.vaultSecretId) : "",
    caCert: s.vaultCaCert,
  };
}

export function validateVaultAddr(raw: unknown): string {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new VaultError("Enter Vault's address, e.g. https://vault.example.com:8200");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) {
    throw new VaultError("Vault must be reached over https (http only for localhost)");
  }
  if (u.username || u.password || u.search || u.hash) throw new VaultError("The address should be just scheme, host and port");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

interface VaultResponse {
  status: number;
  body: Record<string, unknown>;
}

function request(cfg: VaultConfig, method: string, apiPath: string, token: string | null, payload?: unknown): Promise<VaultResponse> {
  const url = new URL(cfg.addr + apiPath);
  const lib = url.protocol === "https:" ? https : http;
  const data = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
          ...(token ? { "X-Vault-Token": token } : {}),
          ...(cfg.namespace ? { "X-Vault-Namespace": cfg.namespace } : {}),
        },
        ...(cfg.caCert && url.protocol === "https:" ? { ca: cfg.caCert } : {}),
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Vault did not answer within 10 s")));
    req.on("error", (e) => reject(new VaultError(`Can't reach Vault: ${e.message}`)));
    if (data) req.write(data);
    req.end();
  });
}

function vaultErrors(r: VaultResponse): string {
  const errs = r.body.errors;
  return Array.isArray(errs) && errs.length ? errs.join("; ").slice(0, 300) : `HTTP ${r.status}`;
}

/** A client token for this run: the configured token, or an AppRole login. */
export async function vaultToken(cfg: VaultConfig): Promise<string> {
  if (cfg.auth === "token") {
    if (!cfg.token) throw new VaultError("No Vault token is set in Settings");
    return cfg.token;
  }
  if (!cfg.roleId || !cfg.secretId) throw new VaultError("Set the AppRole role id and secret id in Settings");
  const r = await request(cfg, "POST", "/v1/auth/approle/login", null, { role_id: cfg.roleId, secret_id: cfg.secretId });
  const token = (r.body.auth as { client_token?: string } | undefined)?.client_token;
  if (r.status !== 200 || !token) throw new VaultError(`Vault AppRole login failed: ${vaultErrors(r)}`);
  return token;
}

/** Reads references with one token and caches each secret path for the run. */
export class VaultReader {
  private token: Promise<string> | null = null;
  private cache = new Map<string, Promise<Record<string, unknown>>>();

  constructor(private cfg: VaultConfig) {}

  private async readPath(mount: string, path: string): Promise<Record<string, unknown>> {
    this.token ??= vaultToken(this.cfg);
    const token = await this.token;
    const enc = path.split("/").map(encodeURIComponent).join("/");
    // KV v2 first
    let r = await request(this.cfg, "GET", `/v1/${encodeURIComponent(mount)}/data/${enc}`, token);
    if (r.status === 200) return ((r.body.data as { data?: Record<string, unknown> })?.data ?? {}) as Record<string, unknown>;
    if (r.status === 403) throw new VaultError(`Vault denied access to ${mount}/${path}: check the policy`);
    // KV v1
    r = await request(this.cfg, "GET", `/v1/${encodeURIComponent(mount)}/${enc}`, token);
    if (r.status === 200) return (r.body.data ?? {}) as Record<string, unknown>;
    if (r.status === 404) throw new VaultError(`${mount}/${path} doesn't exist in Vault`);
    throw new VaultError(`Reading ${mount}/${path} from Vault failed: ${vaultErrors(r)}`);
  }

  async read(ref: string): Promise<string> {
    const { mount, path, field } = parseVaultRef(ref);
    const key = `${mount}/${path}`;
    if (!this.cache.has(key)) this.cache.set(key, this.readPath(mount, path));
    const data = await this.cache.get(key)!;
    if (!(field in data)) throw new VaultError(`${key} has no field "${field}"`);
    const v = data[field];
    return typeof v === "string" ? v : JSON.stringify(v);
  }
}

/** Settings page "Test connection": log in and look the token up. */
export async function testVault(cfg: VaultConfig): Promise<string> {
  const token = await vaultToken(cfg);
  const r = await request(cfg, "GET", "/v1/auth/token/lookup-self", token);
  if (r.status !== 200) throw new VaultError(`Vault rejected the token: ${vaultErrors(r)}`);
  const d = r.body.data as { display_name?: string; policies?: string[]; ttl?: number } | undefined;
  const ttl = d?.ttl ? `, expires in ${Math.round(d.ttl / 3600)} h` : "";
  return `Connected as ${d?.display_name ?? "token"} (policies: ${(d?.policies ?? []).join(", ") || "none"}${ttl})`;
}
