import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env manually (no dotenv dependency needed)
try {
  const envPath = resolve(__dirname, "../.env");
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // .env not found — rely on actual environment variables
}

const prisma = new PrismaClient();

async function main() {
  const adminEmail = (process.env.ADMIN_EMAIL || "admin@encorp.io").toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword || adminPassword.length < 12) {
    throw new Error(
      "ADMIN_PASSWORD must be set and at least 12 characters. " +
      "Set it in .env or as an environment variable."
    );
  }

  const hashedPassword = await bcrypt.hash(adminPassword, 12);

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      name: "Admin",
      password: hashedPassword,
      role: "admin",
    },
  });

  // Seed settings — pre-populate from env vars if provided (skips onboarding wizard)
  const portainerUrl    = process.env.PORTAINER_URL || "";
  const portainerApiKey = process.env.PORTAINER_API_KEY || process.env.PORTAINER_KEY || "";
  const githubUser      = process.env.GITHUB_USER || "";
  const githubToken     = process.env.GITHUB_TOKEN || "";

  // Encrypt secrets if they are provided
  let encApiKey = "";
  let encGhToken = "";
  if (portainerApiKey || githubToken) {
    const crypto = await import("crypto");
    const authSecret = process.env.AUTH_SECRET;
    if (authSecret) {
      const key = crypto.pbkdf2Sync(authSecret, "encorp-deployer-secrets-v1", 100000, 32, "sha256");
      function encrypt(plaintext: string): string {
        if (!plaintext) return "";
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const authTag = cipher.getAuthTag();
        return Buffer.concat([iv, authTag, encrypted]).toString("base64");
      }
      encApiKey  = encrypt(portainerApiKey);
      encGhToken = encrypt(githubToken);
    }
  }

  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: {
      id: "singleton",
      portainerUrl,
      portainerApiKey: encApiKey,
      githubUser,
      githubToken: encGhToken,
      pollingInterval: 60,
      autoUpdateLatest: true,
    },
  });

  if (portainerUrl) {
    console.log(`Seed complete — Portainer URL pre-configured: ${portainerUrl}`);
  } else {
    console.log("Seed complete — onboarding wizard will appear on first login");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
