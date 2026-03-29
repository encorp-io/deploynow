"use client";

import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import Sidebar from "@/components/Sidebar";

export default function TeamLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();

  async function handleSignOut() {
    await signOut({ redirect: false });
    router.push("/login");
  }

  return (
    <div className="min-h-screen">
      <Sidebar onSignOut={handleSignOut} />
      <main className="ml-64 p-8">{children}</main>
    </div>
  );
}
