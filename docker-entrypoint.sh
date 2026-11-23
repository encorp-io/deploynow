#!/bin/sh
set -e

# ── Validate required env vars ────────────────────────────────────────────────
if [ -z "$AUTH_SECRET" ] || [ "$AUTH_SECRET" = "build-placeholder-replaced-at-runtime" ]; then
  echo "[deployer] ERROR: AUTH_SECRET is not set."
  echo "[deployer]        Generate one with: openssl rand -base64 32"
  exit 1
fi

# ── Database migrations ───────────────────────────────────────────────────────
echo "[deployer] Running database migrations..."
DATABASE_URL="${DATABASE_URL:-file:/data/deployer.db}" \
  node node_modules/prisma/build/index.js db push --schema=./prisma/schema.prisma --skip-generate

# ── Seed initial admin user (first boot only) ─────────────────────────────────
echo "[deployer] Checking for initial admin user..."
DATABASE_URL="${DATABASE_URL:-file:/data/deployer.db}" \
  node -e "
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function seed() {
  const count = await prisma.user.count();
  if (count === 0) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@encorp.io';
    const adminPass  = process.env.ADMIN_PASSWORD;

    if (!adminPass) {
      console.error('[deployer] ERROR: ADMIN_PASSWORD env var is required on first boot.');
      process.exit(1);
    }
    if (adminPass.length < 12) {
      console.error('[deployer] ERROR: ADMIN_PASSWORD must be at least 12 characters.');
      process.exit(1);
    }

    const hash = await bcrypt.hash(adminPass, 12);
    await prisma.user.create({
      data: { email: adminEmail, name: 'Admin', password: hash, role: 'owner' }
    });
    console.log('[deployer] Owner account created: ' + adminEmail + ' (set up 2FA at first sign-in)');
  } else {
    console.log('[deployer] Users exist — skipping user seed');
  }

  // Seed settings. GitHub credentials can come from env so onboarding can skip that step.
  // v2 connects to Docker directly; PORTAINER_* variables are no longer used.
  const githubUser  = process.env.GITHUB_USER  || '';
  const githubToken = process.env.GITHUB_TOKEN || '';
  if (process.env.PORTAINER_URL || process.env.PORTAINER_API_KEY) {
    console.log('[deployer] Note: PORTAINER_URL / PORTAINER_API_KEY are ignored in v2. Mount /var/run/docker.sock or add an SSH endpoint instead.');
  }

  function encrypt(plaintext) {
    if (!plaintext) return '';
    const crypto = require('crypto');
    const key = crypto.pbkdf2Sync(process.env.AUTH_SECRET, 'encorp-deployer-secrets-v1', 100000, 32, 'sha256');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  const settings = await prisma.settings.findUnique({ where: { id: 'singleton' } });
  if (!settings) {
    await prisma.settings.create({
      data: { id: 'singleton', githubUser, githubToken: encrypt(githubToken), pollingInterval: 60, autoUpdateLatest: false, schemaVersion: 2 }
    });
    console.log('[deployer] Settings created' + (githubToken ? ' with GitHub token from env' : ''));
  } else {
    const updates = {};
    if (githubUser && !settings.githubUser) updates.githubUser = githubUser;
    if (githubToken && !settings.githubToken) updates.githubToken = encrypt(githubToken);
    if (Object.keys(updates).length > 0) {
      await prisma.settings.update({ where: { id: 'singleton' }, data: updates });
      console.log('[deployer] Settings updated from env vars: ' + Object.keys(updates).join(', '));
    }
  }
  await prisma.\$disconnect();
}
seed().catch(e => { console.error(e.message); process.exit(1); });
"

# ── Docker socket check ───────────────────────────────────────────────────────
if [ -S /var/run/docker.sock ]; then
  if [ -r /var/run/docker.sock ] && [ -w /var/run/docker.sock ]; then
    echo "[deployer] Docker socket is mounted and accessible"
  else
    echo "[deployer] WARNING: /var/run/docker.sock is mounted but not accessible to uid $(id -u)."
    echo "[deployer]          Add the socket's group with group_add (see docker-compose.yml): stat -c %g /var/run/docker.sock"
  fi
else
  echo "[deployer] Docker socket not mounted. Add remote machines over SSH or TLS in the UI."
fi

