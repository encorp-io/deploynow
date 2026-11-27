# Changelog

All notable changes to DeployNow are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/): a major version can need manual steps
(they are listed under **Upgrading**), minor versions add features, and patch
versions fix bugs. Every version upgrades the database by itself.

## [Unreleased]

### Added
- **Update channel** (Settings → Updates): updates follow *stable* (the newest release,
  pinned, e.g. `1.0.0`), *edge* (every build from `main`) or the tag DeployNow was started
  with. Update now and auto-update both use it, and a channel switch moves `DEPLOYNOW_TAG`
  in the compose `.env` too.
- **Overview dashboard:** a new home page with machines, apps, CPU, memory and backups at a
  glance, the latest deploy log, each machine's load over 24 hours, the busiest apps and alerts.
- **Usage per service:** on a project page, every app lists its services (containers) with
  their CPU, memory and network, and the app total.
- **Monitoring:** CPU and memory lines per machine, and an apps and services view (now, or the
  average over 1 hour to 30 days) with a filter, sorting and containers DeployNow did not deploy.
- **One-command setup:** `curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/main/setup.sh | sudo bash`
  asks for a domain, port, admin email and password (Enter keeps the defaults), installs
  Docker if it's missing, writes `docker-compose.yml` and `.env` and starts DeployNow.
  `--yes` runs it without questions; `install.sh` still works and runs `setup.sh --yes`.
- **`DEPLOYNOW_DOMAIN`:** serve the UI on a domain from the first start. DeployNow turns on
  the managed edge proxy, gets a Let's Encrypt certificate (to `ACME_EMAIL`) and switches to
  the domain once it answers, the same as Settings → Domain. `DEPLOYNOW_PORT` picks the
  dashboard's host port.

### Changed
- **2FA is optional on a new install.** Admins and owners are no longer made to set it up
  before using DeployNow; owners can require it under Settings → Security and sign-in, or
  with `REQUIRE_2FA=true` on the first start. Existing installs keep their setting.

### Fixed
- **Domains behind Cloudflare's proxy:** a domain with HTTPS turned off answered
  404 when Cloudflare reached the server on port 443 (SSL mode Full). It now has a
  router on 443 too. Redeploy the app to pick this up.
- **Turning on 2FA:** after enabling 2FA (or adding a passkey) on a new account, the app kept
  sending you back to the Account page and the sidebar kept asking you to turn it on, until
  you reloaded the page. The sidebar and the page router now pick up the change at once.
- **Updating DeployNow from its own UI:** the Update button on DeployNow's own container
  stopped DeployNow and never brought it back, because the process doing the recreate
  ran inside the container it stopped. That button now uses the new self-update below.
