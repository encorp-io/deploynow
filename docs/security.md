# Security and hardening

DeployNow holds the keys to every Docker machine you connect, so treat it like an SSH
bastion. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What protects what

| | |
|---|---|
| Sign-in | Passwords (scrypt), TOTP 2FA with recovery codes, passkeys, SSO. Owners can require 2FA or a passkey for admins and owners (Settings → Security and sign-in; off on a new install unless `REQUIRE_2FA=true`). |
| Sessions | Server-side, 8 hours, revocable under Account → Sessions. Failed sign-ins are throttled per email and per IP. |
| Destructive actions | Deleting endpoints or apps, restores, prune and 2FA resets need a 2FA code from the last 10 minutes, and a person rather than an API token or AI connection. |
| Roles | Viewer, operator, admin, owner, instance-wide or per project or endpoint. |
| Stored secrets | AES-256-GCM, keyed from `AUTH_SECRET`: app secrets, SSH keys, registry passwords, backup keys, SSO client secrets, the agent CA key. |
| Agents | Mutual TLS with a private CA. Agents pin the CA fingerprint from the join command; each agent's certificate is bound to its endpoint and revoked with it. |
| Webhooks | GitHub webhooks are checked with HMAC-SHA256 per app. |
| AI connections | OAuth 2.1 with PKCE; tokens work only on `/mcp`, are capped at the person's role, never get owner, and can't delete, reveal secrets, open a console or restore. `DEPLOYNOW_MCP=off` turns MCP off. |
| Audit | Every change, console session and secret reveal is in the audit log (Activity). |

## Checklist for production

- **Keep `AUTH_SECRET` secret and backed up.** Anyone with it and a copy of the
  database can read every stored secret. Without it, you can't.
- **Use a domain with a real certificate** (Settings → Domain), and tell people to use
  it rather than `https://<ip>:9444`.
- **Limit who reaches port 9444.** Put it behind a firewall, VPN or Cloudflare Access
  if only your team uses it. Close 8444 if you don't use agents.
- **Give the least role that works.** Docker access is root on the machine: admins,
  and operators with console access, are effectively root on their endpoints. Prefer
  project or endpoint grants to instance-wide roles.
- **Prefer agents or SSH to exposing the Docker API.** Never publish Docker's TCP port
  without TLS. The agent needs no inbound port on the machine.
- **Mind who can push.** With push-to-deploy, anyone who can push to the branch can run
  code on the endpoint, and a compose file can mount host folders. Protect the branch.
- **Use Vault references** for secrets that must rotate or be audited outside DeployNow.
- **Back up DeployNow itself** (Backups → a policy on "DeployNow"), and keep the
  recovery kit and `.env` somewhere other than the server.
- **Update.** Watch the repository's releases, or pin `2.0` to get patch releases.
- **API tokens:** give them the lowest scope and an expiry, and revoke the ones you no longer use (Account → API tokens shows when each was last used and from where).

## Secrets inside containers

Container env values are admin only, and an app's container shows them only to
people who may read that app's secrets. Operators keep the console in ordinary
containers, so an operator can still print an app's env from inside it: give the
operator role only to people you'd trust with those secrets. DeployNow's own
container (it holds `AUTH_SECRET`), the `deploynow-updater` and the backup, restore
and task helpers (restic passwords, S3 keys, database
passwords) get stricter rules for everyone, owners included:

| | DeployNow, updater, helpers | Proxy and UI route |
|---|---|---|
| Env values | never shown | admin |
| Console | never | admin |
| Logs | admin | operator |
| Start, stop, remove | owner | admin |

Container details mask label values that look like credentials (header middlewares
such as the domain route's proxy secret, Traefik basic and digest auth users, and keys
named like passwords, secrets, tokens or API keys). Docker and Traefik still see them.

DeployNow finds its own container by the `io.deploynow.self` label (set by the image
and `docker-compose.yml`), by its image name and by its container id.

## Images and updates

- Images on `ghcr.io/encorp-io` are built by GitHub Actions from this repository,
  signed with cosign (keyless) and published with SLSA provenance and an SBOM. Each
  release lists its image digests in `image-digests.txt`. Check one with `cosign verify`
  (see [Upgrading](upgrading.md#by-hand)).
- Self-update and auto-update check that signature, and the digest for a release,
  before switching, and start only the exact image they checked.
- The workflows pin each action to a commit, so a moved tag upstream can't change what
  builds the images.
- In the image, the app's files belong to root; the app runs as `nextjs` and can write
  only to `/data`, `/tmp` and Next.js's cache.

## The Docker socket

Mounting `/var/run/docker.sock` lets DeployNow manage the machine it runs on. It's
the same power as root on that machine. If DeployNow should manage only remote
machines, remove the socket from `docker-compose.yml` and add the machines as SSH,
TLS or agent endpoints.
