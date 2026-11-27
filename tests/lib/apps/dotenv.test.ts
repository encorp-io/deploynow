import { describe, it, expect } from "vitest";
import { applyImport, looksSecret, parseDotenv, planImport, quoteDotenvValue, serializeDotenv, type EnvRowLike } from "@/lib/apps/dotenv";

const kv = (text: string) => Object.fromEntries(parseDotenv(text).entries.map((e) => [e.key, e.value]));

describe("parseDotenv", () => {
  it("reads plain lines, comments, export and spacing", () => {
    expect(kv("# top\n\nA=1\nexport B = two words  \nC=\n  D=x # note\nE=a#b\n")).toEqual({ A: "1", B: "two words", C: "", D: "x", E: "a#b" });
  });

  it("handles quotes and escapes", () => {
    const out = kv(`A="a b" # c\nB='it''s'\nC='lit $X \\n'\nD="l1\\nl2 \\"q\\" \\$HOME"\nE=\`back\``);
    expect(out.A).toBe("a b");
    expect(out.C).toBe("lit $X \\n");
    expect(out.D).toBe('l1\nl2 "q" $HOME');
    expect(out.E).toBe("back");
    expect(parseDotenv(`B='it''s'`).errors[0].message).toMatch(/after the closing quote/);
  });

  it("reads multi-line quoted values", () => {
    const r = parseDotenv('KEY="-----BEGIN\nabc\n-----END"\nNEXT=1');
    expect(r.entries).toEqual([{ key: "KEY", value: "-----BEGIN\nabc\n-----END", line: 1 }, { key: "NEXT", value: "1", line: 4 }]);
  });

  it("copes with CRLF and a BOM", () => {
    expect(kv('\uFEFFA=1\r\nB="2"\r\n')).toEqual({ A: "1", B: "2" });
  });

  it("reports bad lines and keeps going", () => {
    const r = parseDotenv('just text\n1BAD=x\nexport ONLY\nU="open\nOK=1');
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3, 4]);
    expect(r.errors[3].message).toMatch(/never closed/);
    // An unclosed quote doesn't swallow the following lines
    expect(r.entries.map((e) => e.key)).toEqual(["OK"]);
  });

  it("lets the last duplicate win", () => {
    const r = parseDotenv("A=1\nB=2\nA=3");
    expect(r.entries.map((e) => [e.key, e.value])).toEqual([["B", "2"], ["A", "3"]]);
    expect(r.duplicates).toEqual(["A"]);
  });
});

describe("looksSecret", () => {
  it("spots credentials", () => {
    for (const k of ["DB_PASSWORD", "API_KEY", "GITHUB_TOKEN", "JWT_SECRET", "STRIPE_KEY", "SENTRY_DSN", "AWS_SECRET_ACCESS_KEY"]) expect(looksSecret(k), k).toBe(true);
    for (const k of ["PORT", "LOG_LEVEL", "NODE_ENV", "KEYBOARD_LAYOUT", "MONKEY"]) expect(looksSecret(k), k).toBe(false);
  });
});

describe("planImport / applyImport", () => {
  const rows: EnvRowLike[] = [
    { key: "PORT", kind: "plain", value: "3000" },
    { key: "DB_PASSWORD", kind: "secret", value: null, hasValue: true },
    { key: "VAULTED", kind: "vault", value: "secret/app#x" },
    { key: "OLD", kind: "plain", value: "1" },
  ];
  const entries = parseDotenv("PORT=3000\nDB_PASSWORD=new\nVAULTED=v\nAPI_TOKEN=t\nHOST=0.0.0.0").entries;

  it("merges with the file winning", () => {
    const plan = planImport(rows, entries, "merge");
    expect(Object.fromEntries(plan.items.map((i) => [i.key, `${i.status}:${i.kind}`]))).toEqual({
      PORT: "same:plain",
      DB_PASSWORD: "update:secret",
      VAULTED: "update:secret",
      API_TOKEN: "new:secret",
      HOST: "new:plain",
    });
    expect(plan.removed).toEqual([]);
    expect(applyImport(rows, plan)).toEqual([
      { key: "PORT", kind: "plain", value: "3000" },
      { key: "DB_PASSWORD", kind: "secret", value: "new" },
      { key: "VAULTED", kind: "secret", value: "v" },
      { key: "OLD", kind: "plain", value: "1" },
      { key: "API_TOKEN", kind: "secret", value: "t" },
      { key: "HOST", kind: "plain", value: "0.0.0.0" },
    ]);
  });

  it("keeps existing values in keep mode", () => {
    const next = applyImport(rows, planImport(rows, entries, "keep"));
    expect(next.slice(0, 4)).toEqual(rows);
    expect(next.map((r) => r.key)).toEqual(["PORT", "DB_PASSWORD", "VAULTED", "OLD", "API_TOKEN", "HOST"]);
  });

  it("removes what isn't in the file in replace mode", () => {
    const plan = planImport(rows, entries, "replace");
    expect(plan.removed).toEqual(["OLD"]);
    expect(applyImport(rows, plan).map((r) => r.key)).toEqual(["PORT", "DB_PASSWORD", "VAULTED", "API_TOKEN", "HOST"]);
  });

  it("honours a kind the user picked", () => {
    const plan = planImport(rows, entries, "merge", { HOST: "secret", PORT: "secret" });
    expect(plan.items.find((i) => i.key === "HOST")!.kind).toBe("secret");
    expect(plan.items.find((i) => i.key === "PORT")!.status).toBe("update");
  });

  it("moves blank editor rows last and doesn't duplicate keys", () => {
    const next = applyImport([{ key: "", kind: "plain", value: "" }, { key: "A", kind: "plain", value: "1" }], planImport([], parseDotenv("A=2\nB=3").entries, "merge"));
    expect(next.map((r) => r.key)).toEqual(["A", "B", ""]);
  });
});

describe("serializeDotenv", () => {
  it("round-trips awkward values", () => {
    const vars = [
      { key: "A", value: "plain" },
      { key: "B", value: "has 'single' and $X and \\ and \"dq\"" },
      { key: "C", value: "line1\nline2" },
      { key: "D", value: "$NOT_EXPANDED" },
      { key: "E", value: "" },
    ];
    const text = serializeDotenv(vars);
    expect(quoteDotenvValue("$X")).toBe("'$X'");
    expect(Object.fromEntries(parseDotenv(text).entries.map((e) => [e.key, e.value]))).toEqual(Object.fromEntries(vars.map((v) => [v.key, v.value])));
  });
});

describe("empty values", () => {
  it("import as plain so an existing secret is cleared and a new one isn't rejected", () => {
    const rows: EnvRowLike[] = [{ key: "DB_PASSWORD", kind: "secret", value: null, hasValue: true }];
    const plan = planImport(rows, parseDotenv("DB_PASSWORD=\nAPI_TOKEN=").entries, "merge", { API_TOKEN: "secret" });
    expect(plan.items.map((i) => [i.key, i.kind, i.status])).toEqual([["DB_PASSWORD", "plain", "update"], ["API_TOKEN", "plain", "new"]]);
    expect(applyImport(rows, plan)[0]).toEqual({ key: "DB_PASSWORD", kind: "plain", value: "" });
  });
});
