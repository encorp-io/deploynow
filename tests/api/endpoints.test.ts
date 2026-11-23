import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  endpoint: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  roleBinding: { deleteMany: vi.fn() },
  $transaction: vi.fn(async () => []),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/endpointTest", () => ({ testConnection: vi.fn() }));
vi.mock("@/lib/endpoints", async (orig) => ({
  ...(await orig<typeof import("@/lib/endpoints")>()),
  refreshEndpoint: vi.fn(async (e: unknown) => e),
}));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { testConnection } from "@/lib/endpointTest";
import { encryptCredentials } from "@/lib/endpoints";
import { GET, POST } from "@/app/api/endpoints/route";
import { POST as TEST } from "@/app/api/endpoints/test/route";
import { GET as GET_ONE, PATCH, DELETE } from "@/app/api/endpoints/[id]/route";
import { POST as REFRESH } from "@/app/api/endpoints/[id]/refresh/route";
import { POST as PRUNE } from "@/app/api/endpoints/[id]/prune/route";

const A = "c" + "a".repeat(24);
const B = "c" + "b".repeat(24);
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nk\n-----END OPENSSH PRIVATE KEY-----";
const ssh = { id: A, name: "prod", type: "ssh", host: "10.0.0.2", port: 22, username: "deploy", credentials: encryptCredentials({ privateKey: KEY }), hostKeyFingerprint: "SHA256:pinned", labels: "", status: "online", updatedAt: new Date() };
const json = (method: string, body?: unknown) => new Request("http://x", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const p = (id = A) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  signOut();
  mockPrisma.endpoint.create.mockImplementation(async ({ data }: { data: object }) => ({ id: B, ...data }));
  mockPrisma.endpoint.update.mockImplementation(async ({ data }: { data: object }) => ({ ...ssh, ...data }));
});

describe("GET /api/endpoints", () => {
  it("shows only endpoints the person can see, without keys", async () => {
    mockPrisma.endpoint.findMany.mockResolvedValue([ssh, { ...ssh, id: B, name: "other" }]);
    signInAs("viewer");
    const list = await (await GET()).json();
    expect(list).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain("PRIVATE KEY");
  });
});

describe("POST /api/endpoints", () => {
  const body = { name: "new", type: "ssh", host: "10.0.0.9", privateKey: KEY };

  it("is admin only", async () => {
    signInAs("operator");
    expect((await POST(json("POST", body))).status).toBe(403);
  });

  it("tests before saving and pins the host key it saw", async () => {
    signInAs("admin");
    mockPrisma.endpoint.findUnique.mockResolvedValue(null);
    vi.mocked(testConnection).mockResolvedValue({ ok: true, hostKeyFingerprint: "SHA256:new" });
    const res = await POST(json("POST", body));
    expect(res.status).toBe(201);
    const data = mockPrisma.endpoint.create.mock.calls[0][0].data;
    expect(data.hostKeyFingerprint).toBe("SHA256:new");
    expect(data.credentials).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(await res.json())).not.toContain("PRIVATE KEY");
  });

  it("refuses an unreachable endpoint unless asked to save it offline", async () => {
    signInAs("admin");
    mockPrisma.endpoint.findUnique.mockResolvedValue(null);
    vi.mocked(testConnection).mockResolvedValue({ ok: false, error: "timeout" });
    expect((await POST(json("POST", body))).status).toBe(422);
    expect((await POST(json("POST", { ...body, saveOffline: true }))).status).toBe(201);
  });

  it("rejects duplicates and invalid input", async () => {
    signInAs("admin");
    mockPrisma.endpoint.findUnique.mockResolvedValue(ssh);
    expect((await POST(json("POST", body))).status).toBe(409);
    expect((await POST(json("POST", { ...body, host: "169.254.169.254" }))).status).toBe(400);
  });
});

describe("POST /api/endpoints/test", () => {
  it("uses the pinned key when editing the same host", async () => {
    signInAs("admin");
    mockPrisma.endpoint.findUnique.mockResolvedValue(ssh);
    vi.mocked(testConnection).mockResolvedValue({ ok: true });
    await TEST(json("POST", { id: A }));
    expect(vi.mocked(testConnection).mock.calls[0][1]).toBe("SHA256:pinned");
    await TEST(json("POST", { id: A, host: "10.0.0.3" }));
    expect(vi.mocked(testConnection).mock.calls[1][1]).toBe("");
  });
});

describe("/api/endpoints/[id]", () => {
  it("validates the id and checks it exists", async () => {
    signInAs("viewer");
    expect((await GET_ONE(json("GET"), p("bad"))).status).toBe(400);
    mockPrisma.endpoint.findUnique.mockResolvedValue(null);
    expect((await GET_ONE(json("GET"), p())).status).toBe(404);
    mockPrisma.endpoint.findUnique.mockResolvedValue(ssh);
    expect((await GET_ONE(json("GET"), p())).status).toBe(200);
    expect((await REFRESH(json("POST"), p())).status).toBe(200);
  });

  it("keeps the pin on the same host and re-pins on a new one", async () => {
    signInAs("admin");
    vi.mocked(testConnection).mockResolvedValue({ ok: true, hostKeyFingerprint: "SHA256:seen" });
    mockPrisma.endpoint.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id ? ssh : null));
    await PATCH(json("PATCH", { labels: "prod" }), p());
    expect(mockPrisma.endpoint.update.mock.calls[0][0].data.hostKeyFingerprint).toBe("SHA256:pinned");
    await PATCH(json("PATCH", { host: "10.0.0.50" }), p());
    expect(mockPrisma.endpoint.update.mock.calls[1][0].data.hostKeyFingerprint).toBe("SHA256:seen");
  });

  it("refuses a changed host key", async () => {
    signInAs("admin");
    mockPrisma.endpoint.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id ? ssh : null));
    vi.mocked(testConnection).mockResolvedValue({ ok: false, error: "SSH host key changed" });
    expect((await PATCH(json("PATCH", { labels: "x" }), p())).status).toBe(422);
  });

  it("deleting needs step-up and removes its grants", async () => {
    mockPrisma.endpoint.findUnique.mockResolvedValue(ssh);
    signInAs("admin", { totpEnabled: true });
    expect((await DELETE(json("DELETE"), p())).status).toBe(403);
    signInAs("admin", { totpEnabled: true, stepUpAt: new Date() });
    expect((await DELETE(json("DELETE"), p())).status).toBe(200);
    expect(mockPrisma.roleBinding.deleteMany).toHaveBeenCalledWith({ where: { scopeType: "endpoint", scopeId: A } });
  });

  it("an endpoint admin grant allows prune on that endpoint only", async () => {
    mockPrisma.endpoint.findUnique.mockResolvedValue(ssh);
    signInAs("viewer", { bindings: [{ role: "admin", scopeType: "endpoint", scopeId: B }] });
    expect((await PRUNE(json("POST", { kind: "images" }), p(A))).status).toBe(403);
    signInAs("viewer", { bindings: [{ role: "admin", scopeType: "endpoint", scopeId: A }] });
    expect((await PRUNE(json("POST", { kind: "everything" }), p(A))).status).toBe(400);
  });
});
