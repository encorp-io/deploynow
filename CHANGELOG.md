# Changelog

All notable changes to DeployNow are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/): a major version can need manual steps
(they are listed under **Upgrading**), minor versions add features, and patch
versions fix bugs. Every version upgrades the database by itself.

## [Unreleased]

### Fixed
- **Domains behind Cloudflare's proxy:** a domain with HTTPS turned off answered
  404 when Cloudflare reached the server on port 443 (SSL mode Full). It now has a
  router on 443 too. Redeploy the app to pick this up.
- **Passkeys:** about 1 in 110 passkey sign-ins failed with "The passkey couldn't be
  verified". SimpleWebAuthn is upgraded to v13, which reads every valid signature.

### Added
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
