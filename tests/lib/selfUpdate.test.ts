import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  demuxLogs,
  isPinnedTag,
  judgeHealth,
  nextImageRef,
  readStatus,
  restoreDb,
  setEnvValue,
  snapshotDb,
  splitRef,
  waitHealthy,
  writeStatus,
  type SelfUpdateStatus,
} from "@/lib/selfUpdate/shared";

const store = vi.hoisted(() => ({ s: null as Record<string, unknown> | null, services: [] as { containerId: string; remoteDigest: string }[] }));
const target = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    settings: { findUnique: vi.fn(async () => store.s) },
    service: { findMany: vi.fn(async () => store.services) },
  },
}));
vi.mock("@/lib/version", () => ({ VERSION: "2.0.0" }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/registryAuth", () => ({ registryAuthFor: vi.fn(async () => undefined) }));
const remote = vi.hoisted(() => ({ digest: "sha256:edge1" as string | null }));
vi.mock("@/lib/ghcr", () => ({ getRemoteDigests: vi.fn(async () => (remote.digest ? { config: "sha256:cfg", manifest: remote.digest } : null)) }));
const verify = vi.hoisted(() => ({ fail: "" }));
vi.mock("@/lib/selfUpdate/verify", async () => {
  const real = await vi.importActual<typeof import("@/lib/selfUpdate/verify")>("@/lib/selfUpdate/verify");
  return {
    ...real,
    verifyTarget: vi.fn(async (...args: Parameters<typeof real.verifyTarget>) => {
      if (verify.fail) throw new real.VerifyError(verify.fail);
      return real.verifyTarget(...args);
    }),
  };
});
vi.mock("@/lib/platformDomain", () => ({
  findLocalTarget: vi.fn(async () => target.value),
  selfContainerCandidates: () => ["aaaaaaaaaaaa"],
}));

import { autoUpdateTick, bindFor, inWindow, isSelfContainer, mountFor, prepare, startSelfUpdate } from "@/lib/selfUpdate";

describe("picking the image", () => {
  it("tells pinned tags from moving ones", () => {
    expect(isPinnedTag("2.0.0")).toBe(true);
    expect(isPinnedTag("v2.1.0-rc.1")).toBe(true);
    expect(isPinnedTag("latest")).toBe(false);
    expect(isPinnedTag("2.1")).toBe(false);
    expect(isPinnedTag("edge")).toBe(false);
  });

  it("splits references and refuses digests", () => {
    expect(splitRef("ghcr.io/encorp-io/deploynow:2.0.0")).toEqual({ repo: "ghcr.io/encorp-io/deploynow", tag: "2.0.0" });
    expect(splitRef("localhost:5000/deploynow")).toEqual({ repo: "localhost:5000/deploynow", tag: "latest" });
    expect(splitRef("ghcr.io/encorp-io/deploynow@sha256:abc")).toBeNull();
    expect(splitRef("sha256:abc")).toBeNull();
  });

  it("moves a pinned tag to the newest release and pulls a moving tag again", () => {
    expect(nextImageRef("ghcr.io/encorp-io/deploynow:2.0.0", "2.1.0")).toEqual({ ref: "ghcr.io/encorp-io/deploynow:2.1.0", pinned: true, tag: "2.1.0", changed: true });
    expect(nextImageRef("ghcr.io/encorp-io/deploynow:v2.0.0", "2.1.0")?.ref).toBe("ghcr.io/encorp-io/deploynow:v2.1.0");
    expect(nextImageRef("ghcr.io/encorp-io/deploynow:latest", "")).toEqual({ ref: "ghcr.io/encorp-io/deploynow:latest", pinned: false, tag: "latest", changed: false });
    expect(nextImageRef("ghcr.io/encorp-io/deploynow:2.0.0", "")).toBeNull();
  });
});

describe("update channels", () => {
  const R = "ghcr.io/encorp-io/deploynow";
  it("stable pins the newest release, whatever runs now", () => {
    expect(nextImageRef(`${R}:edge`, "1.0.0", "stable")).toEqual({ ref: `${R}:1.0.0`, pinned: true, tag: "1.0.0", changed: true });
    expect(nextImageRef(`${R}:latest`, "1.0.0", "stable")?.ref).toBe(`${R}:1.0.0`);
    expect(nextImageRef(`${R}:1.0.0`, "1.0.0", "stable")).toMatchObject({ changed: false, pinned: true });
    expect(nextImageRef(`${R}:edge`, "", "stable")).toBeNull();
  });
  it("edge follows builds from main", () => {
    expect(nextImageRef(`${R}:1.0.0`, "1.0.0", "edge")).toEqual({ ref: `${R}:edge`, pinned: false, tag: "edge", changed: true });
    expect(nextImageRef(`${R}:edge`, "1.0.0", "edge")).toMatchObject({ changed: false, pinned: false });
  });
});

describe("setEnvValue", () => {
  it("replaces the value and keeps the rest", () => {
    expect(setEnvValue("AUTH_SECRET=x\nDEPLOYNOW_TAG=2.0.0\n# c\n", "DEPLOYNOW_TAG", "2.1.0")).toBe("AUTH_SECRET=x\nDEPLOYNOW_TAG=2.1.0\n# c\n");
    expect(setEnvValue("export DEPLOYNOW_TAG = 2.0.0", "DEPLOYNOW_TAG", "2.1.0")).toBe("export DEPLOYNOW_TAG = 2.1.0");
    expect(setEnvValue("A=1\n", "DEPLOYNOW_TAG", "2.1.0")).toBeNull();
    expect(setEnvValue("MY_DEPLOYNOW_TAG=1\n", "DEPLOYNOW_TAG", "2.1.0")).toBeNull();
  });
});

describe("database snapshot", () => {
  it("restores the file and drops WAL files made since", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-snap-"));
    const db = path.join(dir, "deployer.db");
    fs.writeFileSync(db, "v1");
    expect(snapshotDb(db, path.join(dir, "snap"))).toEqual([""]);
    fs.writeFileSync(db, "migrated");
    fs.writeFileSync(`${db}-wal`, "wal");
    restoreDb(db, path.join(dir, "snap"));
    expect(fs.readFileSync(db, "utf8")).toBe("v1");
    expect(fs.existsSync(`${db}-wal`)).toBe(false);
    expect(() => restoreDb(db, path.join(dir, "none"))).toThrow(/No database snapshot/);
  });
});

describe("status file", () => {
  it("round-trips", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dn-st-")), "self-update", "status.json");
    expect(readStatus(file)).toBeNull();
    const s: SelfUpdateStatus = { id: "1", state: "checking", fromVersion: "2.0.0", fromImage: "sha256:a", targetRef: "x:2.1.0", targetVersion: "2.1.0", startedAt: "now" };
    writeStatus(file, s);
    expect(readStatus(file)).toEqual(s);
  });
});

