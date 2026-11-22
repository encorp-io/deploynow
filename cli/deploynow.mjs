#!/usr/bin/env node
import { ApiError, client, findApp, followDeployment, HELP, loadConfig, parseArgs, saveConfig, table, TOKEN_RE } from "./lib.mjs";

const out = (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
const ago = (d) => {
  if (!d) return "never";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

/**
 * @param {string[]} argv
 * @param {{ fetchImpl?: any, env?: Record<string, string | undefined>, print?: (s: string) => unknown }} [opts]
 * @returns {Promise<number>}
 */
export async function main(argv, { fetchImpl = globalThis.fetch, env = process.env, print = out } = {}) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, ...args] = pos;
  if (!cmd || flags.help || cmd === "help") {
    print(HELP);
    return 0;
  }
  const show = (rows, cols) => print(flags.json ? JSON.stringify(rows, null, 2) : table(rows, cols));

  if (cmd === "login") {
    const url = String(flags.url || "").replace(/\/+$/, "");
    const token = String(flags.token || env.DEPLOYNOW_TOKEN || "");
    if (!/^https?:\/\//.test(url)) throw new ApiError(0, "Pass --url https://your-deploynow");
    if (!TOKEN_RE.test(token)) throw new ApiError(0, "Pass --token dn_… (create one under Account → API tokens)");
    const endpoints = await client({ url, token }, fetchImpl)("GET", "/endpoints");
    saveConfig({ url, token }, flags.config || undefined);
    print(`Signed in to ${url} (${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"} visible)`);
    return 0;
  }

  const api = client(loadConfig(flags, env, flags.config || undefined), fetchImpl);
  const need = (n, usage) => {
    if (args.length < n) throw new ApiError(0, `Usage: deploynow ${usage}`);
  };
  const appByRef = async (ref) => findApp(await api("GET", "/projects"), ref);

  switch (cmd) {
    case "endpoints": {
      const rows = await api("GET", "/endpoints");
      show(rows.map((e) => ({ id: e.id, name: e.name, type: e.type, status: e.status, host: e.host || e.agent?.hostname || "" })), ["id", "name", "type", "status", "host"]);
      return 0;
    }
    case "apps": {
      const projects = await api("GET", "/projects");
      const rows = [];
      for (const p of projects) for (const e of p.environments) for (const a of e.apps) rows.push({ id: a.id, app: `${p.slug}/${e.slug}/${a.name}`, source: a.sourceType, status: a.status });
      show(rows, ["id", "app", "source", "status"]);
      return 0;
    }
    case "deploy": {
      need(1, "deploy <app> [--commit <sha>] [--no-follow]");
      const app = await appByRef(args[0]);
      const dep = await api("POST", `/apps/${app.id}/deploy`, flags.commit ? { commitSha: String(flags.commit) } : {});
      print(`Deployment ${dep.id} of ${app.path} queued`);
      if (flags["no-follow"]) return 0;
      const final = await followDeployment(api, app.id, dep.id, (s) => process.stdout.write(s));
      print(`\n${final.status === "success" ? "✓" : "✗"} ${final.status}${final.error ? `: ${final.error}` : ""}`);
      return final.status === "success" ? 0 : 1;
    }
    case "deployments": {
      need(1, "deployments <app>");
      const app = await appByRef(args[0]);
      const rows = await api("GET", `/apps/${app.id}/deployments`);
      show(rows.slice(0, Number(flags.limit) || 20).map((d) => ({ id: d.id, status: d.status, trigger: d.trigger, commit: (d.commitSha || "").slice(0, 7), when: ago(d.createdAt), by: d.startedByEmail })), ["id", "status", "trigger", "commit", "when", "by"]);
      return 0;
    }
    case "rollback": {
      need(2, "rollback <app> <deployment-id>");
      const app = await appByRef(args[0]);
      const dep = await api("POST", `/apps/${app.id}/deployments/${args[1]}`, { action: "rollback" });
      print(`Rollback ${dep.id} queued`);
      if (flags["no-follow"]) return 0;
      const final = await followDeployment(api, app.id, dep.id, (s) => process.stdout.write(s));
      print(`\n${final.status === "success" ? "✓" : "✗"} ${final.status}`);
      return final.status === "success" ? 0 : 1;
    }
    case "logs": {
      need(2, "logs <endpoint> <container> [--tail 200]");
      const endpoints = await api("GET", "/endpoints");
      const ep = endpoints.find((e) => e.id === args[0] || e.name === args[0]);
      if (!ep) throw new ApiError(0, `No endpoint called "${args[0]}"`);
      const res = await api("GET", `/endpoints/${ep.id}/containers/${encodeURIComponent(args[1])}/logs?tail=${Number(flags.tail) || 200}`);
      print(res.text ?? "");
      return 0;
    }
    case "backups": {
      const rows = await api("GET", "/backups/policies");
      show(rows.map((p) => ({ id: p.id, name: p.name, schedule: p.schedule, enabled: p.enabled, last: p.lastStatus ? `${p.lastStatus} ${ago(p.lastRunAt)}` : "never" })), ["id", "name", "schedule", "enabled", "last"]);
      return 0;
    }
    case "backup": {
      need(1, "backup <policy-id>");
      const run = await api("POST", `/backups/policies/${args[0]}`, { action: "run" });
      print(`Backup run ${run.runId} queued`);
      return 0;
    }
    case "tasks": {
      const rows = await api("GET", "/tasks");
      show(rows.map((t) => ({ id: t.id, name: t.name, schedule: t.schedule, mode: t.mode, last: t.lastStatus ? `${t.lastStatus} ${ago(t.lastRunAt)}` : "never" })), ["id", "name", "schedule", "mode", "last"]);
      return 0;
    }
    case "run-task": {
      need(1, "run-task <task-id>");
      const run = await api("POST", `/tasks/${args[0]}`);
      print(`${run.status ?? "started"}${run.exitCode !== undefined && run.exitCode !== null ? ` (exit ${run.exitCode})` : ""}`);
      if (run.log) print(run.log);
      return run.status === "failed" ? 1 : 0;
    }
    case "alerts": {
      const m = await api("GET", "/monitoring");
      const active = m.active ?? [];
      show(active.map((a) => ({ kind: a.kind, message: a.message, since: ago(a.firedAt) })), ["kind", "message", "since"]);
      return 0;
    }
    case "api": {
      need(2, "api <METHOD> <path> [json]");
      const method = args[0].toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new ApiError(0, "Method must be GET, POST, PUT, PATCH or DELETE");
      const p = args[1].startsWith("/api/") ? args[1].slice(4) : args[1].startsWith("/") ? args[1] : `/${args[1]}`;
      let body;
      if (args[2]) {
        try {
          body = JSON.parse(args[2]);
        } catch {
          throw new ApiError(0, "The body must be JSON");
        }
      }
      print(JSON.stringify(await api(method, p, body), null, 2));
      return 0;
    }
    default:
      throw new ApiError(0, `Unknown command "${cmd}". Run deploynow help.`);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/deploynow");
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`deploynow: ${err.message}\n`);
      process.exit(err instanceof ApiError && err.status === 0 ? 2 : 1);
    },
  );
}
