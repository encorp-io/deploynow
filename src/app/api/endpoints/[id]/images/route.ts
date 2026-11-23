import { listResources, removeResource } from "@/lib/resourceRoutes";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  return listResources("images", (await params).id);
}

export async function DELETE(request: Request, { params }: Params) {
  return removeResource("images", (await params).id, request);
}
