# AI connectors (MCP)

DeployNow has a built-in [MCP](https://modelcontextprotocol.io) server, so you can manage it from Claude, ChatGPT, Cursor, Claude Code or any other app that supports remote MCP connectors. The app signs in with OAuth: you approve it once in DeployNow and choose what it may do.

## Connect an app

1. In DeployNow, open **Account → AI connections** and copy the address. It is your DeployNow address followed by `/mcp`, for example `https://deploy.example.com/mcp`.
2. Add it as a custom connector (menu names change between app versions):
   - **Claude** (claude.ai or the desktop app): Settings → Connectors → Add custom connector. Paste the address; leave the OAuth client fields empty.
   - **ChatGPT**: Settings → Apps & Connectors → Advanced → Developer mode, then Create. Paste the address and choose OAuth.
   - **Claude Code**: `claude mcp add --transport http deploynow https://deploy.example.com/mcp`, then `/mcp` to sign in.
   - **Cursor / VS Code**: add a server with `"url": "https://deploy.example.com/mcp"`.
3. The app opens DeployNow. Sign in if asked, pick **Read only**, **Operate** or **Admin**, and click **Allow**.

DeployNow must be reachable from the internet over HTTPS with a certificate the app trusts, because Claude and ChatGPT call it from their servers. Set the domain under Settings (or `NEXTAUTH_URL`) first: the OAuth issuer and the `/mcp` address are built from it, and connections made under an old domain have to be made again after it changes.

## What a connection can do

A connection acts as you, capped at the level you picked, and never above your own role (per-project and per-endpoint roles are capped the same way).

| Level | Tools |
|---|---|
| Read only | `list_endpoints`, `list_containers`, `inspect_container`, `container_stats`, `host_metrics`, `list_projects`, `get_app`, `list_deployments`, `get_monitoring` |
| Operate | the above, plus `container_logs`, `control_container` (start, stop, restart, pause, kill), `deploy_app`, `get_deployment` (with its log), `rollback_app`, `cancel_deployment`, `list_backup_policies`, `list_backup_runs`, `get_backup_run`, `run_backup`, `list_tasks`, `run_task`, `list_activity` |
| Admin | the above, plus `set_app_env` (add, change or remove environment variables and secrets) |

Each tool calls the same API route the UI uses, so it gets the same permission checks and audit events.

Never available to an AI app: deleting anything, revealing secret values, the container console, restores, recovery kits, and changing users, SSO, tokens or instance settings. Secret values are write-only, and `inspect_container` hides every environment variable value.

## Audit and revocation

Every tool call is in the audit log as `mcp.tool_call`, naming you and the app ("ran deploy_app via Claude"), with the arguments (secret values redacted). Connecting, declining and disconnecting are logged as `oauth.authorize`, `oauth.deny` and `oauth.revoke`.

**Account → AI connections** lists your connected apps with their level and last use. **Disconnect** ends a connection at once. Disabling a user ends all of their connections.

## How it works

- Streamable HTTP MCP endpoint at `/mcp`. It is stateless and answers with JSON; there is no server-initiated stream.
- OAuth 2.1 authorization server, discovered from `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`:
  - dynamic client registration (RFC 7591) at `/api/oauth/register`, open by design because nothing is granted until a person approves; at most 30 registrations per IP per hour, and clients nobody approved are cleared after a day
  - authorization code flow with PKCE (S256 only), consent at `/oauth/authorize`, `iss` in the response (RFC 9207)
  - access tokens (`dno_…`, 1 hour) bound to the `/mcp` resource (RFC 8707) and refused by the rest of the API
  - refresh tokens (`dnr_…`, 30 days) rotated on every use; reusing an old refresh token or authorization code ends all of that connection's tokens
  - revocation (RFC 7009) at `/api/oauth/revoke`
  - only token hashes are stored
- Scopes: `read`, `operate`, `admin`. The person's choice on the consent screen decides; the scope the app asks for only preselects it.
- A personal API token (`Authorization: Bearer dn_…`) also works at `/mcp`, for clients that take a header instead of OAuth.
- Set `DEPLOYNOW_MCP=off` to turn all of this off.