- **Compose env vars:** an app's environment variables only filled `${NAME}` in the compose
  file, so a service with `env_file: .env` got none of them. They are now also written to
  `.env` next to the compose file at deploy time (a `.env` from the repository is kept, and
  the app's values win).
- **Passkeys:** about 1 in 110 passkey sign-ins failed with "The passkey couldn't be
  verified". SimpleWebAuthn is upgraded to v13, which reads every valid signature.

### Added
- **Self-update:** Settings → Updates → **Update now**. DeployNow pulls the new image,
  then a short-lived `deploynow-updater` container (started from DeployNow's own image,
  with the Docker socket and the data volume, no network) replaces DeployNow with the
  same configuration, waits for its health check, and rolls back to the previous
  container, with the database copied just before the switch, when the new version
  doesn't come up healthy. A pinned tag (`2.0.0`) moves to the newest release and
  `DEPLOYNOW_TAG` in the compose `.env` moves with it; `latest`, `edge` and `2.0` are
  pulled again. Optional **auto-update**, any time or within one hour of the day; a
  version that rolled back isn't tried again. The outcome lands in the audit log and
  the new "DeployNow updated itself (or rolled back)" notification.
  `DEPLOYNOW_SELF_UPDATE=off` turns it off.
- **Import .env:** upload, drop or paste a .env file on an app's Environment tab. It reads
  comments, quotes, multi-line values and `export`, previews what changes, lets you merge
  (file wins), add new only or replace all, imports password and token names as secrets,
  and saves right away. The tab also shows when there are unsaved changes.
- **Forms and dialogs:** redesigned dropdowns (themed menu with keyboard support and a
  filter for long lists), text fields, checkboxes, radios and toggle switches, and
  dialogs (lit edge, icon header, focus kept inside, bottom sheet on phones).
- **Templates:** 22 one-click apps (databases, n8n, WordPress, Ghost, Directus,
  Plausible, Umami, Metabase, Grafana, Uptime Kuma, Gitea, Adminer, pgAdmin, Mailpit,
  RabbitMQ, Meilisearch, NocoDB, Vaultwarden, Nextcloud). Passwords and keys are
  generated and stored as secrets; the app can get its domain and a nightly backup
  policy (database dump plus data volumes) as it is created. See docs/templates.md.
- **Uptime checks:** HTTP(S) and TCP checks from DeployNow every 30 seconds to an hour,
  with expected status codes, a keyword, response-time history (14 days), daily uptime
  (90 days), incidents, `uptime.down` / `uptime.up` / `uptime.cert` notifications and
  a public status page at `/status`. See docs/uptime.md.
- **Mailgun** as a notification channel, next to SMTP email.
- **New version notice:** DeployNow reads its GitHub releases twice a day and tells
  admins (a banner and Settings → Updates) and the channels subscribed to
  `update.available`. Turn it off in Settings or with `DEPLOYNOW_UPDATE_CHECK=off`.

## [2.0.0] - 2026-11-23

The first public release. DeployNow is v2 of Encorp Deployer, rebuilt as a
standalone replacement for Portainer and Dokploy.

### Added
- **Machines:** the local Docker socket, SSH and Docker TLS endpoints, and an outbound
  agent with mutual TLS for machines behind NAT (amd64 and arm64).
- **Containers:** explorer with logs, stats, console, inspect, images, volumes,
  networks, prune, and update checks with auto-update for floating tags.
- **Apps:** projects and environments; deploys from an image, a Dockerfile or compose
  file in Git, or a pasted compose file; zero-downtime replace, deployment logs,
  rollback, GitHub push-to-deploy and pull request previews; optional build server.
- **Domains:** managed Traefik with Let's Encrypt (HTTP or Cloudflare DNS), or an
  existing Traefik; redirects and password protection; a domain for DeployNow itself.
- **Secrets:** environment variables with encrypted, write-only secrets masked in logs,
  and HashiCorp Vault references.
- **Registries:** shared service-account logins and personal logins per account.
- **Backups:** restic to R2, S3, B2 or any S3 service: volumes, folders, databases,
  whole apps and DeployNow itself, with retention, restores, recovery kits and
  monthly restore drills.
- **Operations:** scheduled tasks, monitoring and alerts, notifications (Slack,
  Discord, Telegram, email, signed webhooks), per-container usage history and a
  Prometheus endpoint with a Grafana dashboard.
- **Access:** TOTP 2FA, passkeys, Google, Microsoft and OpenID Connect sign-in,
  roles with per-endpoint and per-project grants, step-up for destructive actions,
  revocable sessions and an audit log.
- **Automation:** API tokens, an OpenAPI description, the `deploynow` CLI, and an
  MCP server with OAuth 2.1 for Claude, ChatGPT and other AI apps.
- Versioned database migrations, with a copy of the database in `/data/db-backups`
  before each upgrade.
- `GET /api/health`, a Docker health check, the version in the sidebar, and a
  one-line installer (`install.sh`).

### Security
- The Settings GitHub token is only sent to github.com (and `GITHUB_HOSTS`) when cloning.

### Upgrading
- From Encorp Deployer 1.x: see [docs/upgrading.md](docs/upgrading.md#from-encorp-deployer-1x).
- Image tags changed: `latest` is now the newest stable release and `edge` follows `main`.

[Unreleased]: https://github.com/encorp-io/deploynow/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/encorp-io/deploynow/releases/tag/v2.0.0
