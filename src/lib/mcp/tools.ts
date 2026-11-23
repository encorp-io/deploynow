/**
 * The tools DeployNow offers AI assistants over MCP.
 *
 * Each tool calls the same route handler the REST API and the UI use, inside the
 * MCP request, so it gets the same permission checks, validation and audit
 * events. Nothing here talks to Docker or the database directly. The caller's
 * identity comes from the MCP request's own Authorization header, which the
 * route handlers read.
 *
 * Left out on purpose: deleting anything, revealing secrets, exec, restores,
 * and changing users or settings. Those stay with a person in the UI.
 */
import { normalizeRole, roleAtLeast, type Role } from "../rbac";
import * as endpointsRoute from "@/app/api/endpoints/route";
import * as containersRoute from "@/app/api/endpoints/[id]/containers/route";
import * as containerRoute from "@/app/api/endpoints/[id]/containers/[cid]/route";
import * as logsRoute from "@/app/api/endpoints/[id]/containers/[cid]/logs/route";
import * as statsRoute from "@/app/api/endpoints/[id]/containers/[cid]/stats/route";
import * as metricsRoute from "@/app/api/endpoints/[id]/metrics/route";
import * as projectsRoute from "@/app/api/projects/route";
import * as appRoute from "@/app/api/apps/[id]/route";
import * as deployRoute from "@/app/api/apps/[id]/deploy/route";
import * as deploymentsRoute from "@/app/api/apps/[id]/deployments/route";
import * as deploymentRoute from "@/app/api/apps/[id]/deployments/[depId]/route";
import * as monitoringRoute from "@/app/api/monitoring/route";
import * as policiesRoute from "@/app/api/backups/policies/route";
import * as policyRoute from "@/app/api/backups/policies/[id]/route";
import * as runsRoute from "@/app/api/backups/runs/route";
import * as runRoute from "@/app/api/backups/runs/[id]/route";
import * as tasksRoute from "@/app/api/tasks/route";
import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as activityRoute from "@/app/api/activity/route";

// Route handlers type their params precisely; here they are called generically
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: Request, ctx: { params: Promise<any> }) => Promise<Response> | Response;
type JsonSchema = Record<string, unknown>;

export interface ToolContext {
  /** The MCP request, whose headers (Authorization, client IP) are passed on */
  request: Request;
  origin: string;
}

export class ToolError extends Error {}

