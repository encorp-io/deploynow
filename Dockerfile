# ─── Stage 1: deps ────────────────────────────────────────────────────────────
# Pin digest to prevent silent supply-chain substitution.
# Update intentionally: docker pull node:22-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:22-alpine
FROM node:22-alpine@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS deps
WORKDIR /app

RUN apk add --no-cache libc6-compat openssl

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

# ─── Stage 2: builder ─────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS builder
WORKDIR /app

RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# AUTH_SECRET must never be baked into the image — required at runtime only.
# DATABASE_URL is only needed for prisma db push at build time.
ENV DATABASE_URL="file:/tmp/build-dummy.db"

RUN npx prisma generate && npx prisma db push --skip-generate
RUN mkdir -p public
RUN npx next build

# ─── Stage 3: runner ──────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS runner
WORKDIR /app

# openssl  — needed for self-signed cert generation at startup
# nginx    — SSL termination proxy (port 9444 → internal Next.js on 3001)
RUN apk add --no-cache openssl nginx

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="file:/data/deployer.db"
# Next.js listens on loopback only — nginx is the public-facing listener
ENV PORT=3001
ENV HOSTNAME="127.0.0.1"

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
# bcryptjs — used by seed script in docker-entrypoint.sh
COPY --from=builder /app/node_modules/bcryptjs ./node_modules/bcryptjs

# ── Entrypoint ────────────────────────────────────────────────────────────────
COPY --chown=nextjs:nodejs docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# /data  — SQLite database + generated TLS cert (persisted volume)
# /certs — optional mount point for user-provided real TLS certificate
VOLUME ["/data", "/certs"]

# 9444 — HTTPS (nginx frontend)
# 3001 is intentionally NOT exposed — it is loopback-only inside the container
EXPOSE 9444

USER nextjs

ENTRYPOINT ["/app/docker-entrypoint.sh"]
