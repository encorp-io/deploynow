# Install DeployNow

You need a Linux machine (amd64 or arm64) with 1 GB of RAM or more, and port 9444
reachable (8444 too if you use agents).

## One command

```bash
curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/main/setup.sh | sudo bash
```

It asks four things, and Enter keeps the default:

| Question | Default | |
|---|---|---|
| Domain | none (use the IP) | e.g. `deploy.example.com`. Point its DNS at the server first; DeployNow starts Traefik on ports 80 and 443, gets a Let's Encrypt certificate and switches to the domain once it answers. Until then, and as a fallback, it stays on `https://<IP>:<port>`. |
| Dashboard port | `9444` | Any free port except 80, 443 and 8444 |
| Admin email | `admin@example.com` | The owner account. With a domain it must be a real address: Let's Encrypt sends notices to it. |
| Admin password | generated | 12+ characters, typed twice. A generated one is printed at the end. |

Then it installs Docker if it's missing, writes `/opt/deploynow/docker-compose.yml` and
`/opt/deploynow/.env` (with a random `AUTH_SECRET`), starts DeployNow, waits until it's
healthy and prints where to sign in. Two-factor sign-in is optional: turn it on under
**Account**, or require it for admins under **Settings → Security and sign-in** (or pass `--require-2fa`).

Without `sudo` it asks for it. Run it again to upgrade: it keeps `.env` and your
`docker-compose.yml`, asks nothing and pulls the image.

### Without questions

For cloud-init, Terraform or CI, pass `--yes` and the answers as options (or the same
environment variables in front of `bash`):

```bash
curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/main/setup.sh \
  | sudo bash -s -- --yes --domain deploy.example.com --email you@example.com
```

| Option | Variable | Default | |
|---|---|---|---|
| `--domain` | `DEPLOYNOW_DOMAIN` | none | Domain with Let's Encrypt |
| `--port` | `DEPLOYNOW_PORT` | `9444` | Dashboard port on the host |
| `--email` | `ADMIN_EMAIL` | `admin@example.com` | Owner account created on first start |
| `--password` | `ADMIN_PASSWORD` | generated | At least 12 characters |
| `--require-2fa` | `REQUIRE_2FA=true` | optional | Admins and owners must set up 2FA or a passkey |
| `--tag` | `DEPLOYNOW_TAG` | `latest` | A release such as `2.1.0`, `latest` (newest stable) or `edge` (main) |
| `--url` | `DEPLOYNOW_URL` | `https://<public IP>:<port>` | The address people and agents use when there's no domain |
| `--dir` | `DEPLOYNOW_DIR` | `/opt/deploynow` | Where the files go |
| `--no-docker` | `INSTALL_DOCKER=no` | install | Stop instead of installing Docker |
| `--no-start` | `DEPLOYNOW_NO_START=1` | start | Write the files only |

`install.sh`, the old name, still works and runs `setup.sh --yes`.

> **Back up `/opt/deploynow/.env`.** `AUTH_SECRET` encrypts every stored secret, SSH
> key, registry password and backup key. A restored database is unreadable without it.

## Docker Compose by hand

```bash
mkdir -p /opt/deploynow && cd /opt/deploynow
curl -fsSLO https://raw.githubusercontent.com/encorp-io/deploynow/v1.1.0/docker-compose.yml   # the release you install
cat > .env <<END
AUTH_SECRET=$(openssl rand -base64 32)
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=choose-a-long-password
NEXTAUTH_URL=https://your-server:9444
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
DEPLOYNOW_TAG=1.1.0
END
chmod 600 .env
docker compose up -d
# Once you can sign in: the password is only read on the first start
sed -i '/^ADMIN_PASSWORD=/d' .env && docker compose up -d
```

Every setting is listed in the [README](../README.md#environment-variables).

## After the first sign-in

1. Change the password and, ideally, set up 2FA or a passkey under **Account**.
   `setup.sh` removes `ADMIN_PASSWORD` from `.env` once DeployNow is up, and recreates
   the container so `docker inspect` no longer shows it. If you wrote `.env` yourself,
   remove it and run `docker compose up -d`; DeployNow logs a warning while it is set.
2. No domain yet? Under **Settings → Domain**, give DeployNow one such as
   `deploy.example.com` for a Let's Encrypt certificate. Port 9444 keeps working with
   the self-signed one.
3. Add your other machines under **Endpoints**, and a backup destination under **Backups**.
   One of the backups should be DeployNow itself.

## Ports

| Port | What | Open it to |
|---|---|---|
| 9444 (`DEPLOYNOW_PORT`) | HTTPS dashboard, API and `/mcp` | The people who use DeployNow |
| 8444 | Agent hub (mutual TLS) | Agents on other machines; `AGENT_PORT=off` turns it off |
| 80, 443 | Traefik, once you set up the edge proxy or a domain | Everyone, for your apps' domains |

## Your own certificate

Mount it read-only and run `docker compose up -d`:

```yaml
volumes:
  - /etc/ssl/deploy.example.com/fullchain.pem:/certs/cert.pem:ro
  - /etc/ssl/deploy.example.com/privkey.pem:/certs/key.pem:ro
```

## Troubleshooting

- **Logs:** `docker compose logs deployer`. Lines from DeployNow start with `[deployer]`.
- **"AUTH_SECRET is not set":** `.env` is missing or isn't next to `docker-compose.yml`.
- **"Docker socket is mounted but not accessible":** set `DOCKER_GID=$(stat -c %g /var/run/docker.sock)` in `.env` and run `docker compose up -d`.
- **"database migration failed":** nothing was lost. The database from before the upgrade is in `/data/db-backups/`; see [Upgrading](upgrading.md#rolling-back).
- **The browser warns about the certificate:** expected with the self-signed certificate. Set a domain under Settings → Domain, or mount your own.
- **"no configuration file provided: not found":** Docker is the Ubuntu snap, which can't read `/opt/deploynow`. Remove it with `sudo snap remove --purge docker` (this removes the containers snap Docker runs) and run `setup.sh` again: it installs Docker Engine from get.docker.com.
- **`docker compose pull` is denied (unauthorized):** the images are public, so this means a stale or wrong login for ghcr.io: run `docker logout ghcr.io` and try again. For a private copy of the image, `docker login ghcr.io` with a token that has `read:packages`.
- **Is it up?** `curl -k https://localhost:9444/api/health` answers `{"ok":true,"version":"…"}`.