export interface Tool {
  name: string;
  title: string;
  description: string;
  /** The lowest role that can use the tool; the route handler checks again */
  minRole: Role;
  readOnly: boolean;
  destructive?: boolean;
  inputSchema: JsonSchema;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

const FORWARD = ["authorization", "x-real-ip", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "host", "user-agent"];

/** Call a route handler in-process and return its JSON, or throw its error message. */
async function call(
  handler: Handler | undefined,
  ctx: ToolContext,
  path: string,
  opts: { method?: string; params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown } = {},
): Promise<unknown> {
  if (!handler) throw new ToolError("That operation isn't available");
  const url = new URL(`/api${path}`, ctx.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const headers = new Headers();
  for (const h of FORWARD) {
    const v = ctx.request.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const req = new Request(url, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `Request failed (${res.status})`;
    throw new ToolError(msg);
  }
  return data;
}

// ── argument helpers ──────────────────────────────────────────────────────────

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`${key} is required`);
    return "";
  }
  if (typeof v !== "string" && typeof v !== "number") throw new ToolError(`${key} must be a string`);
  const s = String(v).trim();
  if (s.length > 200 || /[/?#\\]/.test(s)) throw new ToolError(`${key} is not a valid id`);
  return s;
}

function num(args: Record<string, unknown>, key: string, min: number, max: number, dflt: number): number {
  const v = args[key];
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`${key} must be a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const S = (description: string): JsonSchema => ({ type: "string", description });
const N = (description: string, minimum: number, maximum: number): JsonSchema => ({ type: "integer", description, minimum, maximum });

const endpointId = S("Endpoint id, from list_endpoints");
const containerId = S("Container id or name, from list_containers");
const appId = S("App id, from list_projects");
const deploymentId = S("Deployment id, from list_deployments");

/** Downsample metric series so a week of samples doesn't flood the conversation. */
function thin<T>(rows: T[], max = 60): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  return Array.from({ length: max }, (_, i) => rows[Math.floor(i * step)]).concat(rows[rows.length - 1]);
}

// ── the tools ─────────────────────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    name: "list_endpoints",
    title: "List endpoints",
    description: "List the Docker hosts (endpoints) DeployNow manages, with their status and Docker details.",
    minRole: "viewer",
    readOnly: true,
    inputSchema: obj({}),
    run: (_a, ctx) => call(endpointsRoute.GET as Handler, ctx, "/endpoints"),
  },
  {
    name: "list_containers",
    title: "List containers",
    description: "List every container on an endpoint, running or not, with image, state, ports and compose project.",
    minRole: "viewer",
    readOnly: true,
    inputSchema: obj({ endpointId }, ["endpointId"]),
    run: (a, ctx) => call(containersRoute.GET as Handler, ctx, `/endpoints/${str(a, "endpointId")}/containers`, { params: { id: str(a, "endpointId") } }),
  },
  {
    name: "inspect_container",
    title: "Inspect a container",
    description: "Show one container's state, health, restart count, command, ports, mounts and networks. Environment variable names are listed; their values are always hidden.",
    minRole: "viewer",
    readOnly: true,
    inputSchema: obj({ endpointId, containerId }, ["endpointId", "containerId"]),
    run: async (a, ctx) => {
      const id = str(a, "endpointId");
      const cid = str(a, "containerId");
      const data = (await call(containerRoute.GET as Handler, ctx, `/endpoints/${id}/containers/${cid}`, { params: { id, cid } })) as Record<string, unknown>;
      // Env values can hold secrets: an AI app never sees them
      if (Array.isArray(data.env)) data.env = (data.env as { key: string }[]).map((e) => ({ key: e.key, value: null }));
      data.envHidden = true;
      return data;
    },
  },
  {
    name: "container_stats",
    title: "Container resource usage",
    description: "Current CPU, memory, network and disk I/O of one running container.",
    minRole: "viewer",
    readOnly: true,
    inputSchema: obj({ endpointId, containerId }, ["endpointId", "containerId"]),
    run: (a, ctx) => {
      const id = str(a, "endpointId");
      const cid = str(a, "containerId");
      return call(statsRoute.GET as Handler, ctx, `/endpoints/${id}/containers/${cid}/stats`, { params: { id, cid } });
    },
  },
  {
    name: "host_metrics",
    title: "Host metrics",
    description: "CPU load, memory and disk use of an endpoint over the last hours (at most 60 points).",
    minRole: "viewer",
    readOnly: true,
    inputSchema: obj({ endpointId, hours: N("How many hours back, 1 to 168 (default 24)", 1, 168) }, ["endpointId"]),
    run: async (a, ctx) => {
      const id = str(a, "endpointId");
      const rows = (await call(metricsRoute.GET as Handler, ctx, `/endpoints/${id}/metrics`, { params: { id }, query: { hours: num(a, "hours", 1, 168, 24) } })) as unknown[];
      return thin(rows);
    },
  },
  {
    name: "list_projects",
    title: "List projects and apps",
    description: "List projects with their environments and the apps in each, including app ids, status and endpoint.",
    minRole: "viewer",
    readOnly: true,
    inputSchema: obj({}),
    run: (_a, ctx) => call(projectsRoute.GET as Handler, ctx, "/projects"),
  },
  {
    name: "get_app",
    title: "Get an app",
    description: "Show an app's source, image, domains, ports, volumes, status, live containers and environment variables. Secret values are never included.",
    minRole: "viewer",
    readOnly: true,
    inputSchema: obj({ appId }, ["appId"]),
    run: (a, ctx) => call(appRoute.GET as Handler, ctx, `/apps/${str(a, "appId")}`, { params: { id: str(a, "appId") } }),
  },
  {
    name: "list_deployments",
    title: "List deployments",
    description: "An app's recent deployments, newest first, with status, trigger, commit and who started them.",
    minRole: "viewer",
    readOnly: true,
    inputSchema: obj({ appId, limit: N("How many (default 20)", 1, 100) }, ["appId"]),
    run: (a, ctx) => call(deploymentsRoute.GET as Handler, ctx, `/apps/${str(a, "appId")}/deployments`, { params: { id: str(a, "appId") }, query: { limit: num(a, "limit", 1, 100, 20) } }),
  },
  {
    name: "get_monitoring",
    title: "Alerts and host usage",
    description: "Active and recent alerts (disk, memory, crash loops, unreachable hosts) and current host usage.",
    minRole: "viewer",
    readOnly: true,
    inputSchema: obj({}),
    run: (_a, ctx) => call(monitoringRoute.GET as Handler, ctx, "/monitoring"),
  },

  // ── operator ──
  {
    name: "get_deployment",
    title: "Get a deployment and its log",
    description: "One deployment's status and build/deploy log. Secrets are masked in the log. Pass offset to read on from where a previous call stopped.",
    minRole: "operator",
    readOnly: true,
    inputSchema: obj({ appId, deploymentId, offset: N("Log byte offset to continue from", 0, 1e9) }, ["appId", "deploymentId"]),
    run: (a, ctx) => {
      const id = str(a, "appId");
      const depId = str(a, "deploymentId");
      return call(deploymentRoute.GET as Handler, ctx, `/apps/${id}/deployments/${depId}`, { params: { id, depId }, query: { offset: num(a, "offset", 0, 1e9, 0) } });
    },
  },
  {
    name: "container_logs",
    title: "Container logs",
    description: "The last lines of a container's stdout and stderr.",
    minRole: "operator",
    readOnly: true,
    inputSchema: obj({ endpointId, containerId, tail: N("How many lines (default 200, at most 2000)", 1, 2000), timestamps: { type: "boolean", description: "Prefix each line with its time" } }, ["endpointId", "containerId"]),
    run: (a, ctx) => {
      const id = str(a, "endpointId");
      const cid = str(a, "containerId");
      return call(logsRoute.GET as Handler, ctx, `/endpoints/${id}/containers/${cid}/logs`, { params: { id, cid }, query: { tail: num(a, "tail", 1, 2000, 200), timestamps: a.timestamps ? "1" : "" } });
    },
  },
  {
    name: "control_container",
    title: "Start, stop or restart a container",
    description: "Start, stop, restart, pause, unpause or kill a container.",
    minRole: "operator",
    readOnly: false,
    destructive: true,
    inputSchema: obj({ endpointId, containerId, action: { type: "string", enum: ["start", "stop", "restart", "pause", "unpause", "kill"] } }, ["endpointId", "containerId", "action"]),
    run: (a, ctx) => {
      const id = str(a, "endpointId");
      const cid = str(a, "containerId");
      return call(containerRoute.POST as Handler, ctx, `/endpoints/${id}/containers/${cid}`, { method: "POST", params: { id, cid }, body: { action: str(a, "action") } });
    },
  },
  {
    name: "deploy_app",
    title: "Deploy an app",
    description: "Deploy or redeploy an app now. For Git apps, pass commitSha to deploy a specific commit; otherwise the branch head is used. Returns the queued deployment; follow it with get_deployment.",
    minRole: "operator",
    readOnly: false,
    inputSchema: obj({ appId, commitSha: S("Full 40-character commit SHA (Git apps only, optional)") }, ["appId"]),
    run: (a, ctx) => {
      const id = str(a, "appId");
      const commitSha = str(a, "commitSha", false);
      return call(deployRoute.POST as Handler, ctx, `/apps/${id}/deploy`, { method: "POST", params: { id }, body: commitSha ? { commitSha } : {} });
    },
  },
  {
    name: "rollback_app",
    title: "Roll back an app",
    description: "Roll an app back to an earlier successful deployment. Returns the queued rollback deployment.",
    minRole: "operator",
    readOnly: false,
    destructive: true,
    inputSchema: obj({ appId, deploymentId: S("The successful deployment to go back to, from list_deployments") }, ["appId", "deploymentId"]),
    run: (a, ctx) => {
      const id = str(a, "appId");
      const depId = str(a, "deploymentId");
      return call(deploymentRoute.POST as Handler, ctx, `/apps/${id}/deployments/${depId}`, { method: "POST", params: { id, depId }, body: { action: "rollback" } });
    },
  },
  {
    name: "cancel_deployment",
    title: "Cancel a deployment",
    description: "Cancel a queued or running deployment.",
    minRole: "operator",
    readOnly: false,
    inputSchema: obj({ appId, deploymentId }, ["appId", "deploymentId"]),
    run: (a, ctx) => {
      const id = str(a, "appId");
      const depId = str(a, "deploymentId");
      return call(deploymentRoute.POST as Handler, ctx, `/apps/${id}/deployments/${depId}`, { method: "POST", params: { id, depId }, body: { action: "cancel" } });
    },
  },
  {
    name: "list_backup_policies",
    title: "List backup policies",
    description: "Backup policies with what they back up, schedule, retention and last run.",
    minRole: "operator",
    readOnly: true,
    inputSchema: obj({ endpointId: S("Only this endpoint's policies (optional)") }),
    run: (a, ctx) => call(policiesRoute.GET as Handler, ctx, "/backups/policies", { query: { endpointId: str(a, "endpointId", false) } }),
  },
  {
    name: "list_backup_runs",
    title: "List backup runs",
    description: "Recent backup, prune, check, drill and restore runs, newest first.",
    minRole: "operator",
    readOnly: true,
    inputSchema: obj({ policyId: S("Only this policy's runs (optional)"), status: S("queued, running, success or failed (optional)"), limit: N("How many (default 20)", 1, 100) }),
    run: (a, ctx) => call(runsRoute.GET as Handler, ctx, "/backups/runs", { query: { policyId: str(a, "policyId", false), status: str(a, "status", false), limit: num(a, "limit", 1, 100, 20) } }),
  },
  {
    name: "get_backup_run",
    title: "Get a backup run",
    description: "One backup run with its log.",
    minRole: "operator",
    readOnly: true,
    inputSchema: obj({ runId: S("Run id, from list_backup_runs or run_backup") }, ["runId"]),
    run: (a, ctx) => call(runRoute.GET as Handler, ctx, `/backups/runs/${str(a, "runId")}`, { params: { id: str(a, "runId") } }),
  },
  {
    name: "run_backup",
    title: "Back up now",
    description: "Run a backup policy now. Returns the run id; follow it with get_backup_run.",
    minRole: "operator",
    readOnly: false,
    inputSchema: obj({ policyId: S("Policy id, from list_backup_policies") }, ["policyId"]),
    run: (a, ctx) => call(policyRoute.POST as Handler, ctx, `/backups/policies/${str(a, "policyId")}`, { method: "POST", params: { id: str(a, "policyId") }, body: { action: "run" } }),
  },
  {
    name: "list_tasks",
    title: "List scheduled tasks",
    description: "Scheduled tasks with their schedule, command and last result.",
    minRole: "operator",
    readOnly: true,
    inputSchema: obj({}),
    run: (_a, ctx) => call(tasksRoute.GET as Handler, ctx, "/tasks"),
  },
  {
    name: "run_task",
    title: "Run a task now",
    description: "Run a scheduled task now, outside its schedule.",
    minRole: "operator",
    readOnly: false,
    inputSchema: obj({ taskId: S("Task id, from list_tasks") }, ["taskId"]),
    run: (a, ctx) => call(taskRoute.POST as Handler, ctx, `/tasks/${str(a, "taskId")}`, { method: "POST", params: { id: str(a, "taskId") } }),
  },
  {
    name: "list_activity",
    title: "Audit log",
    description: "Search DeployNow's audit log: who did what, when, from where, and whether it worked.",
    minRole: "operator",
    readOnly: true,
    inputSchema: obj({ search: S("Text to look for (optional)"), action: S("An action such as app.deploy_queued or mcp.tool_call (optional)"), limit: N("How many (default 30)", 1, 100) }),
    run: (a, ctx) => call(activityRoute.GET as Handler, ctx, "/activity", { query: { search: typeof a.search === "string" ? a.search.slice(0, 200) : "", action: str(a, "action", false), limit: num(a, "limit", 1, 100, 30) } }),
  },

  // ── admin ──
  {
    name: "set_app_env",
    title: "Set environment variables",
    description:
      "Add, change or remove an app's environment variables. Variables you don't mention stay as they are. Secret values are encrypted and write-only: they are never shown again. The change takes effect on the next deploy.",
    minRole: "admin",
    readOnly: false,
    inputSchema: obj(
      {
        appId,
        set: {
          type: "array",
          description: "Variables to add or change",
          items: obj({ key: S("Variable name"), value: S("Value"), secret: { type: "boolean", description: "Store encrypted and hide the value (default: keep the current kind, or plain for a new variable)" } }, ["key", "value"]),
        },
        remove: { type: "array", description: "Names of variables to remove", items: { type: "string" } },
      },
      ["appId"],
    ),
    run: async (a, ctx) => {
      const id = str(a, "appId");
      const set = Array.isArray(a.set) ? (a.set as Record<string, unknown>[]) : [];
      const remove = new Set(Array.isArray(a.remove) ? a.remove.map(String) : []);
      if (!set.length && !remove.size) throw new ToolError("Pass set or remove");
      const app = (await call(appRoute.GET as Handler, ctx, `/apps/${id}`, { params: { id } })) as { env: { key: string; kind: string; value: string | null }[] };
      // Existing secrets come back with value null, which the API reads as "keep"
      const env = new Map(app.env.map((e) => [e.key, { key: e.key, kind: e.kind, value: e.value }]));
      for (const k of remove) env.delete(k);
      for (const v of set) {
        const key = String(v.key ?? "").trim();
        if (!key) throw new ToolError("Each variable needs a key");
        const before = env.get(key);
        const kind = v.secret === true ? "secret" : v.secret === false ? "plain" : before?.kind === "vault" ? "plain" : (before?.kind ?? "plain");
        env.set(key, { key, kind, value: String(v.value ?? "") });
      }
      await call(appRoute.PATCH as Handler, ctx, `/apps/${id}`, { method: "PATCH", params: { id }, body: { env: [...env.values()] } });
      const after = (await call(appRoute.GET as Handler, ctx, `/apps/${id}`, { params: { id } })) as { env: unknown };
      return { updated: true, note: "Deploy the app for the change to take effect.", env: after.env };
    },
  },
];

/** The highest role a caller acts with anywhere: their capped instance role or any capped binding. */
export function reachRole(user: { role: string; bindings: { role: string }[] }): Role {
  let r = normalizeRole(user.role);
  for (const b of user.bindings) if (roleAtLeast(normalizeRole(b.role), r)) r = normalizeRole(b.role);
  return r;
}

/** The tools a caller can use at all. The route handlers still check each call against the exact project or endpoint. */
export function toolsFor(user: { role: string; bindings: { role: string }[] }): Tool[] {
  const r = reachRole(user);
  return TOOLS.filter((t) => roleAtLeast(r, t.minRole));
}

/** Tool arguments as they go into the audit log: secret values never do. */
export function auditArgs(tool: string, args: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...args };
  if (tool === "set_app_env" && Array.isArray(copy.set)) {
    copy.set = (copy.set as Record<string, unknown>[]).map((v) => ({ key: v.key, secret: v.secret, value: "[redacted]" }));
  }
  return JSON.stringify(copy).slice(0, 2000);
}