describe("health", () => {
  const base = { RestartCount: 0, State: { Status: "running", Running: true, Restarting: false, ExitCode: 0, StartedAt: new Date(0).toISOString() } };
  it("judges one look", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j = (x: any, now = 1000) => judgeHealth({ ...base, ...x, State: { ...base.State, ...(x.State ?? {}) } } as any, now, 30_000);
    expect(j({ State: { Health: { Status: "healthy" } } })).toMatchObject({ done: true, ok: true });
    expect(j({ State: { Health: { Status: "unhealthy" } } })).toMatchObject({ done: true, ok: false });
    expect(j({ State: { Health: { Status: "starting" } } })).toMatchObject({ done: false });
    expect(j({ State: { Status: "exited", Running: false, ExitCode: 1 } }).reason).toMatch(/exit code 1/);
    expect(j({ RestartCount: 2 })).toMatchObject({ done: true, ok: false });
    expect(j({}, 10_000)).toMatchObject({ done: false });
    expect(j({}, 31_000)).toMatchObject({ done: true, ok: true });
  });

  it("waits until healthy, or gives up", async () => {
    const states = ["starting", "starting", "healthy"];
    const docker = { getContainer: () => ({ inspect: async () => ({ ...base, State: { ...base.State, Health: { Status: states.shift() ?? "healthy" } } }) }) };
    let t = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await waitHealthy(docker as any, "x", { timeoutMs: 60_000, sleep: async (ms) => void (t += ms), now: () => t })).toEqual({ ok: true, reason: "healthy" });
    const stuck = { getContainer: () => ({ inspect: async () => ({ ...base, State: { ...base.State, Health: { Status: "starting" } } }) }) };
    t = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await waitHealthy(stuck as any, "x", { timeoutMs: 9_000, sleep: async (ms) => void (t += ms), now: () => t });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/after 9s/);
  });

  it("reads Docker's framed logs", () => {
    const frame = (stream: number, text: string) => {
      const b = Buffer.from(text);
      const h = Buffer.alloc(8);
      h[0] = stream;
      h.writeUInt32BE(b.length, 4);
      return Buffer.concat([h, b]);
    };
    expect(demuxLogs(Buffer.concat([frame(1, "out\n"), frame(2, "err\n")]))).toBe("out\nerr\n");
    expect(demuxLogs(Buffer.from("plain"))).toBe("plain");
  });
});

