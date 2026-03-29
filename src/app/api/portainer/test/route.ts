import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEndpoints } from "@/lib/portainer";

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const endpoints = await getEndpoints();
    return NextResponse.json({
      success: true,
      endpoints: endpoints.map((e) => ({ id: e.Id, name: e.Name })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
