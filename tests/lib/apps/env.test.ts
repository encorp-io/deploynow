import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: { settings: { findUnique: vi.fn().mockResolvedValue(null) } } }));
import { envForClient, makeMasker, parseEnvInput, readStoredEnv, resolveEnv } from "@/lib/apps/env";
import { decryptSecret, encryptSecret } from "@/lib/secretsCrypto";

describe("readStoredEnv", () => {
  it("tolerates junk", () => {
    expect(readStoredEnv("not json")).toEqual([]);
    expect(readStoredEnv('{"a":1}')).toEqual([]);
    expect(readStoredEnv('[{"key":"A","kind":"weird","value":1},null]')).toEqual([{ key: "A", kind: "plain", value: "1" }]);
  });
});

describe("parseEnvInput", () => {
  it("keeps plain values and encrypts secrets", () => {
    const out = parseEnvInput([{ key: "A", value: "1" }, { key: "B", kind: "secret", value: "hunter2" }, { key: "", value: "skip" }]);
    expect(out[0]).toEqual({ key: "A", kind: "plain", value: "1" });
    expect(out[1].kind).toBe("secret");
    expect(out[1].value).not.toContain("hunter2");
    expect(decryptSecret(out[1].value)).toBe("hunter2");
    expect(out).toHaveLength(2);
  });

  it("keeps a stored secret when the value is left out", () => {
    const stored = JSON.stringify([{ key: "B", kind: "secret", value: encryptSecret("old") }]);
    const out = parseEnvInput([{ key: "B", kind: "secret", value: null }], stored);
    expect(decryptSecret(out[0].value)).toBe("old");
  });

  it("turns a plain value into a secret without retyping it", () => {
    const stored = JSON.stringify([{ key: "B", kind: "plain", value: "abc" }]);
    expect(decryptSecret(parseEnvInput([{ key: "B", kind: "secret" }], stored)[0].value)).toBe("abc");
  });

  it("requires a value for a new secret", () => {
    expect(() => parseEnvInput([{ key: "B", kind: "secret", value: "" }])).toThrow(/Enter a value/);
  });

  it("validates Vault references", () => {
    expect(parseEnvInput([{ key: "V", kind: "vault", value: " secret/app#DB " }])[0]).toEqual({ key: "V", kind: "vault", value: "secret/app#DB" });
    expect(() => parseEnvInput([{ key: "V", kind: "vault", value: "nope" }])).toThrow(/Vault reference/);
    expect(() => parseEnvInput([{ key: "V", kind: "vault", value: "secret/../x#a" }])).toThrow();
  });

  it("rejects bad names, duplicates and non-lists", () => {
    expect(() => parseEnvInput([{ key: "1A", value: "" }])).toThrow(/Invalid variable/);
    expect(() => parseEnvInput([{ key: "A" }, { key: "A" }])).toThrow(/twice/);
    expect(() => parseEnvInput("{")).toThrow(/list/);
    expect(() => parseEnvInput({})).toThrow(/list/);
    expect(() => parseEnvInput([{ key: "A", value: "x".repeat(70_000) }])).toThrow(/64 KB/);
    expect(parseEnvInput('[{"key":"A","value":"1"}]')).toHaveLength(1);
  });
});

describe("envForClient", () => {
  it("never returns secret values", () => {
    const stored = JSON.stringify([{ key: "A", kind: "plain", value: "1" }, { key: "B", kind: "secret", value: encryptSecret("s") }]);
    expect(envForClient(stored)).toEqual([{ key: "A", kind: "plain", value: "1" }, { key: "B", kind: "secret", value: null, hasValue: true }]);
  });
});

describe("resolveEnv", () => {
  it("decrypts secrets, reads Vault and lists sensitive values", async () => {
    const vault = { read: vi.fn().mockResolvedValue("from-vault") };
    const r = await resolveEnv(
      [{ key: "A", kind: "plain", value: "1" }, { key: "B", kind: "secret", value: encryptSecret("sec") }, { key: "C", kind: "vault", value: "secret/x#y" }],
      { vault: vault as never },
    );
    expect(r.vars).toEqual([{ key: "A", value: "1" }, { key: "B", value: "sec" }, { key: "C", value: "from-vault" }]);
    expect(r.sensitive).toEqual(["sec", "from-vault"]);
  });

  it("explains a secret that can't be decrypted", async () => {
    await expect(resolveEnv([{ key: "B", kind: "secret", value: "garbage" }])).rejects.toThrow(/AUTH_SECRET/);
  });

  it("explains missing Vault settings", async () => {
    await expect(resolveEnv([{ key: "C", kind: "vault", value: "secret/x#y" }])).rejects.toThrow(/isn't set up/);
  });
});

describe("makeMasker", () => {
  it("masks longest values first and ignores short ones", () => {
    const mask = makeMasker(["abcd", "abcdef", "ab"]);
    expect(mask("x abcdef abcd ab")).toBe("x *** *** ab");
    expect(makeMasker([])("same")).toBe("same");
  });
});
