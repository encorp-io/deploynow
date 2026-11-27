import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export default async function HomePage() {
  const session = await auth();
  if (!session) redirect("/login");

  // No machines connected yet: start the onboarding wizard
  if ((await prisma.endpoint.count()) === 0) redirect("/onboarding");

  redirect("/overview");
}
