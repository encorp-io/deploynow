import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { OPERATIONS, openApiDocument } from "@/lib/openapi";

const API = path.join(process.cwd(), "src/app/api");
// Not part of the public API
const SKIP = [/^\/auth\//, /^\/account(\/|$)/, /^\/team$/, /^\/openapi\.json$/, /^\/sso\/(login|callback)/, /^\/passkeys(\/|$)/];

function routes(): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") {
        const rel = "/" + path.relative(API, dir).split(path.sep).join("/");
        const route = rel.replace(/\[(\w+)\]/g, "{$1}").replace("{cid}", "{cid}");
        for (const m of fs.readFileSync(p, "utf8").matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)/g)) out.push({ method: m[1].toLowerCase(), path: route });
      }
    }
  };
  walk(API);
  return out.filter((r) => !SKIP.some((s) => s.test(r.path)));
}

describe("OpenAPI description", () => {
  it("covers every route handler, and nothing that doesn't exist", () => {
    const actual = new Set(routes().map((r) => `${r.method} ${r.path}`));
    const listed = new Set(OPERATIONS.map((o) => `${o.method} ${o.path}`));
    expect([...actual].filter((r) => !listed.has(r)).sort()).toEqual([]);
    expect([...listed].filter((r) => !actual.has(r)).sort()).toEqual([]);
  });

  it("is a valid-looking OpenAPI 3.1 document", () => {
    const doc = openApiDocument();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.components.securitySchemes.bearer.scheme).toBe("bearer");
    const ids = Object.values(doc.paths).flatMap((m) => Object.values(m).map((o) => (o as { operationId: string }).operationId));
    expect(new Set(ids).size).toBe(ids.length);
    const webhook = doc.paths["/webhooks/github/{appId}"].post as { security: unknown[] };
    expect(webhook.security).toEqual([]);
  });
});
