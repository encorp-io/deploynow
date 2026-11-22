import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
// @ts-expect-error plain ESM without types
import { client, findApp, followDeployment, loadConfig, parseArgs, saveConfig, table } from "../../cli/lib.mjs";
// @ts-expect-error plain ESM without types
import { main } from "../../cli/deploynow.mjs";

const TOKEN = "dn_" + "a".repeat(43);
const projects = [
  { id: "p1", slug: "shop", environments: [{ id: "e1", slug: "prod", apps: [{ id: "a1", name: "web", status: "running", sourceType: "image" }, { id: "a2", name: "api", status: "running", sourceType: "git" }] }, { id: "e2", slug: "staging", apps: [{ id: "a3", name: "web", status: "stopped", sourceType: "image" }] }] },
];

function fakeFetch(routes: Record<string, (body: unknown) => unknown>) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const key = `${init.method} ${url.replace(/^https:\/\/dn\.test\/api/, "")}`;
    const h = routes[key];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    if (!h) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 404 });
    return new Response(JSON.stringify(h(init.body ? JSON.parse(String(init.body)) : undefined)), { status: 200 });
  });
}

describe("CLI helpers", () => {
  it("parses flags and positionals", () => {
    expect(parseArgs(["deploy", "shop/prod/web", "--commit", "abc", "--no-follow", "--x=1"])).toEqual({ pos: ["deploy", "shop/prod/web"], flags: { commit: "abc", "no-follow": true, x: "1" } });
    expect(parseArgs(["api", "--", "GET", "--weird"]).pos).toEqual(["api", "GET", "--weird"]);
  });

  it("saves the config privately and reads flags over env over file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-cli-"));
    const file = path.join(dir, "deploynow", "config.json");
    saveConfig({ url: "https://saved", token: TOKEN }, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(loadConfig({}, {}, file)).toEqual({ url: "https://saved", token: TOKEN });
    expect(loadConfig({}, { DEPLOYNOW_URL: "https://env/" }, file).url).toBe("https://env");
    expect(loadConfig({ url: "https://flag" }, { DEPLOYNOW_URL: "https://env" }, file).url).toBe("https://flag");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds apps by id, name or path and refuses ambiguity", () => {
    expect(findApp(projects, "a2").name).toBe("api");
    expect(findApp(projects, "api").id).toBe("a2");
    expect(findApp(projects, "shop/staging/web").id).toBe("a3");
    expect(() => findApp(projects, "web")).toThrow(/matches 2 apps/);
    expect(() => findApp(projects, "nope")).toThrow(/No app/);
  });

  it("renders tables", () => {
    expect(table([], ["a"])).toBe("(none)");
    expect(table([{ id: "1", name: "x" }], ["id", "name"])).toBe("ID  NAME\n1   x");
  });

  it("needs a URL and token, and surfaces API errors", async () => {
    expect(() => client({ url: "", token: TOKEN })).toThrow(/No server/);
    expect(() => client({ url: "https://dn.test", token: "" })).toThrow(/No API token/);
    const api = client({ url: "https://dn.test", token: TOKEN }, fakeFetch({}));
    await expect(api("GET", "/x")).rejects.toThrow(/no route GET \/x/);
  });

  it("follows a deployment log until it finishes", async () => {
    let n = 0;
    const api = vi.fn(async () => (++n < 3 ? { status: "running", log: `line${n}\n`, next: n * 6 } : { status: "success", log: "done\n", next: 99 }));
    const chunks: string[] = [];
    const final = await followDeployment(api, "a1", "d1", (s: string) => chunks.push(s), { sleep: async () => {} });
    expect(final.status).toBe("success");
    expect(chunks.join("")).toBe("line1\nline2\ndone\n");
    expect(api).toHaveBeenLastCalledWith("GET", "/apps/a1/deployments/d1?offset=12");
  });
});

describe("CLI commands", () => {
  const env = { DEPLOYNOW_URL: "https://dn.test", DEPLOYNOW_TOKEN: TOKEN, XDG_CONFIG_HOME: os.tmpdir() };

  it("lists apps and endpoints", async () => {
    const lines: string[] = [];
    const fetchImpl = fakeFetch({ "GET /projects": () => projects, "GET /endpoints": () => [{ id: "e1", name: "prod-1", type: "agent", status: "online", host: "" }] });
    expect(await main(["apps"], { fetchImpl, env, print: (s: string) => lines.push(s) })).toBe(0);
    expect(lines[0]).toContain("shop/prod/web");
    expect(await main(["endpoints", "--json"], { fetchImpl, env, print: (s: string) => lines.push(s) })).toBe(0);
    expect(JSON.parse(lines[1])[0].name).toBe("prod-1");
  });

  it("deploys an app without following", async () => {
    const lines: string[] = [];
    const deploy = vi.fn(() => ({ id: "d1", status: "queued" }));
    const fetchImpl = fakeFetch({ "GET /projects": () => projects, "POST /apps/a2/deploy": deploy });
    expect(await main(["deploy", "shop/prod/api", "--commit", "abcdef1", "--no-follow"], { fetchImpl, env, print: (s: string) => lines.push(s) })).toBe(0);
    expect(deploy).toHaveBeenCalledWith({ commitSha: "abcdef1" });
    expect(lines[0]).toMatch(/Deployment d1 of shop\/prod\/api queued/);
  });

  it("runs tasks, backups and raw API calls", async () => {
    const lines: string[] = [];
    const fetchImpl = fakeFetch({
      "POST /tasks/t1": () => ({ status: "failed", exitCode: 3, log: "boom" }),
      "POST /backups/policies/p1": () => ({ runId: "r1" }),
      "GET /monitoring": () => ({ active: [{ kind: "disk", message: "Disk 95%", firedAt: new Date().toISOString() }] }),
      "PATCH /tasks/t1": (b) => ({ echoed: b }),
    });
    const print = (s: string) => lines.push(s);
    expect(await main(["run-task", "t1"], { fetchImpl, env, print })).toBe(1);
    expect(lines).toContain("failed (exit 3)");
    expect(await main(["backup", "p1"], { fetchImpl, env, print })).toBe(0);
    expect(lines).toContain("Backup run r1 queued");
    await main(["alerts"], { fetchImpl, env, print });
    expect(lines.at(-1)).toContain("Disk 95%");
    await main(["api", "patch", "/api/tasks/t1", '{"enabled":false}'], { fetchImpl, env, print });
    expect(JSON.parse(lines.at(-1)!)).toEqual({ echoed: { enabled: false } });
  });

  it("validates login and unknown commands", async () => {
    await expect(main(["login", "--url", "nope"], { env: {} })).rejects.toThrow(/--url/);
    await expect(main(["login", "--url", "https://dn.test", "--token", "x"], { env: {} })).rejects.toThrow(/--token/);
    await expect(main(["frobnicate"], { env, fetchImpl: fakeFetch({}) })).rejects.toThrow(/Unknown command/);
    const lines: string[] = [];
    expect(await main([], { env, print: (s: string) => lines.push(s) })).toBe(0);
    expect(lines[0]).toMatch(/Usage/);
  });
});
