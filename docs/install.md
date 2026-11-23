# Install DeployNow

You need a Linux machine (amd64 or arm64) with 1 GB of RAM or more, and port 9444
reachable (8444 too if you use agents).

## One line

```bash
curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/main/install.sh | sudo bash
```

The installer:

1. installs Docker with get.docker.com if it's missing;
2. writes `/opt/deploynow/docker-compose.yml` and `/opt/deploynow/.env` with a random
   `AUTH_SECRET` and owner password;
3. starts DeployNow, waits until it reports healthy, and prints the address, email
   and password.

Options go in front of `bash`, for example
`curl -fsSL … | sudo ADMIN_EMAIL=you@example.com DEPLOYNOW_TAG=2.0.0 bash`:

| Variable | Default | |
|---|---|---|
| `ADMIN_EMAIL` | `admin@example.com` | Owner account created on first start |
| `ADMIN_PASSWORD` | random | At least 12 characters |
| `DEPLOYNOW_TAG` | `latest` | A release such as `2.0.0`, `latest` (newest stable) or `edge` (main) |
| `DEPLOYNOW_URL` | `https://<public IP>:9444` | The address people and agents use |
| `DEPLOYNOW_DIR` | `/opt/deploynow` | Where the files go |
| `INSTALL_DOCKER` | `yes` | `no` stops instead of installing Docker |

Run it again to upgrade: it keeps `.env` and your `docker-compose.yml`, and pulls the image.

> **Back up `/opt/deploynow/.env`.** `AUTH_SECRET` encrypts every stored secret, SSH
> key, registry password and backup key. A restored database is unreadable without it.

## Docker Compose by hand

```bash
mkdir -p /opt/deploynow && cd /opt/deploynow
curl -fsSLO https://raw.githubusercontent.com/encorp-io/deploynow/main/docker-compose.yml
cat > .env <<END
AUTH_SECRET=$(openssl rand -base64 32)
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=choose-a-long-password
NEXTAUTH_URL=https://your-server:9444
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
DEPLOYNOW_TAG=2.0.0
END
chmod 600 .env
docker compose up -d
```

Every setting is listed in the [README](../README.md#environment-variables).

## After the first sign-in

1. Set up 2FA or a passkey (admins must), and change the password. Then remove
   `ADMIN_PASSWORD` from `.env`; it's only read on the first start.
2. Under **Settings → Domain**, give DeployNow a domain such as `deploy.example.com`
   for a Let's Encrypt certificate. Port 9444 keeps working with the self-signed one.
3. Add your other machines under **Endpoints**, and a backup destination under **Backups**.
   One of the backups should be DeployNow itself.

## Ports

| Port | What | Open it to |
|---|---|---|
| 9444 | HTTPS dashboard, API and `/mcp` | The people who use DeployNow |
| 8444 | Agent hub (mutual TLS) | Agents on other machines; `AGENT_PORT=off` turns it off |
| 80, 443 | Traefik, once you set up the edge proxy | Everyone, for your apps' domains |

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
- **`docker compose pull` is denied:** while the repository is private, run `docker login ghcr.io` with a GitHub token that has `read:packages`.
- **Is it up?** `curl -k https://localhost:9444/api/health` answers `{"ok":true,"version":"…"}`.