# ── TLS certificate setup ─────────────────────────────────────────────────────
#
# Priority order:
#   1. CERT_FILE / KEY_FILE env vars point to user-provided PEM files
#   2. /certs/cert.pem + /certs/key.pem (mounted volume with real cert)
#   3. Auto-generate a self-signed cert into /data/certs/ (persisted across restarts)
#
mkdir -p /data/certs

CERT_FILE="${CERT_FILE:-}"
KEY_FILE="${KEY_FILE:-}"

if [ -n "$CERT_FILE" ] && [ -n "$KEY_FILE" ]; then
  # ── User provided explicit paths via env vars ──────────────────────────────
  if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
    echo "[deployer] ERROR: CERT_FILE / KEY_FILE set but files not found:"
    echo "[deployer]   CERT_FILE=$CERT_FILE"
    echo "[deployer]   KEY_FILE=$KEY_FILE"
    exit 1
  fi
  echo "[deployer] Using certificate from CERT_FILE / KEY_FILE env vars"
  cp "$CERT_FILE" /data/certs/cert.pem
  cp "$KEY_FILE"  /data/certs/key.pem

elif [ -f "/certs/cert.pem" ] && [ -f "/certs/key.pem" ]; then
  # ── User mounted a real cert at /certs ────────────────────────────────────
  echo "[deployer] Using certificate from /certs volume mount"
  cp /certs/cert.pem /data/certs/cert.pem
  cp /certs/key.pem  /data/certs/key.pem

elif [ ! -f "/data/certs/cert.pem" ] || [ ! -f "/data/certs/key.pem" ]; then
  # ── Generate a self-signed certificate (first boot) ───────────────────────
  echo "[deployer] No certificate found — generating self-signed certificate..."

  # Build SAN list: always include localhost; optionally include custom hostname
  COMMON_NAME="${TLS_HOSTNAME:-encorp-deployer}"
  SAN="DNS:localhost,DNS:${COMMON_NAME},IP:127.0.0.1"

  cat > /tmp/ssl.cnf << EOF
[req]
default_bits       = 4096
default_md         = sha256
prompt             = no
distinguished_name = dn
x509_extensions    = v3_req

[dn]
CN = ${COMMON_NAME}
O  = Encorp Deployer
C  = US

[v3_req]
subjectAltName     = ${SAN}
keyUsage           = keyEncipherment, dataEncipherment, digitalSignature
extendedKeyUsage   = serverAuth
basicConstraints   = CA:FALSE
EOF

  openssl req -x509 \
    -newkey rsa:4096 \
    -keyout /data/certs/key.pem \
    -out    /data/certs/cert.pem \
    -days   3650 \
    -nodes \
    -config /tmp/ssl.cnf

  echo "[deployer] Self-signed certificate generated (valid 10 years)"
  echo "[deployer] To use a real certificate, mount it at /certs/cert.pem and /certs/key.pem"
  echo "[deployer] or set CERT_FILE and KEY_FILE environment variables."

else
  echo "[deployer] Reusing existing certificate from /data/certs"
fi

# Secure cert permissions
chmod 600 /data/certs/key.pem
chmod 644 /data/certs/cert.pem

# ── Start nginx (SSL termination on :9444 → Next.js on :3001) ─────────────────
echo "[deployer] Starting nginx (HTTPS :9444)..."
nginx -c /app/nginx/nginx.conf &
NGINX_PID=$!

# ── Start Next.js (loopback only — not exposed outside the container) ─────────
echo "[deployer] Starting Next.js (internal :3001)..."
PORT=3001 HOSTNAME=127.0.0.1 node --max-http-header-size=131072 server.js &
NEXT_PID=$!

echo "[deployer] Encorp Deployer is running at https://0.0.0.0:9444"

# ── Signal forwarding — clean shutdown when Docker sends SIGTERM ──────────────
terminate() {
  echo "[deployer] Shutting down..."
  nginx -s quit   2>/dev/null || true
  kill "$NEXT_PID" 2>/dev/null || true
  wait "$NGINX_PID" "$NEXT_PID" 2>/dev/null || true
  exit 0
}
trap terminate TERM INT

# ── Wait — exit the container if either process dies ─────────────────────────
wait "$NGINX_PID" "$NEXT_PID"
EXIT_CODE=$?

echo "[deployer] A child process exited with code $EXIT_CODE — stopping container"
nginx -s quit   2>/dev/null || true
kill "$NEXT_PID" 2>/dev/null || true
exit "$EXIT_CODE"
