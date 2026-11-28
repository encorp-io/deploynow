/**
 * The OpenAPI 3.1 description of DeployNow's REST API, served at /api/openapi.json.
 *
 * Every route is listed here with the role it needs; a test checks that the list
 * matches the route handlers, so it can't drift.
 */

type Method = "get" | "post" | "put" | "patch" | "delete";
interface Op {
  method: Method;
  path: string;
  summary: string;
  tag: string;
  /** Minimum role, or "session" for routes that need a signed-in person (not a token), or "public" */
  access: "viewer" | "operator" | "admin" | "owner" | "session" | "public";
  body?: Record<string, string>;
  query?: Record<string, string>;
  stepUp?: boolean;
}

const ID = "{id}";

export const OPERATIONS: Op[] = [
  // Endpoints
  { method: "get", path: "/health", summary: "Liveness: the version and whether the database answers", tag: "System", access: "public" },
  { method: "get", path: "/updates", summary: "The running version and the newest release (release notes for admins)", tag: "System", access: "viewer" },
  { method: "post", path: "/updates", summary: "Check for a new release now ({check:true}) or turn the check on or off ({enabled})", tag: "System", access: "admin" },
  { method: "get", path: "/status", summary: "Public status page data (only when the status page is on)", tag: "Uptime", access: "public" },
  { method: "get", path: "/uptime", summary: "Uptime checks with their 7, 30 and 90 day uptime", tag: "Uptime", access: "viewer" },
  { method: "post", path: "/uptime", summary: "Add an HTTP(S) or TCP uptime check", tag: "Uptime", access: "admin", body: { name: "string", type: "http | tcp", target: "URL or host:port", intervalSec: "30-86400", timeoutMs: "number", expectStatus: "200,204", keyword: "string", failThreshold: "1-10", certWarnDays: "0-90", public: "boolean", applicationId: "string" } },
  { method: "get", path: `/uptime/${ID}`, summary: "A check with its response times and incidents", tag: "Uptime", access: "viewer", query: { range: "1h | 24h | 7d | 14d" } },
  { method: "patch", path: `/uptime/${ID}`, summary: "Change an uptime check", tag: "Uptime", access: "admin" },
  { method: "delete", path: `/uptime/${ID}`, summary: "Remove an uptime check and its history", tag: "Uptime", access: "admin" },
  { method: "post", path: `/uptime/${ID}/run`, summary: "Run an uptime check now", tag: "Uptime", access: "admin" },
  { method: "patch", path: "/uptime/status-page", summary: "Turn the public status page on or off, and set its title", tag: "Uptime", access: "admin", body: { enabled: "boolean", title: "string" } },
  { method: "get", path: "/endpoints", summary: "List endpoints", tag: "Endpoints", access: "viewer" },
  { method: "post", path: "/endpoints", summary: "Add an endpoint (socket, ssh, tls or agent; agent returns a join command)", tag: "Endpoints", access: "admin", body: { name: "string", type: "socket | ssh | tls | agent", host: "string", port: "number", username: "string", privateKey: "string", labels: "string" } },
  { method: "post", path: "/endpoints/test", summary: "Test a connection before saving it", tag: "Endpoints", access: "admin" },
  { method: "get", path: `/endpoints/${ID}`, summary: "Get an endpoint", tag: "Endpoints", access: "viewer" },
  { method: "patch", path: `/endpoints/${ID}`, summary: "Update an endpoint", tag: "Endpoints", access: "admin" },
  { method: "delete", path: `/endpoints/${ID}`, summary: "Remove an endpoint (its containers keep running)", tag: "Endpoints", access: "admin", stepUp: true },
  { method: "post", path: `/endpoints/${ID}/refresh`, summary: "Refresh Docker info", tag: "Endpoints", access: "viewer" },
  { method: "post", path: `/endpoints/${ID}/agent`, summary: "Agent: new join command (action=join) or revoke (action=revoke)", tag: "Endpoints", access: "admin", body: { action: "join | revoke" } },
  { method: "get", path: `/endpoints/${ID}/metrics`, summary: "Host metric samples", tag: "Monitoring", access: "viewer", query: { hours: "1-168" } },
  { method: "get", path: `/endpoints/${ID}/container-usage`, summary: "Resource usage summary of each container on the endpoint", tag: "Monitoring", access: "viewer", query: { range: "1h | 6h | 24h | 7d | 30d" } },
  { method: "get", path: `/endpoints/${ID}/containers/{cid}/metrics`, summary: "CPU, memory, network and disk I/O history of a container", tag: "Monitoring", access: "viewer", query: { range: "1h | 6h | 24h | 7d | 30d" } },
  { method: "get", path: `/endpoints/${ID}/proxy`, summary: "Edge proxy status", tag: "Endpoints", access: "viewer" },
  { method: "post", path: `/endpoints/${ID}/proxy`, summary: "Install, adopt or remove the edge proxy", tag: "Endpoints", access: "admin" },
  { method: "post", path: `/endpoints/${ID}/prune`, summary: "Prune containers, images, volumes or networks", tag: "Docker", access: "admin", body: { kind: "containers | images | volumes | networks" } },
  { method: "get", path: `/endpoints/${ID}/containers`, summary: "List containers", tag: "Docker", access: "viewer" },
  { method: "get", path: `/endpoints/${ID}/containers/{cid}`, summary: "Inspect a container", tag: "Docker", access: "viewer" },
  { method: "post", path: `/endpoints/${ID}/containers/{cid}`, summary: "Start, stop, restart, pause, unpause or kill", tag: "Docker", access: "operator", body: { action: "start | stop | restart | pause | unpause | kill" } },
  { method: "delete", path: `/endpoints/${ID}/containers/{cid}`, summary: "Remove a container", tag: "Docker", access: "admin" },
  { method: "get", path: `/endpoints/${ID}/containers/{cid}/logs`, summary: "Container logs", tag: "Docker", access: "operator", query: { tail: "number", since: "unix seconds" } },
  { method: "get", path: `/endpoints/${ID}/containers/{cid}/stats`, summary: "Container resource usage", tag: "Docker", access: "viewer" },
  { method: "post", path: `/endpoints/${ID}/containers/{cid}/exec`, summary: "Ticket for an interactive console (WebSocket)", tag: "Docker", access: "operator" },
  { method: "get", path: `/endpoints/${ID}/images`, summary: "List images", tag: "Docker", access: "viewer" },
  { method: "delete", path: `/endpoints/${ID}/images`, summary: "Remove an image", tag: "Docker", access: "admin", query: { ref: "image id" } },
  { method: "get", path: `/endpoints/${ID}/volumes`, summary: "List volumes", tag: "Docker", access: "viewer" },
  { method: "delete", path: `/endpoints/${ID}/volumes`, summary: "Remove a volume", tag: "Docker", access: "admin", query: { ref: "volume name" } },
  { method: "get", path: `/endpoints/${ID}/networks`, summary: "List networks", tag: "Docker", access: "viewer" },
  { method: "delete", path: `/endpoints/${ID}/networks`, summary: "Remove a network", tag: "Docker", access: "admin", query: { ref: "network id" } },

  // Projects and apps
  { method: "get", path: "/projects", summary: "List projects with their environments and apps", tag: "Apps", access: "viewer" },
  { method: "post", path: "/projects", summary: "Create a project", tag: "Apps", access: "admin" },
  { method: "get", path: `/projects/${ID}`, summary: "Get a project", tag: "Apps", access: "viewer" },
  { method: "patch", path: `/projects/${ID}`, summary: "Update a project", tag: "Apps", access: "admin" },
  { method: "delete", path: `/projects/${ID}`, summary: "Delete a project", tag: "Apps", access: "admin" },
  { method: "get", path: `/projects/${ID}/usage`, summary: "What each app in the project uses now, per service and in total, with the last hour as a trend", tag: "Apps", access: "viewer" },
  { method: "post", path: `/projects/${ID}/environments`, summary: "Add an environment", tag: "Apps", access: "admin" },
  { method: "patch", path: `/environments/${ID}`, summary: "Update an environment", tag: "Apps", access: "admin" },
  { method: "delete", path: `/environments/${ID}`, summary: "Delete an environment", tag: "Apps", access: "admin" },
  { method: "get", path: "/templates", summary: "One-click app templates", tag: "Apps", access: "viewer" },
  { method: "post", path: "/templates", summary: "Create an app from a template, with its domain and backup policy, and deploy it", tag: "Apps", access: "admin", body: { templateId: "string", environmentId: "string", endpointId: "string", name: "string", domain: "string", hostPort: "number", values: "object", backupDestinationId: "string", deploy: "boolean" } },
  { method: "post", path: "/apps", summary: "Create an app (image, Dockerfile, compose from Git, or inline compose)", tag: "Apps", access: "admin" },
  { method: "get", path: `/apps/${ID}`, summary: "Get an app", tag: "Apps", access: "viewer" },
  { method: "patch", path: `/apps/${ID}`, summary: "Update an app (also its auto-update settings: autoUpdate, autoUpdateEvery, autoUpdateDays, autoUpdateFrom, autoUpdateTo, autoUpdateTimezone, autoUpdateRollback)", tag: "Apps", access: "admin" },
  { method: "delete", path: `/apps/${ID}`, summary: "Delete an app and stop what it runs", tag: "Apps", access: "admin" },
  { method: "post", path: `/apps/${ID}/deploy`, summary: "Deploy (or redeploy) an app", tag: "Apps", access: "operator", body: { ref: "branch or commit (optional)" } },
  { method: "get", path: `/apps/${ID}/deployments`, summary: "List deployments", tag: "Apps", access: "viewer" },
  { method: "get", path: `/apps/${ID}/metrics`, summary: "CPU, memory, network and disk I/O history of the app's containers", tag: "Apps", access: "viewer", query: { range: "1h | 6h | 24h | 7d | 30d" } },
  { method: "get", path: `/apps/${ID}/deployments/{depId}`, summary: "Get a deployment and its log", tag: "Apps", access: "operator", query: { offset: "log byte offset" } },
  { method: "post", path: `/apps/${ID}/deployments/{depId}`, summary: "Cancel, or roll back to this deployment", tag: "Apps", access: "operator", body: { action: "cancel | rollback" } },
  { method: "post", path: `/apps/${ID}/domains`, summary: "Add a domain (with optional redirect or basic auth)", tag: "Apps", access: "admin" },
  { method: "delete", path: `/apps/${ID}/domains`, summary: "Remove a domain", tag: "Apps", access: "admin" },
  { method: "post", path: `/apps/${ID}/env`, summary: "Set environment variables and secrets", tag: "Apps", access: "admin" },
  { method: "get", path: `/apps/${ID}/auto-update`, summary: "Auto-update status: maintenance window, last check, what's waiting, recent automatic updates", tag: "Apps", access: "viewer" },
  { method: "post", path: `/apps/${ID}/auto-update`, summary: "Check for an update now (deploys it inside the maintenance window); retry forgets the update that failed", tag: "Apps", access: "operator", body: { action: "check | retry" } },
  { method: "get", path: `/apps/${ID}/updates`, summary: "What the last update check found: a new image or commit for what the app runs, and newer tags (versions, commit builds)", tag: "Apps", access: "viewer" },
  { method: "post", path: `/apps/${ID}/updates`, summary: "Check the app for updates now (deploys nothing)", tag: "Apps", access: "viewer" },
  { method: "get", path: `/apps/${ID}/webhook`, summary: "Push webhook URL", tag: "Apps", access: "admin" },
  { method: "post", path: `/apps/${ID}/webhook`, summary: "Rotate the webhook secret", tag: "Apps", access: "admin" },
  { method: "post", path: "/webhooks/github/{appId}", summary: "GitHub push and pull_request webhook (HMAC signed)", tag: "Apps", access: "public" },

  // Backups
  { method: "get", path: "/backups/destinations", summary: "List backup destinations", tag: "Backups", access: "operator" },
  { method: "post", path: "/backups/destinations", summary: "Add a destination (R2, S3, B2 or other S3-compatible)", tag: "Backups", access: "admin" },
  { method: "post", path: "/backups/destinations/test", summary: "Test destination credentials before saving", tag: "Backups", access: "admin" },
  { method: "patch", path: `/backups/destinations/${ID}`, summary: "Update a destination", tag: "Backups", access: "admin" },
  { method: "post", path: `/backups/destinations/${ID}`, summary: "Test a saved destination", tag: "Backups", access: "admin" },
  { method: "delete", path: `/backups/destinations/${ID}`, summary: "Remove a destination (the bucket's data stays)", tag: "Backups", access: "admin", stepUp: true },
  { method: "get", path: "/backups/policies", summary: "List backup policies", tag: "Backups", access: "operator", query: { endpointId: "endpoint id or instance" } },
  { method: "post", path: "/backups/policies", summary: "Create a backup policy", tag: "Backups", access: "admin" },
  { method: "get", path: `/backups/policies/${ID}`, summary: "Get a policy", tag: "Backups", access: "operator" },
  { method: "patch", path: `/backups/policies/${ID}`, summary: "Update a policy", tag: "Backups", access: "admin" },
  { method: "post", path: `/backups/policies/${ID}`, summary: "Back up now (action=run) or apply retention (action=prune)", tag: "Backups", access: "operator", body: { action: "run | prune" } },
  { method: "delete", path: `/backups/policies/${ID}`, summary: "Remove a policy (snapshots stay)", tag: "Backups", access: "admin" },
  { method: "get", path: "/backups/repos", summary: "List repositories with check and drill status", tag: "Backups", access: "operator" },
  { method: "get", path: `/backups/repos/${ID}`, summary: "List a repository's snapshots", tag: "Backups", access: "operator" },
  { method: "post", path: `/backups/repos/${ID}`, summary: "check, drill, restore, or kit (recovery kit, once)", tag: "Backups", access: "operator", body: { action: "check | drill | restore | kit", snapshotId: "string", target: "same | volume | path | container", endpointId: "string", name: "string", overwrite: "boolean" } },
  { method: "get", path: "/backups/runs", summary: "List backup, prune, check, drill and restore runs", tag: "Backups", access: "operator", query: { policyId: "id", repoId: "id", kind: "string", status: "string", limit: "number" } },
  { method: "get", path: `/backups/runs/${ID}`, summary: "Get a run with its log", tag: "Backups", access: "operator" },

  // Tasks and monitoring
  { method: "get", path: "/tasks", summary: "List scheduled tasks", tag: "Tasks", access: "operator" },
  { method: "post", path: "/tasks", summary: "Create a scheduled task", tag: "Tasks", access: "admin", body: { name: "string", endpointId: "string", schedule: "cron", mode: "exec | run", container: "string", image: "string", command: "string", env: "KEY=value lines", timeoutSec: "number" } },
  { method: "get", path: `/tasks/${ID}`, summary: "Get a task and its recent runs", tag: "Tasks", access: "operator" },
  { method: "patch", path: `/tasks/${ID}`, summary: "Update a task", tag: "Tasks", access: "admin" },
  { method: "post", path: `/tasks/${ID}`, summary: "Run a task now", tag: "Tasks", access: "operator" },
  { method: "delete", path: `/tasks/${ID}`, summary: "Remove a task", tag: "Tasks", access: "admin" },
  { method: "get", path: "/monitoring", summary: "Active and recent alerts, and host usage", tag: "Monitoring", access: "viewer" },
  { method: "get", path: "/monitoring/usage", summary: "Resource usage of every app per service and in total, plus other containers", tag: "Monitoring", access: "viewer", query: { range: "1h | 6h | 24h | 7d | 30d (default 1h)" } },
  { method: "get", path: "/overview", summary: "Machines, apps, busiest apps, recent deployments, backups and alerts for the Overview page", tag: "Monitoring", access: "viewer" },
  { method: "get", path: "/metrics", summary: "Prometheus metrics (text format) for hosts, containers, apps and alerts", tag: "Monitoring", access: "viewer" },

  // Registries
  { method: "get", path: "/registries", summary: "List your registry logins and the shared ones (masked); ?projectId= lists those an app in that project may use", tag: "Registries", access: "viewer" },
  { method: "post", path: "/registries", summary: "Add a registry login: personal (yours) or shared (a service account, admins; project admins with projectId)", tag: "Registries", access: "viewer", body: { ownerType: "personal | shared", projectId: "string", name: "string", host: "string", username: "string", password: "string", namespace: "string" } },
  { method: "patch", path: `/registries/${ID}`, summary: "Update a registry login you manage", tag: "Registries", access: "viewer" },
  { method: "post", path: `/registries/${ID}`, summary: "Test a registry login you manage", tag: "Registries", access: "viewer" },
  { method: "delete", path: `/registries/${ID}`, summary: "Remove a registry login you manage", tag: "Registries", access: "viewer" },

  // Admin
  { method: "get", path: "/activity", summary: "Audit log", tag: "Admin", access: "operator" },
  { method: "get", path: "/settings", summary: "Instance settings", tag: "Admin", access: "viewer" },
  { method: "put", path: "/settings", summary: "Update instance settings", tag: "Admin", access: "admin" },
  { method: "post", path: "/settings/vault", summary: "Test the Vault connection", tag: "Admin", access: "admin" },
  { method: "get", path: "/settings/domain", summary: "Platform domain: the active domain, its Traefik route and the fallback address", tag: "Admin", access: "admin" },
  { method: "post", path: "/settings/domain", summary: "Check a platform domain (DNS, route, certificate), or switch to it", tag: "Admin", access: "admin", body: { action: "check | activate", domain: "string", confirmPasskeys: "boolean", force: "boolean" } },
  { method: "delete", path: "/settings/domain", summary: "Stop using the platform domain", tag: "Admin", access: "admin" },
  { method: "get", path: "/notifications", summary: "Notification channels", tag: "Admin", access: "admin" },
  { method: "post", path: "/notifications", summary: "Add a channel (slack, discord, telegram, webhook, email)", tag: "Admin", access: "admin" },
  { method: "patch", path: `/notifications/${ID}`, summary: "Update a channel", tag: "Admin", access: "admin" },
  { method: "post", path: `/notifications/${ID}`, summary: "Send a test message", tag: "Admin", access: "admin" },
  { method: "delete", path: `/notifications/${ID}`, summary: "Remove a channel", tag: "Admin", access: "admin" },
  { method: "get", path: "/sso", summary: "Single sign-on providers", tag: "Admin", access: "session" },
  { method: "post", path: "/sso", summary: "Add a Google, Microsoft or OIDC provider", tag: "Admin", access: "session" },
  { method: "patch", path: `/sso/${ID}`, summary: "Update a provider", tag: "Admin", access: "session" },
  { method: "delete", path: `/sso/${ID}`, summary: "Remove a provider", tag: "Admin", access: "session" },
  { method: "get", path: "/health-monitor", summary: "Health monitor settings", tag: "Admin", access: "viewer" },
  { method: "put", path: "/health-monitor", summary: "Update health monitor settings", tag: "Admin", access: "admin" },
  { method: "get", path: "/services", summary: "Tracked containers (image updates)", tag: "Updates", access: "viewer" },
  { method: "post", path: "/services", summary: "Track or untrack containers", tag: "Updates", access: "operator" },
  { method: "post", path: "/services/update", summary: "Update a tracked container to the newest image", tag: "Updates", access: "operator" },
  { method: "get", path: "/polling", summary: "Update check status", tag: "Updates", access: "viewer" },
  { method: "post", path: "/polling", summary: "Check for image updates now", tag: "Updates", access: "admin" },
  { method: "post", path: "/github/test", summary: "Test GitHub credentials", tag: "Admin", access: "admin" },
  { method: "get", path: "/onboarding", summary: "Onboarding status", tag: "Admin", access: "viewer" },

  // AI connectors: OAuth 2.1 and the MCP endpoint (also served at /mcp and /.well-known/…)
  { method: "get", path: "/oauth/metadata", summary: "OAuth authorization server metadata (RFC 8414), also at /.well-known/oauth-authorization-server", tag: "AI connectors", access: "public" },
  { method: "get", path: "/oauth/resource-metadata", summary: "Protected resource metadata for /mcp (RFC 9728), also at /.well-known/oauth-protected-resource", tag: "AI connectors", access: "public" },
  { method: "post", path: "/oauth/register", summary: "Register an OAuth client (RFC 7591)", tag: "AI connectors", access: "public" },
  { method: "post", path: "/oauth/token", summary: "Exchange an authorization code (PKCE S256) or refresh token", tag: "AI connectors", access: "public" },
  { method: "post", path: "/oauth/revoke", summary: "Revoke an OAuth token (RFC 7009)", tag: "AI connectors", access: "public" },
  { method: "post", path: "/oauth/authorize", summary: "The consent screen's answer (allow or deny)", tag: "AI connectors", access: "session" },
  { method: "post", path: "/mcp", summary: "MCP over Streamable HTTP (JSON-RPC), also at /mcp. Needs an OAuth access token or an API token", tag: "AI connectors", access: "viewer" },
  { method: "get", path: "/mcp", summary: "Not used: this MCP server has no server-initiated stream (405)", tag: "AI connectors", access: "public" },
  { method: "delete", path: "/mcp", summary: "Not used: this MCP server is stateless (405)", tag: "AI connectors", access: "public" },

  // Your account (signed-in people only)
  { method: "get", path: "/tokens", summary: "Your API tokens", tag: "Account", access: "session" },
  { method: "post", path: "/tokens", summary: "Create an API token (returned once)", tag: "Account", access: "session", body: { name: "string", scope: "viewer | operator | admin | owner", expiresInDays: "number" } },
  { method: "delete", path: `/tokens/${ID}`, summary: "Revoke an API token", tag: "Account", access: "session" },
];

