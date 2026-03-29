import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
const mockPrisma = {
  settings: {
    findUnique: vi.fn(),
  },
};
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// Mock secretsCrypto
vi.mock("@/lib/secretsCrypto", () => ({
  decryptSecret: vi.fn((v: string) => v),
}));

// Mock http/https modules
vi.mock("https", () => {
  const mockReq = {
    on: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  };
  return {
    default: {
      request: vi.fn((_opts: any, cb: Function) => {
        // Simulate a response
        setTimeout(() => {
          const res = {
            statusCode: 200,
            on: vi.fn((event: string, handler: Function) => {
              if (event === "data") handler(Buffer.from(JSON.stringify([{ Id: 1, Name: "test" }])));
              if (event === "end") handler();
            }),
          };
          cb(res);
        }, 0);
        return mockReq;
      }),
      Agent: vi.fn(),
    },
  };
});

vi.mock("http", () => ({
  default: {
    request: vi.fn(),
  },
}));

describe("portainer — getSettings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws when settings are not configured", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue(null);
    // getSettings is private, but we test it via getEndpoints
    const { getEndpoints } = await import("@/lib/portainer");
    await expect(getEndpoints()).rejects.toThrow("Portainer not configured");
  });

  it("throws when portainerUrl is empty", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({
      portainerUrl: "",
      portainerApiKey: "key",
    });
    const { getEndpoints } = await import("@/lib/portainer");
    await expect(getEndpoints()).rejects.toThrow("Portainer not configured");
  });

  it("throws when portainerApiKey is empty", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({
      portainerUrl: "https://test:9443",
      portainerApiKey: "",
    });
    const { getEndpoints } = await import("@/lib/portainer");
    await expect(getEndpoints()).rejects.toThrow("Portainer not configured");
  });
});

describe("portainer — getConfiguredEndpointId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns endpoint ID from settings", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ portainerEndpointId: 5 });
    const { getConfiguredEndpointId } = await import("@/lib/portainer");
    const id = await getConfiguredEndpointId();
    expect(id).toBe(5);
  });

  it("defaults to 1 when no settings", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue(null);
    const { getConfiguredEndpointId } = await import("@/lib/portainer");
    const id = await getConfiguredEndpointId();
    expect(id).toBe(1);
  });
});

describe("portainer — parseImageRef (already tested)", () => {
  it("is exported", async () => {
    const { parseImageRef } = await import("@/lib/portainer");
    expect(typeof parseImageRef).toBe("function");
  });
});

describe("portainer — isFloatingTag (already tested)", () => {
  it("is exported", async () => {
    const { isFloatingTag } = await import("@/lib/portainer");
    expect(typeof isFloatingTag).toBe("function");
  });
});
