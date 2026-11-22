import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({ endpoint: { count: vi.fn() }, settings: { findUnique: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/endpoints", () => ({ localSocketAvailable: vi.fn(() => true) }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { GET } from "@/app/api/onboarding/route";

beforeEach(() => {
  vi.clearAllMocks();
  signOut();
});

describe("GET /api/onboarding", () => {
  it("returns 401 when signed out", async () => {
    expect((await GET()).status).toBe(401);
  });

  it("needs onboarding until an endpoint exists", async () => {
    signInAs("owner");
    mockPrisma.endpoint.count.mockResolvedValue(0);
    mockPrisma.settings.findUnique.mockResolvedValue({ githubToken: "", portainerUrl: "https://p:9443" });
    const data = await (await GET()).json();
    expect(data).toMatchObject({ needsOnboarding: true, localSocketAvailable: true, hadPortainer: true, hasGithubToken: false });
  });

  it("is done once there is an endpoint", async () => {
    signInAs("viewer");
    mockPrisma.endpoint.count.mockResolvedValue(2);
    mockPrisma.settings.findUnique.mockResolvedValue(null);
    const data = await (await GET()).json();
    expect(data).toMatchObject({ needsOnboarding: false, endpointCount: 2, hadPortainer: false });
  });
});