describe("server side", () => {
  it("finds the mount that holds a path", () => {
    const mounts = [
      { Type: "volume", Name: "deployer_data", Destination: "/data" },
      { Type: "bind", Source: "/srv/certs", Destination: "/data/certs" },
    ];
    expect(mountFor(mounts, "/data")?.Name).toBe("deployer_data");
    expect(mountFor(mounts, "/data/certs/a")?.Source).toBe("/srv/certs");
    expect(mountFor(mounts, "/database")).toBeNull();
    expect(bindFor(mounts[0])).toBe("deployer_data:/data");
    expect(bindFor({ Type: "tmpfs", Destination: "/x" })).toBeNull();
  });

  it("knows its own container by short or long id", () => {
    expect(isSelfContainer("aaaaaaaaaaaa" + "1".repeat(52))).toBe(true);
    expect(isSelfContainer("bbbbbbbbbbbb")).toBe(false);
    expect(isSelfContainer("")).toBe(false);
  });

  it("keeps auto-update to its hour", () => {
    expect(inWindow(-1)).toBe(true);
    expect(inWindow(3, new Date(2026, 0, 1, 3, 30))).toBe(true);
    expect(inWindow(3, new Date(2026, 0, 1, 4, 0))).toBe(false);
  });
});

function fakeTarget(overrides: Record<string, unknown> = {}) {
  const helper = { start: vi.fn(async () => {}) };
  const docker = {
    modem: { followProgress: (_s: unknown, cb: (e: null, o: unknown[]) => void) => cb(null, []) },
    pull: vi.fn(async () => ({})),
    getImage: vi.fn(() => ({ inspect: async () => ({ Id: "sha256:new" }) })),
    getContainer: vi.fn(() => ({ inspect: async () => { throw new Error("no such container"); }, remove: vi.fn(async () => {}) })),
    createContainer: vi.fn(async () => helper),
  };
  return {
    docker,
    helper,
    value: {
      endpoint: { host: "/var/run/docker.sock", name: "local" },
      docker,
      self: {
        Id: "aaaaaaaaaaaa" + "1".repeat(52),
        Image: "sha256:old",
        Config: { Image: "ghcr.io/encorp-io/deploynow:2.0.0", Labels: { "com.docker.compose.project.working_dir": "/opt/deploynow" } },
        Mounts: [
          { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" },
          { Type: "volume", Name: "deployer_data", Destination: path.dirname(process.env.SELF_UPDATE_TEST_DB!) },
        ],
        ...overrides,
      },
    },
  };
}

describe("startSelfUpdate", () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-data-"));
    process.env.SELF_UPDATE_TEST_DB = path.join(dir, "deployer.db");
    process.env.DATABASE_URL = `file:${process.env.SELF_UPDATE_TEST_DB}`;
    delete process.env.DEPLOYNOW_SELF_UPDATE;
    process.env.DEPLOYNOW_VERIFY_IMAGES = "off"; // verify.ts has its own tests
    verify.fail = "";
    store.s = { latestRelease: "2.1.0", selfUpdateAuto: true, selfUpdateHour: -1 };
    store.services = [];
  });

  it("pulls the new release and starts the updater with the socket, data and compose .env", async () => {
    const t = fakeTarget();
    target.value = t.value;
    const st = await startSelfUpdate({ actor: { id: "u", email: "a@b.c" } });
    expect(st).toMatchObject({ state: "starting", fromVersion: "2.0.0", targetRef: "ghcr.io/encorp-io/deploynow:2.1.0", targetVersion: "2.1.0", actor: "a@b.c" });
    expect(t.docker.pull).toHaveBeenCalledWith("ghcr.io/encorp-io/deploynow:2.1.0", {});
    const opts = (t.docker.createContainer.mock.calls[0] as unknown[])[0] as { Image: string; Entrypoint: string[]; Env: string[]; HostConfig: { Binds: string[]; NetworkMode: string } };
    expect(opts.Image).toBe("sha256:old");
    expect(opts.Entrypoint).toEqual(["node", "/app/updater/selfUpdate/runner.js"]);
    expect(opts.HostConfig.NetworkMode).toBe("none");
    expect(opts.HostConfig.Binds).toEqual([
      "/var/run/docker.sock:/var/run/docker.sock",
      `deployer_data:${path.dirname(process.env.SELF_UPDATE_TEST_DB!)}`,
      "/opt/deploynow:/compose-env",
    ]);
    const plan = JSON.parse(opts.Env[0].replace(/^SELF_UPDATE_PLAN=/, ""));
    expect(plan).toMatchObject({ targetRef: "ghcr.io/encorp-io/deploynow:2.1.0", targetImageId: "sha256:new", envFile: "/compose-env/.env", envFileHost: "/opt/deploynow/.env", envTag: "2.1.0", dbFile: process.env.SELF_UPDATE_TEST_DB });
    expect(t.helper.start).toHaveBeenCalled();
  });

  it("follows the channel: stable from latest pins the release, edge from a release moves DEPLOYNOW_TAG to edge", async () => {
    store.s = { ...store.s, selfUpdateChannel: "stable" };
    let t = fakeTarget({ Config: { Image: "ghcr.io/encorp-io/deploynow:latest", Labels: { "com.docker.compose.project.working_dir": "/opt/deploynow" } } });
    target.value = t.value;
    expect(await startSelfUpdate()).toMatchObject({ targetRef: "ghcr.io/encorp-io/deploynow:2.1.0", targetVersion: "2.1.0" });
    let plan = JSON.parse(((t.docker.createContainer.mock.calls[0] as unknown[])[0] as { Env: string[] }).Env[0].replace(/^SELF_UPDATE_PLAN=/, ""));
    expect(plan.envTag).toBe("2.1.0");

    store.s = { ...store.s, selfUpdateChannel: "edge" };
    t = fakeTarget();
    target.value = t.value;
    expect(await startSelfUpdate()).toMatchObject({ targetRef: "ghcr.io/encorp-io/deploynow:edge", targetVersion: "" });
    plan = JSON.parse(((t.docker.createContainer.mock.calls[0] as unknown[])[0] as { Env: string[] }).Env[0].replace(/^SELF_UPDATE_PLAN=/, ""));
    expect(plan).toMatchObject({ envTag: "edge", envFile: "/compose-env/.env" });
  });

  it("stable on the newest release has nothing to do", async () => {
    target.value = fakeTarget({ Config: { Image: "ghcr.io/encorp-io/deploynow:2.1.0", Labels: {} } }).value;
    await expect(prepare("2.1.0", "stable")).rejects.toMatchObject({ code: "current" });
    await expect(prepare("2.1.0", "edge")).resolves.toMatchObject({ next: { tag: "edge", changed: true } });
  });

  it("refuses without the socket, when current, or when turned off", async () => {
    target.value = null;
    await expect(prepare("2.1.0")).rejects.toThrow(/local Docker socket/);
    target.value = fakeTarget().value;
    await expect(prepare("2.0.0")).rejects.toMatchObject({ code: "current" });
    const noSock = fakeTarget({ Mounts: [] });
    target.value = noSock.value;
    await expect(prepare("2.1.0")).rejects.toThrow(/socket isn't bind-mounted/);
    process.env.DEPLOYNOW_SELF_UPDATE = "off";
    await expect(prepare("2.1.0")).rejects.toMatchObject({ code: "disabled" });
  });

  it("doesn't start the updater when the image fails its check", async () => {
    const t = fakeTarget();
    target.value = t.value;
    verify.fail = "ghcr.io/encorp-io/deploynow:2.1.0 has no valid signature";
    await expect(startSelfUpdate()).rejects.toMatchObject({ code: "verify", message: expect.stringMatching(/no valid signature/) });
    expect(t.docker.pull).toHaveBeenCalled();
    expect(t.docker.createContainer).not.toHaveBeenCalled();
    const { audit } = await import("@/lib/audit");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure", details: expect.stringMatching(/no valid signature/) }));
  });

  it("doesn't start when the pulled image is the one running", async () => {
    const t = fakeTarget({ Config: { Image: "ghcr.io/encorp-io/deploynow:latest", Labels: {} }, Image: "sha256:new" });
    target.value = t.value;
    await expect(startSelfUpdate()).rejects.toMatchObject({ code: "current" });
    expect(t.docker.createContainer).not.toHaveBeenCalled();
  });

  it("on edge, doesn't pull when the registry still serves the running build", async () => {
    store.s = { ...store.s, selfUpdateChannel: "edge" };
    // Running edge, and the registry's edge manifest is the RepoDigest of the running image
    const t = fakeTarget({ Config: { Image: "ghcr.io/encorp-io/deploynow:edge", Labels: {} }, Image: "sha256:run" });
    t.docker.getImage.mockImplementation(((name: string) => ({
      inspect: async () => (name === "sha256:run" ? { Id: "sha256:run", RepoDigests: ["ghcr.io/encorp-io/deploynow@sha256:edge1"] } : { Id: "sha256:new" }),
    })) as never);
    target.value = t.value;
    await expect(startSelfUpdate()).rejects.toMatchObject({ code: "current", message: expect.stringMatching(/newest edge build/) });
    expect(t.docker.pull).not.toHaveBeenCalled();
    const { selfUpdateInfo, clearSelfUpdateCache } = await import("@/lib/selfUpdate");
    clearSelfUpdateCache();
    expect(await selfUpdateInfo("2.1.0")).toMatchObject({ supported: true, installable: false, reason: expect.stringMatching(/newest edge build/) });

    // A new edge build is out: Update now is offered and pulls it
    remote.digest = "sha256:edge2";
    clearSelfUpdateCache();
    expect(await selfUpdateInfo("2.1.0")).toMatchObject({ supported: true, installable: true });
    expect(await startSelfUpdate()).toMatchObject({ targetRef: "ghcr.io/encorp-io/deploynow:edge" });
    expect(t.docker.pull).toHaveBeenCalled();
    remote.digest = "sha256:edge1";
  });

  it("asks only GHCR and Docker Hub whether the running build is the newest", async () => {
    const { runsNewestBuild } = await import("@/lib/selfUpdate");
    const { getRemoteDigests } = await import("@/lib/ghcr");
    vi.mocked(getRemoteDigests).mockClear();
    const t = fakeTarget({ Config: { Image: "registry.example.com/team/deploynow:latest", Labels: {} } });
    expect(await runsNewestBuild({ target: t.value as never, next: { ref: "registry.example.com/team/deploynow:latest", tag: "latest", pinned: false, changed: false } })).toBe(false);
    expect(getRemoteDigests).not.toHaveBeenCalled();
  });

  it("auto-update goes for a new release once, and not again after it failed", async () => {
    const t = fakeTarget();
    target.value = t.value;
    expect(await autoUpdateTick()).toBe("started");
    // The updater reports a rollback for that release
    const file = path.join(path.dirname(process.env.SELF_UPDATE_TEST_DB!), "self-update", "status.json");
    writeStatus(file, { ...readStatus(file)!, state: "rolled_back" });
    expect(await autoUpdateTick()).toBe("failed before");
    store.s = { ...store.s, selfUpdateAuto: false };
    expect(await autoUpdateTick()).toBe("off");
  });

  it("auto-update switches to the chosen channel", async () => {
    store.s = { latestRelease: "2.0.0", selfUpdateAuto: true, selfUpdateHour: -1, selfUpdateChannel: "edge" };
    const t = fakeTarget();
    target.value = t.value;
    expect(await autoUpdateTick()).toBe("started");
    const file = path.join(path.dirname(process.env.SELF_UPDATE_TEST_DB!), "self-update", "status.json");
    expect(readStatus(file)).toMatchObject({ autoKey: "tag:edge@sha256:edge1", targetRef: "ghcr.io/encorp-io/deploynow:edge" });

    // That edge build rolled back: it isn't tried again, but the next build is
    writeStatus(file, { ...readStatus(file)!, state: "rolled_back" });
    expect(await autoUpdateTick()).toBe("failed before");
    remote.digest = "sha256:edge2";
    expect(await autoUpdateTick()).toBe("started");
    expect(readStatus(file)?.autoKey).toBe("tag:edge@sha256:edge2");
    remote.digest = "sha256:edge1";
  });

  it("switches channel even when the new tag is the same image", async () => {
    store.s = { ...store.s, selfUpdateChannel: "stable" };
    const t = fakeTarget({ Config: { Image: "ghcr.io/encorp-io/deploynow:latest", Labels: { "com.docker.compose.project.working_dir": "/opt/deploynow" } }, Image: "sha256:new" });
    target.value = t.value;
    expect(await startSelfUpdate()).toMatchObject({ targetRef: "ghcr.io/encorp-io/deploynow:2.1.0" });
    expect(t.helper.start).toHaveBeenCalled();
  });
});
