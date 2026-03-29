import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash("admin", 12);

  await prisma.user.upsert({
    where: { email: "admin@encorp.io" },
    update: {},
    create: {
      email: "admin@encorp.io",
      name: "Admin",
      password: hashedPassword,
      role: "admin",
    },
  });

  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: {
      id: "singleton",
      portainerUrl: "",
      portainerApiKey: "",
      githubToken: "",
      pollingInterval: 60,
      autoUpdateLatest: true,
    },
  });

  console.log("Seed complete");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
