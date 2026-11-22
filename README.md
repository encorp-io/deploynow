<div align="center">

<img src="https://raw.githubusercontent.com/encorp-io/deployer-for-portainer/main/.github/assets/logo.png" alt="Encorp Deployer" width="80" />

# Encorp Deployer

**Keep your Portainer containers in sync with the latest images — automatically.**

[![CI](https://github.com/encorp-io/deployer-for-portainer/actions/workflows/ci.yml/badge.svg)](https://github.com/encorp-io/deployer-for-portainer/actions/workflows/ci.yml)
[![Docker](https://github.com/encorp-io/deployer-for-portainer/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/encorp-io/deployer-for-portainer/actions/workflows/docker-publish.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Image: ghcr.io](https://img.shields.io/badge/image-ghcr.io-blue?logo=github)](https://github.com/encorp-io/deployer-for-portainer/pkgs/container/deployer-for-portainer)

</div>

> **v2.0 branch: DeployNow.** This branch turns the deployer into DeployNow, a standalone replacement for Portainer and Dokploy: 2FA, roles, multiple machines over SSH or TLS, a container explorer with logs and a console, and projects with apps deployed from images, Dockerfiles or compose files in Git, with domains and SSL, encrypted secrets, rollbacks and notifications. See [docs/v2.md](docs/v2.md) for what changed and how to upgrade. The rest of this README still describes v1.

---

## What is this?

**Encorp Deployer** is an open-source, self-hosted dashboard that sits alongside your [Portainer CE](https://www.portainer.io/) instance and gives you full visibility into the state of your Docker image versions — then acts on them automatically.

If you push a new build of your app to GitHub Container Registry, Encorp Deployer detects the new digest within 60 seconds and either:

- **Auto-updates** the container (for floating tags like `latest`, `main`, `dev`) — pulls the new image, stops the old container, starts a fresh one, all without touching Portainer
- **Shows an update badge** (for pinned semver tags like `1.2.3`) — so you can review and trigger the update manually from the dashboard

No webhooks. No Portainer Business license. No cloud dependency. Everything runs in a single Docker container on your own server.

---

## Screenshots

> Dashboard, settings, and team management views

```
┌─────────────────────────────────────────────────────────┐
│  Encorp Deployer                     [Check Updates] [Sync] │
├─────────────────┬────────────┬──────────────┬───────────┤
│  4 Services     │  3 Running │  1 Update    │  0 Errors │
├─────────────────┴────────────┴──────────────┴───────────┤
│                                                          │
│  ┌──────────────────────┐  ┌──────────────────────────┐ │
│  │ api-gateway  ● Running│  │ web-app  ● Running       │ │
│  │ latest  ghcr.io  auto │  │ latest  ghcr.io  auto    │ │
│  │ ↑ Auto-updating...   │  │ ✓ Up to date             │ │
│  └──────────────────────┘  └──────────────────────────┘ │
│                                                          │
│  ┌──────────────────────┐  ┌──────────────────────────┐ │
│  │ worker  ● Running    │  │ scheduler  ● Running     │ │
│  │ 1.4.2   ghcr.io      │  │ 2.0.0  ghcr.io           │ │
│  │ ⚠ New version: 1.5.0 │  │ ✓ Up to date             │ │
│  │              [Update]│  │                          │ │
│  └──────────────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## Features

- **Auto-update on floating tags** — containers using `latest`, `main`, `dev`, `staging`, etc. are automatically recreated when a new image digest is detected
- **Update notifications for pinned versions** — semver-tagged containers show a badge when a newer version exists, with a one-click update button
- **Portainer CE integration** — connects to your existing Portainer API, reads all container configs, and uses Portainer's Docker proxy to pull & recreate
- **GHCR + Docker Hub support** — checks image digests from GitHub Container Registry and Docker Hub
- **Background polling** — configurable interval (default 60s), runs inside the same container, no cron or external orchestration needed
- **Activity log** — full audit trail of every check, update, and error
- **Team access** — invite team members via a link; manage roles (Admin / Member)
- **Single Docker image** — SQLite database embedded, no Postgres/Redis/external DB required
- **No vendor lock-in** — 100% self-hosted, open-source, MIT licensed

---

## How it works

```
┌─────────────────────────────────────────────────────────┐
│                  Encorp Deployer                         │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Background Poller (every N seconds)            │    │
│  │                                                 │    │
│  │  1. GET /api/endpoints/{id}/docker/containers   │    │
│  │     → sync container list from Portainer        │    │
│  │                                                 │    │
│  │  2. For each container:                         │    │
│  │     → GET digest from ghcr.io / docker.io       │    │
│  │     → compare with stored digest                │    │
│  │                                                 │    │
│  │  3a. Floating tag + digest changed?             │    │
│  │      → POST pull image via Portainer proxy      │    │
│  │      → DELETE old container                     │    │
│  │      → POST create + start new container        │    │
│  │                                                 │    │
│  │  3b. Pinned tag + digest changed?               │    │
│  │      → mark updateAvailable = true              │    │
│  │      → log to ActivityLog                       │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────┐    ┌─────────────────────────────┐    │
│  │  SQLite DB   │    │  Next.js Dashboard (port 3000) │  │
│  │  (Prisma)    │    │  Auth · Services · Settings  │  │
│  └──────────────┘    └─────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
        │                          │
        ▼                          ▼
┌──────────────┐         ┌─────────────────┐
│ Portainer CE │         │ ghcr.io /       │
│ (same server)│         │ docker.io       │
└──────────────┘         └─────────────────┘
```

### Floating vs. pinned tags

| Tag type | Examples | Behaviour |
|---|---|---|
| **Floating** | `latest`, `main`, `dev`, `staging`, `edge`, `nightly` | Container is automatically re-created when a new digest is detected |
| **Pinned** | `1.2.3`, `v2.0.0`, `20240101` | Dashboard shows an update badge; human clicks to update |

---

## Requirements

- Docker (on the target server)
- Portainer CE running on the same server (or reachable via URL)
- A Portainer API key (generated in Portainer → Settings → API Keys)
- A GitHub Personal Access Token with `read:packages` scope (for private GHCR images; not needed for public images)

---

## Quick start

### 1. Pull and run

```bash
docker run -d \
  --name encorp-deployer \
  --restart unless-stopped \
  -p 3000:3000 \
  -v deployer_data:/data \
  -e AUTH_SECRET="$(openssl rand -base64 32)" \
  -e ADMIN_EMAIL="admin@yourcompany.com" \
  -e ADMIN_PASSWORD="changeme" \
  ghcr.io/encorp-io/deployer-for-portainer:latest
```

Open **http://your-server:3000** and sign in.

---

### 2. Docker Compose (recommended)

Create a `.env` file:

```bash
# Generate a secure secret
AUTH_SECRET=$(openssl rand -base64 32)
ADMIN_EMAIL=admin@yourcompany.com
ADMIN_PASSWORD=changeme            # change after first login
NEXTAUTH_URL=http://your-server:3000
```

Create `docker-compose.yml`:

```yaml
services:
  deployer:
    image: ghcr.io/encorp-io/deployer-for-portainer:latest
    container_name: encorp-deployer
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - deployer_data:/data
    environment:
      AUTH_SECRET: ${AUTH_SECRET}
      ADMIN_EMAIL: ${ADMIN_EMAIL:-admin@encorp.io}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:-admin}
      DATABASE_URL: file:/data/deployer.db
      NEXTAUTH_URL: ${NEXTAUTH_URL:-http://localhost:3000}

volumes:
  deployer_data:
```

```bash
docker compose up -d
```

---

### 3. Configure Portainer connection

1. Open the dashboard → **Settings**
2. Enter your **Portainer URL** (e.g. `http://localhost:9000`)
3. Paste your **Portainer API Key** (Portainer → User menu → My Account → API Keys → Add API Key)
4. Optionally add a **GitHub PAT** with `read:packages` for private GHCR images
5. Click **Test Connection** to verify
6. Click **Save Settings**

### 4. Sync your services

On the Dashboard, click **Sync Portainer** — the app reads all containers from Portainer, stores their current image digests, and begins tracking them.

From this point, the background poller runs every 60 seconds (configurable) and keeps everything in sync automatically.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUTH_SECRET` | **Yes** | — | Random secret for JWT signing. Generate with `openssl rand -base64 32` |
| `DATABASE_URL` | No | `file:/data/deployer.db` | SQLite path inside the container |
| `NEXTAUTH_URL` | No | `http://localhost:3000` | Public URL — used for invite links |
| `ADMIN_EMAIL` | No | `admin@encorp.io` | Admin email created on first boot |
| `ADMIN_PASSWORD` | No | `admin` | Admin password created on first boot. **Change this.** |
| `PORT` | No | `3000` | HTTP port |
| `DEPLOYNOW_DATA_DIR` | No | the database's folder | Where deploy logs and build checkouts are kept (v2) |

> **Security note:** `ADMIN_EMAIL` and `ADMIN_PASSWORD` are only used if no users exist in the database (first boot). After the first login, change the password from your account settings.

---

## Upgrading

Because the database lives in a named volume, upgrading is safe:

```bash
# Pull the latest image
docker compose pull

# Recreate the container (migrations run automatically on boot)
docker compose up -d
```

For pinned version upgrades, check the [releases page](https://github.com/encorp-io/deployer-for-portainer/releases) for any breaking changes.

---

## Team management

Encorp Deployer supports multi-user access with two roles:

| Role | Capabilities |
|---|---|
| **Admin** | Full access: settings, team management, manual updates, sync |
| **Member** | Read-only dashboard + manual update trigger |

### Inviting a team member

1. Go to **Team** → enter the email and select a role → **Invite**
2. Copy the generated invite link
3. Share it with your colleague — they visit the link and set their name and password
4. The invite expires after 7 days

---

## Portainer API key setup

1. Log into Portainer
2. Click your username in the top-right → **My Account**
3. Scroll to **API Keys** → **Add API key**
4. Give it a name (e.g. `encorp-deployer`) and copy the key — it is only shown once
5. Paste it into Encorp Deployer → Settings → **API Key**

The key only needs access to the local endpoint. No admin-level permissions are required beyond reading container info and managing containers on your endpoint.

---

## GitHub PAT setup (for private images)

1. Go to GitHub → Settings → Developer settings → **Personal access tokens** → Tokens (classic)
2. Click **Generate new token**
3. Select scope: `read:packages`
4. Copy the token and paste it into Encorp Deployer → Settings → **GitHub Token**

> For public images on `ghcr.io`, no token is needed.

---

## Architecture

```
encorp-deployer/
├── src/
│   ├── app/                        # Next.js App Router
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/ # NextAuth.js handler
│   │   │   ├── services/           # Container list + manual update trigger
│   │   │   ├── polling/            # Manual check + activity log
│   │   │   ├── settings/           # Read / write app settings
│   │   │   ├── team/               # Invite, register, role management
│   │   │   └── portainer/test/     # Test Portainer connection
│   │   ├── dashboard/              # Main services view
│   │   ├── settings/               # Settings page
│   │   ├── team/                   # Team management
│   │   ├── login/                  # Sign-in page
│   │   └── setup/                  # Invite registration
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   ├── ServiceCard.tsx         # Per-container card with update UI
│   │   └── ActivityFeed.tsx        # Real-time activity log
│   └── lib/
│       ├── auth.ts                 # NextAuth v5 + credentials provider
│       ├── portainer.ts            # Portainer CE API client
│       ├── ghcr.ts                 # GHCR + Docker Hub digest checker
│       ├── polling.ts              # Sync, check, update logic
│       ├── backgroundPoller.ts     # Server-side interval (Node.js runtime)
│       └── prisma.ts               # Singleton Prisma client
├── prisma/
│   └── schema.prisma               # SQLite schema
├── Dockerfile                      # Multi-stage, non-root, standalone output
├── docker-entrypoint.sh            # Runs migrations + seeds admin on boot
└── docker-compose.yml
```

**Tech stack:**

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS v4 |
| Backend | Next.js API Routes (Node.js runtime) |
| Auth | NextAuth.js v5 (credentials provider, JWT sessions) |
| Database | SQLite via Prisma ORM |
| Container | Docker — single image, non-root user, named volume for data |

---

## CI / CD

| Workflow | Trigger | What it does |
|---|---|---|
| **CI** | Every push / PR | TypeScript check + full Next.js build against a real SQLite DB |
| **Docker publish** | Push to `main` or tag | Builds multi-arch image (`amd64` + `arm64`), pushes to GHCR |
| **Release** | `v*.*.*` tag | Waits for CI, creates a GitHub Release with auto-generated changelog |

### Tagging a release

```bash
git tag v1.2.0
git push origin v1.2.0
```

This triggers the release workflow, creates a GitHub Release, and publishes the tagged image to GHCR alongside the updated `:latest`.

---

## Contributing

Contributions are welcome! Please open an issue first to discuss significant changes.

```bash
# Clone and install
git clone https://github.com/encorp-io/deployer-for-portainer.git
cd deployer-for-portainer
npm install

# Set up local env
cp .env.example .env
# Edit .env — set AUTH_SECRET to any random string for local dev

# Run migrations and seed
npx prisma db push
npx prisma db seed   # creates admin@encorp.io / admin locally

# Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

<div align="center">

Built by [Encorp](https://encorp.io) · Open-source, MIT licensed · Contributions welcome

</div>
