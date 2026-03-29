#!/bin/sh
set -e

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
    const adminPass = process.env.ADMIN_PASSWORD || 'admin';
    const hash = await bcrypt.hash(adminPass, 12);
    await prisma.user.create({
      data: { email: adminEmail, name: 'Admin', password: hash, role: 'admin' }
    });
    await prisma.settings.upsert({
      where: { id: 'singleton' },
      update: {},
      create: { id: 'singleton', portainerUrl: '', portainerApiKey: '', githubToken: '', pollingInterval: 60, autoUpdateLatest: true }
    });
    console.log('[deployer] Admin created: ' + adminEmail + ' / ' + adminPass);
    console.log('[deployer] IMPORTANT: Change your admin password after first login!');
  } else {
    console.log('[deployer] Users exist, skipping seed');
  }
  await prisma.\$disconnect();
}
seed().catch(e => { console.error(e); process.exit(1); });
"

echo "[deployer] Starting Next.js server..."
exec node server.js
