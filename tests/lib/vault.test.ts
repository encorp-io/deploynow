import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";

const mockPrisma = vi.hoisted(() => ({ settings: { findUnique: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { loadVaultConfig, parseVaultRef, testVault, validateVaultAddr, VaultReader, vaultToken, type VaultConfig } from "@/lib/vault";
import { encryptSecret } from "@/lib/secretsCrypto";

const hits: string[] = [];
let server: http.Server;
let addr = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url} ${req.headers["x-vault-token"] ?? "-"} ${req.headers["x-vault-namespace"] ?? "-"}`);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const tokenOk = req.headers["x-vault-token"] === "root" || req.headers["x-vault-token"] === "approle-token";
      if (req.url === "/v1/auth/approle/login") {
        const b = JSON.parse(body);
        return b.role_id === "r" && b.secret_id === "s" ? send(200, { auth: { client_token: "approle-token" } }) : send(400, { errors: ["invalid role or secret ID"] });
      }
      if (!tokenOk) return send(403, { errors: ["permission denied"] });
      if (req.url === "/v1/auth/token/lookup-self") return send(200, { data: { display_name: "root", policies: ["root"], ttl: 7200 } });
      if (req.url === "/v1/secret/data/app/api") return send(200, { data: { data: { DB: "postgres://x", N: 5 } } });
      if (req.url === "/v1/secret/data/forbidden") return send(403, { errors: ["permission denied"] });
      if (req.url === "/v1/kv1/data/legacy") return send(404, {});
      if (req.url === "/v1/kv1/legacy") return send(200, { data: { K: "v1-value" } });
      if (req.url === "/v1/secret/data/boom") return send(404, {});
      if (req.url === "/v1/secret/boom") return send(500, { errors: ["internal"] });
      return send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  addr = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const cfg = (over: Partial<VaultConfig> = {}): VaultConfig => ({ addr, namespace: "", auth: "token", token: "root", roleId: "", secretId: "", caCert: "", ...over });

describe("parseVaultRef", () => {
  it("splits mount, path and field", () => {
    expect(parseVaultRef("secret/acme/api/#DB")).toEqual({ mount: "secret", path: "acme/api", field: "DB" });
    expect(() => parseVaultRef("secret#DB")).toThrow();
    expect(() => parseVaultRef("secret/../x#DB")).toThrow();
  });
});

describe("validateVaultAddr", () => {
  it("needs https except for localhost", () => {
    expect(validateVaultAddr("")).toBe("");
    expect(validateVaultAddr("https://vault.example.com:8200/")).toBe("https://vault.example.com:8200");
    expect(validateVaultAddr("http://127.0.0.1:8200")).toBe("http://127.0.0.1:8200");
    expect(() => validateVaultAddr("http://vault.example.com")).toThrow(/https/);
    expect(() => validateVaultAddr("nope")).toThrow(/address/);
    expect(() => validateVaultAddr("https://u:p@vault.example.com")).toThrow(/just scheme/);
  });
});

describe("loadVaultConfig", () => {
  it("returns null until an address is set, and decrypts credentials", async () => {
    mockPrisma.settings.findUnique.mockResolvedValueOnce(null);
    expect(await loadVaultConfig()).toBeNull();
    mockPrisma.settings.findUnique.mockResolvedValueOnce({ vaultAddr: "https://v/", vaultNamespace: "ns", vaultAuth: "approle", vaultToken: "", vaultRoleId: "r", vaultSecretId: encryptSecret("s"), vaultCaCert: "" });
    expect(await loadVaultConfig()).toEqual({ addr: "https://v", namespace: "ns", auth: "approle", token: "", roleId: "r", secretId: "s", caCert: "" });
  });
});

describe("VaultReader", () => {
  it("reads KV v2, caches the path and sends the namespace", async () => {
    hits.length = 0;
    const r = new VaultReader(cfg({ namespace: "team" }));
    expect(await r.read("secret/app/api#DB")).toBe("postgres://x");
    expect(await r.read("secret/app/api#N")).toBe("5");
    expect(hits).toEqual(["GET /v1/secret/data/app/api root team"]);
    await expect(r.read("secret/app/api#MISSING")).rejects.toThrow(/no field/);
  });

  it("falls back to KV v1", async () => {
    expect(await new VaultReader(cfg()).read("kv1/legacy#K")).toBe("v1-value");
  });

  it("explains denied, missing and failing paths", async () => {
    const r = new VaultReader(cfg());
    await expect(r.read("secret/forbidden#x")).rejects.toThrow(/denied/);
    await expect(r.read("secret/nothing#x")).rejects.toThrow(/doesn't exist/);
    await expect(r.read("secret/boom#x")).rejects.toThrow(/internal/);
  });

  it("logs in with AppRole", async () => {
    expect(await vaultToken(cfg({ auth: "approle", roleId: "r", secretId: "s" }))).toBe("approle-token");
    expect(await new VaultReader(cfg({ auth: "approle", roleId: "r", secretId: "s" })).read("secret/app/api#DB")).toBe("postgres://x");
    await expect(vaultToken(cfg({ auth: "approle", roleId: "r", secretId: "bad" }))).rejects.toThrow(/invalid role/);
    await expect(vaultToken(cfg({ auth: "approle" }))).rejects.toThrow(/role id/);
    await expect(vaultToken(cfg({ token: "" }))).rejects.toThrow(/No Vault token/);
  });

  it("reports an unreachable Vault", async () => {
    await expect(new VaultReader(cfg({ addr: "http://127.0.0.1:1" })).read("secret/a#b")).rejects.toThrow(/Can't reach Vault/);
  });
});

describe("testVault", () => {
  it("describes the token", async () => {
    expect(await testVault(cfg())).toBe("Connected as root (policies: root, expires in 2 h)");
    await expect(testVault(cfg({ token: "wrong" }))).rejects.toThrow(/rejected/);
  });
});
