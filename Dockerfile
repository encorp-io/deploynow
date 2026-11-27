# ─── Stage 1: deps ────────────────────────────────────────────────────────────
# Pin digest to prevent silent supply-chain substitution.
# Update intentionally: docker pull node:22-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:22-alpine
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS deps
WORKDIR /app

RUN apk add --no-cache libc6-compat openssl

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

# ─── Stage 2: builder ─────────────────────────────────────────────────────────
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS builder
WORKDIR /app

RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# The release tag (v2.1.0) or empty for package.json's version
ARG DEPLOYNOW_VERSION=""
ENV DEPLOYNOW_VERSION=${DEPLOYNOW_VERSION}
# AUTH_SECRET must never be baked into the image — required at runtime only.
# DATABASE_URL is only needed for prisma db push at build time.
ENV DATABASE_URL="file:/tmp/build-dummy.db"

RUN npx prisma generate && npx prisma migrate deploy
RUN mkdir -p public
RUN npx next build
# The self-updater (src/lib/selfUpdate/runner.ts) as plain Node, run from this image by a helper container
RUN node scripts/build-updater.cjs /app/updater

# ─── Stage 3: runner ──────────────────────────────────────────────────────────
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS runner
WORKDIR /app

# openssl  — needed for self-signed cert generation at startup
# nginx    — SSL termination proxy (port 9444 → internal Next.js on 3001)
# git, docker CLI with compose and buildx — the deploy pipeline (clone, build, compose up)
# restic — backs up DeployNow's own data (endpoint data is backed up by a restic container there)
RUN apk add --no-cache openssl nginx git docker-cli docker-cli-compose docker-cli-buildx restic

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="file:/data/deployer.db"
# Next.js listens on loopback only — nginx is the public-facing listener
ENV PORT=3001
ENV HOSTNAME="127.0.0.1"
# Trust the proxy (nginx) — NextAuth needs this when behind a reverse proxy
ENV AUTH_TRUST_HOST=true

# ── Non-root user ─────────────────────────────────────────────────────────────
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 --ingroup nodejs nextjs

# ── Persistent data directory (database + generated TLS certs) ────────────────
RUN mkdir -p /data/certs && chown -R nextjs:nodejs /data

# ── nginx temp dirs (must be writable by nextjs user) ─────────────────────────
RUN mkdir -p /tmp/nginx_client_body /tmp/nginx_proxy \
             /tmp/nginx_fastcgi /tmp/nginx_uwsgi /tmp/nginx_scgi && \
    chown -R nextjs:nodejs /tmp/nginx_client_body /tmp/nginx_proxy \
                           /tmp/nginx_fastcgi /tmp/nginx_uwsgi /tmp/nginx_scgi

# ── nginx config ──────────────────────────────────────────────────────────────
COPY --chown=nextjs:nodejs nginx/nginx.conf /app/nginx/nginx.conf

# ── Next.js standalone output ─────────────────────────────────────────────────
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# ── Prisma runtime (migrations run at container start) ────────────────────────
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma              ./prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
# bcryptjs — verifies v1 password hashes until they are rehashed on login
COPY --from=builder /app/node_modules/bcryptjs ./node_modules/bcryptjs

# ── Self-updater (Settings → Updates → Update now) ──────────────────────────
COPY --from=builder --chown=nextjs:nodejs /app/updater ./updater

# ── Entrypoint ────────────────────────────────────────────────────────────────
COPY --chown=nextjs:nodejs docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# /data  — SQLite database + generated TLS cert (persisted volume)
# /certs — optional mount point for user-provided real TLS certificate
VOLUME ["/data", "/certs"]

# 9444 — HTTPS (nginx frontend)
# 8444 — agent hub (mutual TLS; remote agents connect out to it)
# 3001 is intentionally NOT exposed — it is loopback-only inside the container
EXPOSE 9444 8444

USER nextjs

# /api/health answers once the app and its database are up (Next.js on loopback :3001)
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
