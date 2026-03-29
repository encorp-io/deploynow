#!/bin/sh
set -e

# ── Validate required env vars ────────────────────────────────────────────────
if [ -z "$AUTH_SECRET" ] || [ "$AUTH_SECRET" = "build-placeholder-replaced-at-runtime" ]; then
  echo "[deployer] ERROR: AUTH_SECRET is not set or is the default placeholder."
  echo "[deployer]        Generate one with: openssl rand -base64 32"
  exit 1
fi

echo "[deployer] Running database migrations..."
DATABASE_URL="${DATABASE_URL:-file:/data/deployer.db}" \
  node_modules/.bin/prisma db push --schema=./prisma/schema.prisma --skip-generate

echo "[deployer] Seeding initial admin user (idempotent)..."
DATABASE_URL="${DATABASE_URL:-file:/data/deployer.db}" \
  node -e "
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function seed() {
  const count = await prisma.user.count();
  if (count === 0) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@encorp.io';
    const adminPass = process.env.ADMIN_PASSWORD;

    if (!adminPass) {
      console.error('[deployer] ERROR: ADMIN_PASSWORD env var is required on first boot.');
      console.error('[deployer]        Set it to a strong password in your .env or docker-compose.yml');
      process.exit(1);
    }

    if (adminPass.length < 12) {
      console.error('[deployer] ERROR: ADMIN_PASSWORD must be at least 12 characters.');
      process.exit(1);
    }

    const hash = await bcrypt.hash(adminPass, 12);
    await prisma.user.create({
      data: { email: adminEmail, name: 'Admin', password: hash, role: 'admin' }
    });
    await prisma.settings.upsert({
      where: { id: 'singleton' },
      update: {},
      create: {
        id: 'singleton',
        portainerUrl: '',
        portainerApiKey: '',
        githubToken: '',
        pollingInterval: 60,
        autoUpdateLatest: true,
        portainerEndpointId: 1
      }
    });
    console.log('[deployer] Admin user created: ' + adminEmail);
  } else {
    console.log('[deployer] Users exist, skipping seed');
  }
  await prisma.\$disconnect();
}
seed().catch(e => { console.error(e); process.exit(1); });
"

echo "[deployer] Starting Next.js server..."
exec node server.js
