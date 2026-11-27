---
name: deploynow-ready
description: Make a repository deployable with DeployNow. Use when the user asks to "make this DeployNow-ready", "set up deploys", "add a Dockerfile and CI", "dockerize this app", "ship this to my server", or wants a GitHub Actions workflow that builds a Docker image, a docker-compose.yml and a .env.example for a self-hosted DeployNow server.
---

# Make a repository DeployNow-ready

DeployNow (https://github.com/encorp-io/deploynow) is a self-hosted deploy platform for Docker machines. It deploys an app from a container image, from a Dockerfile or compose file in Git, or from a pasted compose file, puts it behind Traefik with Let's Encrypt, keeps environment variables and secrets encrypted, and backs up named volumes.

Your job: add the files that let DeployNow build, run and update this repository with no manual steps, and leave the repository working exactly as before for local development.

## What "DeployNow-ready" means

When you are done, the repository has:

1. **`Dockerfile`** that builds a small production image of the app.
2. **`.dockerignore`** so builds are fast and never copy secrets.
3. **`.github/workflows/docker-publish.yml`** that builds the image on every push to the default branch and on version tags, for `linux/amd64` and `linux/arm64`, and pushes it to GitHub Container Registry (`ghcr.io/<owner>/<repo>`). Optionally it then asks DeployNow to deploy.
4. **`docker-compose.yml`** that runs the app from that image, plus any database or cache it needs, the way DeployNow expects (rules below).
5. **`.env.example`** listing every environment variable the app reads, with safe placeholder values and a comment for each.
6. **`DEPLOY.md`**: a short page on how to deploy this repository with DeployNow.
7. A `/health` (or similar) endpoint, if the app is a web service and has none.

Never commit real secrets. Never delete or rewrite existing files the user relies on; extend them. If a file already exists, read it and improve it instead of replacing it, and say what you changed.

## Step 1: Inspect the repository

Before writing anything, find out:

- The language, framework and package manager (lockfiles: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `requirements.txt`, `poetry.lock`, `uv.lock`, `go.mod`, `Cargo.lock`, `Gemfile.lock`, `composer.lock`, …).
- How the app is built and started (scripts in `package.json`, `Procfile`, `main.py`, `manage.py`, existing `Dockerfile`, README).
- The port it listens on, and whether it reads `PORT`. It must listen on `0.0.0.0`, not `localhost`.
- Every environment variable it reads (search for `process.env`, `os.environ`, `os.getenv`, `env::var`, `ENV[`, config files, `.env` files, framework config). Note which ones are secrets (passwords, tokens, keys, connection strings).
- Services it needs: Postgres, MySQL/MariaDB, MongoDB, Redis, a queue, object storage, a worker process, a cron job.
- Where it writes files that must survive a redeploy (uploads, SQLite databases, generated data).
- The default branch name and the GitHub owner/repository (from `git remote -v`).

If the repository holds several deployable services (a monorepo), handle each one: one Dockerfile per service, one image per service in the workflow (a matrix), and all of them in one compose file.

## Step 2: Dockerfile

- Use a multi-stage build: install and build in one stage, copy only what runs into a slim final stage.
- Pin the base image to a major version (`node:22-alpine`, `python:3.13-slim`, `golang:1.25` → `gcr.io/distroless/static`), not `latest`.
- Install dependencies from the lockfile first and copy the source after, so layers cache (`npm ci`, `pnpm install --frozen-lockfile`, `pip install -r requirements.txt`, `uv sync --frozen`, `go mod download`).
- Run as a non-root user.
- `ENV PORT=<port>` with the app's real port, `EXPOSE` that port, and make the app listen on `0.0.0.0:$PORT`.
- Add a `HEALTHCHECK` that calls the health endpoint with a tool that exists in the final image (`wget -qO- http://127.0.0.1:$PORT/health || exit 1` on Alpine; a tiny script in the app's language on distroless).
- Framework hints: Next.js uses `output: "standalone"` and copies `.next/standalone`, `.next/static` and `public`. Vite/React/static sites build in a Node stage and serve `dist/` with `nginx:alpine` or `caddy:2-alpine` on port 80 with an SPA fallback. Django/Flask/FastAPI run under `gunicorn`/`uvicorn` with workers, and run migrations in an entrypoint or a separate compose service, not at build time.
- No secrets in the image: no `.env` copied, no build args holding tokens. Values that are only known at build time and are public (like `NEXT_PUBLIC_*`) may be build args.

Make sure `docker build .` would succeed: every file the Dockerfile copies exists, and the build command matches the project's scripts.

## Step 3: .dockerignore

At least: `.git`, `.github`, `node_modules`, build output folders, `.env`, `.env.*` (but keep `!.env.example`), logs, test coverage, `Dockerfile*`, `docker-compose*.yml`, editor folders, and OS files.

## Step 4: GitHub Actions workflow

Create `.github/workflows/docker-publish.yml`:

```yaml
name: Docker image

on:
  push:
    branches: [main]          # use the repository's default branch
    tags: ["v*"]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read
  packages: write

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: docker/setup-qemu-action@v4
      - uses: docker/setup-buildx-action@v4
      - name: Log in to GHCR
        if: github.event_name != 'pull_request'
        uses: docker/login-action@v4
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v6
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=sha,format=short
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=ref,event=pr
      - uses: docker/build-push-action@v7
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    # Optional: tell DeployNow to roll out the new image.
    # Set the secrets DEPLOYNOW_URL (https://your-deploynow) and DEPLOYNOW_TOKEN
    # (Account → API tokens) and the variable DEPLOYNOW_APP_ID (the app's id from its URL).
    needs: build
    if: github.event_name == 'push' && github.ref_name == github.event.repository.default_branch && vars.DEPLOYNOW_APP_ID != ''
    runs-on: ubuntu-latest
    steps:
      - name: Deploy with DeployNow
        env:
          DEPLOYNOW_URL: ${{ secrets.DEPLOYNOW_URL }}
          DEPLOYNOW_TOKEN: ${{ secrets.DEPLOYNOW_TOKEN }}
        run: |
          curl -fsS -X POST "${DEPLOYNOW_URL%/}/api/apps/${{ vars.DEPLOYNOW_APP_ID }}/deploy" \
            -H "Authorization: Bearer $DEPLOYNOW_TOKEN" \
            -H "Content-Type: application/json" -d '{}'
```

Adjust the branch, the build context and, for a monorepo, add a matrix over services (`context: ./apps/<service>`, image `ghcr.io/<owner>/<repo>-<service>`). If the repository already has a workflow that builds images, extend it rather than adding a second one.

## Step 5: docker-compose.yml for DeployNow

DeployNow runs this file on the server. Follow these rules:

- The app service uses the published image, not `build:`: `image: ghcr.io/<owner>/<repo>:${IMAGE_TAG:-latest}`.
- **Do not publish ports** (`ports:`) for web services. DeployNow's Traefik routes the domain you add in the UI to the container. Use `expose: ["<port>"]` instead. Databases never get `ports:` either.
- `env_file: .env` on services that need configuration. DeployNow writes the app's environment variables and secrets to `.env` next to the compose file at deploy time. Use `${NAME}` substitution for values shared between services (for example the database password).
- Persistent data goes in **named volumes** (`db-data:/var/lib/postgresql/data`, `uploads:/app/uploads`), declared under the top-level `volumes:`. DeployNow backs up named volumes and dumps databases; bind mounts to host paths are not portable.
- Every service has `restart: unless-stopped` and, where possible, a `healthcheck`. The app `depends_on` its database with `condition: service_healthy`.
- Databases use official images pinned to a major version (`postgres:17-alpine`, `redis:7-alpine`, `mysql:8.4`, `mongo:8`).
- Run one-off migrations as a separate service (`command: <migrate command>`, `restart: "no"`) that the app depends on with `condition: service_completed_successfully`, or in the app's entrypoint, whichever the framework expects.

Example:

```yaml
services:
  web:
    image: ghcr.io/acme/shop:${IMAGE_TAG:-latest}
    restart: unless-stopped
    env_file: .env
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@db:5432/app
    expose: ["3000"]
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health"]
      interval: 15s
      timeout: 5s
      retries: 5

  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_DB: app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  db-data:
```

If the user also wants to run it locally, add `docker-compose.override.yml` with `build: .` and `ports:` for local use only; compose loads it automatically on a laptop, and DeployNow uses only the file it is pointed at.

## Step 6: .env.example

- One line per variable the app or compose file reads, grouped with `#` comment headers.
- Placeholders, never real values: `POSTGRES_PASSWORD=change-me`, `API_KEY=`.
- A comment above each variable saying what it is and whether it is a secret. DeployNow's **Import .env** marks names containing PASSWORD, SECRET, TOKEN, API_KEY, PRIVATE or ending in _KEY as secrets automatically, so keep those words in secret names.
- Make sure `.env` is in `.gitignore`.

## Step 7: Health endpoint

For web services without one, add `GET /health` returning `200` with a tiny JSON body (`{"status":"ok"}`), without authentication, without hitting slow dependencies. Wire it into the Dockerfile `HEALTHCHECK` and the compose `healthcheck`. DeployNow waits for a healthy container before it switches traffic, which is what makes deploys zero-downtime.

## Step 8: DEPLOY.md

Write a short page for the user:

1. Push to the default branch. The **Docker image** workflow publishes `ghcr.io/<owner>/<repo>:latest`.
2. If the package is private, add a GHCR login in DeployNow (a GitHub token with `read:packages`): **Account → My registry logins** for yourself, or **Settings → Registries** for a shared service account.
3. Create a project and an app. Either **Image** source with `ghcr.io/<owner>/<repo>:latest` and port `<port>` (single service), or **Compose from Git** pointing at this repository and `docker-compose.yml` (several services).
4. **Environment** tab → **Import .env**, paste your filled-in copy of `.env.example`.
5. **Domains** tab: add the domain. DeployNow gets the certificate.
6. Optional: turn on push-to-deploy, either with the GitHub webhook from the app's Settings tab (Git apps) or by setting `DEPLOYNOW_URL`, `DEPLOYNOW_TOKEN` and `DEPLOYNOW_APP_ID` for the workflow's deploy job (image apps).
7. Optional: add a backup policy for the database and volumes.

## Step 9: Check your work

- `docker build .` succeeds (run it if Docker is available).
- `docker compose config` parses the compose file (with a copy of `.env.example` as `.env`).
- The workflow YAML is valid and the image name is lowercase.
- Nothing in the diff contains a real secret.
- Then tell the user, in a few lines, which files you added or changed, the port and health path, the variables they must fill in, and the next step in DeployNow.
