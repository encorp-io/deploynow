/**
 * Brings the database up to the current schema. docker-entrypoint.sh runs this
 * before DeployNow starts:
 *
 *   1. Before any pending migration runs, a copy of the database goes to
 *      <data dir>/db-backups/ (the last 5 are kept), so a failed upgrade can be undone
 *      by stopping DeployNow and copying the file back.
 *   2. Databases from before versioned migrations (made by `prisma db push`) are
 *      brought to the baseline with a non-destructive push, then marked as being
 *      at migration 0_init.
 *   3. `prisma migrate deploy` applies the migrations in prisma/migrations.
 *   4. SQLite runs in WAL mode, so the UI keeps reading while background jobs write.
 *
 * A migration that fails stops the container, and the backup path is printed.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const SCHEMA = path.join(__dirname, "schema.prisma");
const MIGRATIONS = path.join(__dirname, "migrations");
const BASELINE = "0_init";
const KEEP_BACKUPS = 5;
const log = (m) => console.log(`[deploynow] ${m}`);

function prismaCli(args) {
  const cli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [cli, ...args, `--schema=${SCHEMA}`], { stdio: "inherit", env: process.env });
}

function dbFile() {
  const url = process.env.DATABASE_URL || "";
  if (!url.startsWith("file:")) return null;
  const p = url.slice("file:".length).split("?")[0];
  return path.isAbsolute(p) ? p : path.resolve(__dirname, p);
}

function migrationNames() {
  if (!fs.existsSync(MIGRATIONS)) return [];
  return fs
    .readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(MIGRATIONS, d.name, "migration.sql")))
    .map((d) => d.name)
    .sort();
}

async function main() {
  const file = dbFile();
  const existed = !!file && fs.existsSync(file) && fs.statSync(file).size > 0;
  const prisma = new PrismaClient();
  let legacy = false;
  let pending = migrationNames();
  try {
    if (existed) {
      const tables = (await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
      if (tables.includes("_prisma_migrations")) {
        const applied = new Set(
          (await prisma.$queryRawUnsafe("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")).map((r) => r.migration_name),
        );
        pending = pending.filter((m) => !applied.has(m));
      } else {
        legacy = tables.includes("User");
      }

      if (pending.length > 0 || legacy) {
        const dir = path.join(path.dirname(file), "db-backups");
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const target = path.join(dir, `deployer-${stamp}.db`);
        await prisma.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
        log(`Database backed up to ${target} before upgrading`);
        const old = fs.readdirSync(dir).filter((f) => /^deployer-.*\.db$/.test(f)).sort();
        for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.rmSync(path.join(dir, f), { force: true });
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  if (legacy) {
    // Made by `prisma db push` (DeployNow before versioned migrations). The push only
    // adds what is missing and refuses anything that would lose data.
    log("Upgrading a database from before versioned migrations");
    prismaCli(["db", "push", "--skip-generate"]);
    prismaCli(["migrate", "resolve", "--applied", BASELINE]);
  }
  prismaCli(["migrate", "deploy"]);

  const after = new PrismaClient();
  try {
    await after.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  } finally {
    await after.$disconnect();
  }
}

main().catch((err) => {
  console.error(`[deploynow] ERROR: database migration failed: ${err && err.message ? err.message : err}`);
  console.error("[deploynow]        Your data is unchanged or backed up in db-backups/ next to the database. See docs/upgrading.md.");
  process.exit(1);
});
