import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "yaml";
import { findTemplate, generateValue, instantiate, TEMPLATES, templateForClient } from "@/lib/templates";
import { renderCompose } from "@/lib/deploy/compose";
import { validateAppInput } from "@/lib/apps/config";
import { validateSources } from "@/lib/backup/config";

function hasCompose() {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("templates", () => {
  it("have unique ids and only ${VAR}s they define", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) {
      const used = [...t.compose.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
      const defined = new Set(t.vars.map((v) => v.key));
      for (const u of used) expect(defined.has(u), `${t.id} uses ${u}`).toBe(true);
    }
  });

  it("render, validate and back up for every template", () => {
    for (const t of TEMPLATES) {
      const made = instantiate(t, { slug: `t-${t.id}`, domain: t.web ? `${t.id}.example.com` : undefined, values: { ADMIN_EMAIL: "a@example.com" } });
      const input = validateAppInput({ name: t.name, slug: `t-${t.id}`, sourceType: "compose", composeInline: made.composeInline, env: made.env });
      expect(input.sourceType).toBe("compose");
      const r = renderCompose({ compose: made.composeInline, appId: "app1", slug: `t-${t.id}`, deploymentId: "dep1234567890", domains: made.domain ? [{ id: "d1234567890", path: "/", ...made.domain }] : [], proxyNetwork: "dn-proxy" });
      if (t.web) expect(r.services).toContain(t.web.service);
      if (t.backup?.db) expect(r.services).toContain(t.backup.db.service);
      if (made.backupSources.length) expect(validateSources(made.backupSources, false).length).toBe(made.backupSources.length);
      for (const v of t.backup?.volumes ?? []) expect(Object.keys((YAML.parse(t.compose).volumes ?? {}) as object)).toContain(v);
    }
  });

  it.skipIf(!hasCompose())("pass docker compose config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-tpl-"));
    try {
      for (const t of TEMPLATES) {
        const made = instantiate(t, { slug: `t-${t.id}`, hostPort: t.web || t.publish ? 18080 : null, values: { ADMIN_EMAIL: "a@example.com" } });
        const file = path.join(dir, `${t.id}.yml`);
        fs.writeFileSync(file, made.composeInline);
        const env = Object.fromEntries(made.env.map((e) => [e.key, e.value]));
        execFileSync("docker", ["compose", "-p", `t-${t.id}`, "-f", file, "config", "-q"], { env: { ...process.env, ...env }, stdio: "pipe" });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fills in the address, generates secrets and keeps answers", () => {
    const t = findTemplate("n8n")!;
    const made = instantiate(t, { slug: "flows", domain: "n8n.example.com", values: { TZ: "UTC", DB_PASSWORD: "ignored-not-asked" } });
    const env = Object.fromEntries(made.env.map((e) => [e.key, e]));
    expect(env.PUBLIC_URL.value).toBe("https://n8n.example.com");
    expect(env.DOMAIN.value).toBe("n8n.example.com");
    expect(env.TZ.value).toBe("UTC");
    expect(env.DB_PASSWORD).toMatchObject({ kind: "secret" });
    expect(env.DB_PASSWORD.value).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(env.N8N_ENCRYPTION_KEY.value).toMatch(/^[0-9a-f]{64}$/);
    expect(made.domain).toEqual({ host: "n8n.example.com", containerPort: 5678, service: "n8n", https: true });
    expect(made.backupSources).toEqual([
      { type: "db", engine: "postgres", container: "flows-db-1", database: "n8n" },
      { type: "volume", name: "flows_data" },
    ]);
    expect(made.backupMode).toBe("dump");
  });

  it("publishes a host port when there is no domain", () => {
    const made = instantiate(findTemplate("postgres")!, { slug: "pg", hostPort: 15432, serverHost: "10.0.0.5" });
    expect(YAML.parse(made.composeInline).services.db.ports).toEqual(["15432:5432"]);
    const url = instantiate(findTemplate("grafana")!, { slug: "g", hostPort: 3000, serverHost: "srv.example.com" }).env.find((e) => e.key === "PUBLIC_URL");
    expect(url?.value).toBe("http://srv.example.com:3000");
  });

  it("rejects bad input", () => {
    expect(() => instantiate(findTemplate("postgres")!, { slug: "pg", domain: "db.example.com" })).toThrow(/no web interface/);
    expect(() => instantiate(findTemplate("grafana")!, { slug: "g", hostPort: 70000 })).toThrow(/host port/);
    expect(() => instantiate(findTemplate("pgadmin")!, { slug: "p", values: { ADMIN_EMAIL: "" } })).not.toThrow();
    expect(() => instantiate(findTemplate("postgres")!, { slug: "pg", values: { POSTGRES_DB: "a\nb" } })).toThrow(/one line/);
  });

  it("never sends secrets or unasked values to the browser", () => {
    const c = templateForClient(findTemplate("n8n")!);
    expect(c.vars.map((v) => v.key)).toEqual(["TZ"]);
    expect(generateValue("password")).not.toBe(generateValue("password"));
  });
});
