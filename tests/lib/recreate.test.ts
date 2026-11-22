import { describe, it, expect, vi } from "vitest";
import { containerOnlyConfig, networkEndpointConfig, recreateContainer } from "@/lib/docker/recreate";

const OLD_ID = "abcdef123456" + "0".repeat(52);

describe("containerOnlyConfig", () => {
  const imageConfig = {
    Env: ["PATH=/usr/bin", "NODE_VERSION=20"],
    Cmd: ["node", "server.js"],
    Labels: { "org.opencontainers.image.version": "1.0" },
    ExposedPorts: { "3000/tcp": {} },
    WorkingDir: "/app",
  };
  const config = {
    Hostname: "abcdef123456",
    Image: "ghcr.io/acme/app:latest",
    Env: ["PATH=/usr/bin", "NODE_VERSION=20", "DATABASE_URL=postgres://db"],
    Cmd: ["node", "server.js"],
    Labels: { "org.opencontainers.image.version": "1.0", "com.docker.compose.project": "acme" },
    ExposedPorts: { "3000/tcp": {}, "9229/tcp": {} },
    WorkingDir: "/app",
  };

  it("keeps only what the container set itself", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = containerOnlyConfig(config as any, imageConfig as any, "ghcr.io/acme/app:latest", OLD_ID);
    expect(out.Env).toEqual(["DATABASE_URL=postgres://db"]);
    expect(out.Labels).toEqual({ "com.docker.compose.project": "acme" });
    expect(out.ExposedPorts).toEqual({ "9229/tcp": {} });
    expect(out).not.toHaveProperty("Cmd");
    expect(out).not.toHaveProperty("WorkingDir");
    expect(out).not.toHaveProperty("Hostname");
  });

  it("keeps overrides that differ from the image", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = containerOnlyConfig({ ...config, Cmd: ["node", "worker.js"], Hostname: "web" } as any, imageConfig as any, "img:2", OLD_ID);
    expect(out.Cmd).toEqual(["node", "worker.js"]);
    expect(out.Hostname).toBe("web");
    expect(out.Image).toBe("img:2");
  });
});

describe("networkEndpointConfig", () => {
  it("drops the old short-id alias and keeps the rest", () => {
    expect(networkEndpointConfig({ Aliases: ["abcdef123456", "web"], Links: [], IPAMConfig: { IPv4Address: "10.0.0.5" } }, OLD_ID)).toEqual({
      Aliases: ["web"],
      IPAMConfig: { IPv4Address: "10.0.0.5" },
    });
    expect(networkEndpointConfig(undefined, OLD_ID)).toEqual({});
  });
});

describe("recreateContainer", () => {
  function fakeDocker(startFails = false) {
    const old = {
      inspect: vi.fn(async () => ({
        Id: OLD_ID,
        Name: "/web",
        Image: "sha256:old",
        Config: { Image: "nginx:latest", Env: ["A=1"], Labels: {} },
        HostConfig: { RestartPolicy: { Name: "always" } },
        State: { Running: true },
        NetworkSettings: { Networks: { bridge: { Aliases: null }, appnet: { Aliases: ["web"] } } },
      })),
      rename: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    const created = { id: "new", start: vi.fn(async () => { if (startFails) throw new Error("port in use"); }), remove: vi.fn(async () => {}) };
    const net = { connect: vi.fn(async () => {}) };
    const docker = {
      getContainer: vi.fn(() => old),
      getImage: vi.fn(() => ({ inspect: async () => ({ Config: { Env: [] } }) })),
      createContainer: vi.fn(async () => created),
      getNetwork: vi.fn(() => net),
    };
    return { docker, old, created, net };
  }

  it("swaps the container and keeps its name, network and restart policy", async () => {
    const { docker, old, net } = fakeDocker();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = await recreateContainer(docker as any, OLD_ID);
    expect(id).toBe("new");
    expect(old.rename).toHaveBeenCalledWith({ name: expect.stringMatching(/^web-old-/) });
    const opts = (docker.createContainer.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(opts).toMatchObject({ name: "web", HostConfig: { RestartPolicy: { Name: "always" } } });
    expect(net.connect).toHaveBeenCalled();
    expect(old.remove).toHaveBeenCalled();
  });

  it("rolls back when the new container won't start", async () => {
    const { docker, old, created } = fakeDocker(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(recreateContainer(docker as any, OLD_ID)).rejects.toThrow("port in use");
    expect(created.remove).toHaveBeenCalled();
    expect(old.rename).toHaveBeenLastCalledWith({ name: "web" });
    expect(old.start).toHaveBeenCalled();
    expect(old.remove).not.toHaveBeenCalled();
  });
});
