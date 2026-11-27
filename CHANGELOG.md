# Changelog

All notable changes to DeployNow are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/): a major version can need manual steps
(they are listed under **Upgrading**), minor versions add features, and patch
versions fix bugs. Every version upgrades the database by itself.

## [Unreleased]

### Added
- **Update available for every app**: every deployed app is checked about once an hour,
  auto-update on or not, and the app page shows what is new. Apps on a pinned tag
  (`4.55`, `17-alpine`, `sha-82e99af`) now see newer tags too: the newest version of the
  same shape, or the newer build `latest`/`main` points to. Image apps, and compose images
  written as one variable, switch to the new tag from the banner. New notification event
  *App update available*.

### Fixed
- Compose apps never showed that an update was available.
- Image updates: containers from registries other than GHCR were looked up on Docker Hub,
  and private images were checked without the registry login.

## [1.1.0] - 2026-11-28

Auto-update for every kind of app, a choice of update channel, and a round of security
hardening. **Read Upgrading below before you update:** a few setups that 1.0.0 allowed
are now refused.

### Added
- **Auto-update for compose and Git apps** (app → Settings → Auto-update): compose apps
  follow new digests of the images in their compose file, Git apps poll their branch for
  new commits (no webhook needed), and image apps keep following their tag. Checks run on
  a schedule, optionally only in a maintenance window (days, hours, time zone). A failed
  or unhealthy update is rolled back to the previous deployment, with compose images pinned
  to the digests that ran before, and isn't retried. New notification events and audit
  entries. Digest checks now work with any v2 registry, not only GHCR and Docker Hub.
  See [docs/auto-update.md](docs/auto-update.md).
- **Update channel** (Settings → Updates): updates follow *stable* (the newest release,
  pinned, e.g. `1.1.0`), *edge* (every build from `main`) or the tag DeployNow was started
  with. Update now and auto-update both use it, and a channel switch moves `DEPLOYNOW_TAG`
  in the compose `.env` too.
- **Signed images:** images are signed with cosign (keyless) and published with SLSA
  provenance and an SBOM; each release lists its image digests in `image-digests.txt`.
  Self-update and auto-update check the new image's signature (and, for a release, its
  digest) before switching, and the updater starts only the image that was checked.
  `DEPLOYNOW_VERIFY_IMAGES=off` skips the check.

### Changed
- Image apps with "Redeploy when the image tag gets a new digest" move to the new
  auto-update setting by themselves, with the same pace (every minute).
- Rolling back a compose app starts the images that deployment ran (by digest), not
  whatever their tags point to now.
- The image is built on Node.js 26 (was 22).
- `setup.sh` takes `docker-compose.yml` from the release it installs.

### Fixed
- The knob of toggle switches sits in the right place again.

### Security
- **Compose sandbox:** compose apps (inline, Git and templates) can no longer reach the
  host. Deploys refuse `privileged`, extra capabilities, devices, host namespaces
  (`pid`/`ipc`/`network_mode: host`), `use_api_socket`, privileged builds, bind mounts,
  foreign or external volumes and networks, `include`/`extends` and
  `env_file`/`secrets`/build paths outside the app, and `traefik.*` labels the app did
  not get from its domains. The check runs on the fully interpolated config, so `${VAR}`
  tricks do not get around it. Git checkouts with symlinks that point outside the
  repository are refused.
- Putting an app on an endpoint (new app, template, build server, environment default)
  now needs operator rights on that endpoint, not just admin on the project.
- Apps can no longer route DeployNow's own domain (on any path), or a host or preview
  domain that another project already uses.
- **Microsoft sign-in for any work account** (tenant `organizations` or `common`) no longer
  matches or creates accounts by email unless the token carries `xms_edov`, so another
  Entra tenant can't sign in as one of your people by giving its user their address.
  Accounts already linked keep working.
- A session is accepted only for the user it was created for, and expired sessions are
  refused on API calls too.
- Viewers no longer see pending invites, who has 2FA off, last sign-ins, other people's
  endpoint grants, or the Vault role id and CA certificate.
- The AI connection consent page shows request errors itself instead of redirecting to a
  newly registered app's address.
- The current password, step-up codes, turning 2FA off and new recovery codes share one
  limit of 10 tries per 15 minutes.
- Cookie requests that change something and carry no `Origin` are refused when the browser
  marks them as coming from another site.
