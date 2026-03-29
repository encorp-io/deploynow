import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export default async function HomePage() {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  // Check if onboarding is needed (no Portainer URL configured)
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!settings?.portainerUrl) {
    redirect("/onboarding");
  }

  redirect("/dashboard");
}
