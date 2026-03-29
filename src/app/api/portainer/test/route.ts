import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEndpoints } from "@/lib/portainer";

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const endpoints = await getEndpoints();

    // Auto-set the endpoint ID to the first available endpoint
    // if the current setting points to a non-existent endpoint
    if (endpoints.length > 0) {
      const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
      const currentEndpointId = settings?.portainerEndpointId ?? 1;
      const endpointIds = endpoints.map((e) => e.Id);

      if (!endpointIds.includes(currentEndpointId)) {
        await prisma.settings.update({
          where: { id: "singleton" },
          data: { portainerEndpointId: endpoints[0].Id },
        });
      }
    }

    return NextResponse.json({
      success: true,
      endpoints: endpoints.map((e) => ({ id: e.Id, name: e.Name })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