- **Registry test can't reach internal addresses:** testing a registry login resolves the
  host first and refuses metadata and link-local addresses for everyone, and loopback and
  private ranges for non-admins. The token realm must be https, redirects aren't followed,
  and errors no longer echo the remote answer. Auto-update digest checks go through the
  same guard (metadata and link-local refused, redirects checked hop by hop).
- **Client IP behind the domain can't be spoofed:** nginx trusts `X-Real-IP` and
  `X-Forwarded-Proto` on the Traefik port only with a per-install secret that the domain
  route adds (kept in `/data/proxy-secret`). Port 9444 sends HSTS when it has a real
  certificate.
- **Secrets inside containers:** container env values are now admin only, and an app
  container's env values need access to that app's secrets. DeployNow's own container,
  the updater and backup/task helpers never show env values or open a console; their
  logs are admin only and only owners can stop or remove them. Credential-like label
  values (such as the domain route's proxy secret or Traefik basic-auth users) are
  masked in container details. See [docs/security.md](docs/security.md).
- GitHub Actions are pinned to commit SHAs.
- `setup.sh` removes `ADMIN_PASSWORD` from `.env` after the first start and recreates
  the container, so `docker inspect` no longer shows it; DeployNow warns while it is
  still set.
- The app's files in the image belong to root, so the `nextjs` user can't change them.

### Upgrading
From 1.0.0, **Settings → Updates → Update now** works as before (or set
`DEPLOYNOW_TAG=1.1.0` and run `docker compose pull && docker compose up -d`). The
database upgrades itself. Before you update, check these:

- **Compose apps that use the host** (bind mounts such as `/var/run/docker.sock` or
  `/srv/data`, `privileged`, `network_mode: host`, devices, external volumes) fail their
  next deploy with a message naming the setting. Running containers keep running. Move
  the data to a named volume, or, on a single-tenant install where every project admin
  is trusted, set `DEPLOYNOW_COMPOSE_POLICY=trusted` on the DeployNow container to lift
  these rules.
- **Microsoft sign-in with `organizations` or `common`:** add the `email` and `xms_edov`
  optional claims to the ID token in the app registration (Token configuration), or
  switch to your tenant id. Otherwise people who haven't signed in with Microsoft before
  can't be matched to their account. People already linked keep signing in.
- **Project admins who create apps** now need operator rights on the endpoint (an
  instance-wide operator role or an endpoint grant under Settings → Users). Existing apps
  keep running and deploying.
- **Container env values** are admin only. Give people who need them access to the app's
  secrets, or the admin role.
- **Self-update checks signatures** from now on, so DeployNow needs to reach ghcr.io,
  `rekor.sigstore.dev` and `tuf-repo-cdn.sigstore.dev`. Behind a registry mirror or
  without internet access, set `DEPLOYNOW_VERIFY_IMAGES=off`.
- **`ADMIN_PASSWORD`:** installs from 1.0.0 still have it in `.env`, and DeployNow now logs a
  warning about it. Remove it once the first account exists:
  `sed -i '/^ADMIN_PASSWORD=/d' .env && docker compose up -d`.
- Registry logins on loopback or private addresses can only be tested by admins.

## [1.0.0] - 2026-11-27

The first public release of DeployNow, a self-hosted replacement for Portainer and
Dokploy. It is the successor of Encorp Deployer, rebuilt as a standalone product.

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
- **Overview dashboard:** a home page with machines, apps, CPU, memory and backups at a
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
- **Self-update:** Settings → Updates → **Update now**. DeployNow pulls the new image,
  then a short-lived `deploynow-updater` container (started from DeployNow's own image,
  with the Docker socket and the data volume, no network) replaces DeployNow with the
  same configuration, waits for its health check, and rolls back to the previous
  container, with the database copied just before the switch, when the new version
  doesn't come up healthy. A pinned tag (`1.0.0`) moves to the newest release and
  `DEPLOYNOW_TAG` in the compose `.env` moves with it; `latest`, `edge` and `1.0` are
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

### Changed
- **2FA is optional on a new install.** Owners can require it for everyone under
  Settings → Security and sign-in, or with `REQUIRE_2FA=true` on the first start.

### Security
- The Settings GitHub token is only sent to github.com (and `GITHUB_HOSTS`) when cloning.

### Upgrading
- From Encorp Deployer 1.x: see [docs/upgrading.md](docs/upgrading.md#from-encorp-deployer-1x).
- Image tags changed: `latest` is now the newest stable release and `edge` follows `main`.

[Unreleased]: https://github.com/encorp-io/deploynow/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/encorp-io/deploynow/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/encorp-io/deploynow/releases/tag/v1.0.0