const TAG_TEXT: Record<string, string> = {
  Endpoints: "Docker hosts: local socket, SSH, TLS or agent",
  Docker: "Containers, images, volumes and networks on an endpoint",
  Apps: "Projects, environments, apps, deployments and domains",
  Backups: "restic backups to S3-compatible storage, restores and drills",
  Tasks: "Scheduled commands",
  Monitoring: "Alerts and host metrics",
  Registries: "Registry logins: personal and shared service accounts",
  Admin: "Instance administration",
  Updates: "Image update tracking for unmanaged containers",
  Account: "Your API tokens (needs a signed-in session)",
  "AI connectors": "OAuth 2.1 and the MCP server that Claude, ChatGPT and other AI apps connect to",
};

export function openApiDocument(serverUrl = "/api") {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    for (const [name, desc] of Object.entries(op.query ?? {})) params.push({ name, in: "query", required: false, schema: { type: "string" }, description: desc } as (typeof params)[number]);
    const access =
      op.access === "public" ? (op.tag === "AI connectors" ? "No session needed; OAuth clients authenticate as the OAuth specs describe." : "No authentication (verified by signature).") : op.access === "session" ? "Needs a signed-in session; API tokens are refused." : `Needs the ${op.access} role (or higher) and a token scope that allows it.`;
    paths[op.path] ??= {};
    paths[op.path][op.method] = {
      tags: [op.tag],
      summary: op.summary,
      description: access + (op.stepUp ? " Refused for API tokens: it needs a recent two-factor confirmation." : ""),
      operationId: `${op.method}${op.path.replace(/\{(\w+)\}/g, "By_$1").replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))}`,
      ...(params.length ? { parameters: params } : {}),
      ...(op.body
        ? { requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: Object.fromEntries(Object.entries(op.body).map(([k, v]) => [k, { type: v.startsWith("number") ? "number" : v === "boolean" ? "boolean" : "string", description: v }])) } } } } }
        : {}),
      ...(op.access === "public" ? { security: [] } : {}),
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
        "400": { $ref: "#/components/responses/Error" },
        "401": { $ref: "#/components/responses/Error" },
        "403": { $ref: "#/components/responses/Error" },
        "404": { $ref: "#/components/responses/Error" },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "DeployNow API",
      version: "2.0",
      description:
        "Manage endpoints, apps, deployments, backups and scheduled tasks. Authenticate with a personal API token: `Authorization: Bearer dn_…` (create one under Account → API tokens). A token acts as you, limited to its scope.",
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    tags: Object.entries(TAG_TEXT).map(([name, description]) => ({ name, description })),
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "A DeployNow API token (dn_…)" } },
      responses: {
        Error: { description: "Error", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } }, required: ["error"] } } } },
      },
    },
    paths,
  };
}
