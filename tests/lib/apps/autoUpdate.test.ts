import { describe, it, expect } from "vitest";
import {
  composeImages,
  describeWindow,
  fingerprintOf,
  inWindow,
  interpolate,
  isDue,
  summarize,
  validateAutoUpdateInput,
} from "@/lib/apps/autoUpdate";
import { imageRepo, matchRepoDigest, pinImages } from "@/lib/deploy/compose";
import { parseChallenge } from "@/lib/registryDigests";

const W = { autoUpdateDays: "", autoUpdateFrom: "", autoUpdateTo: "", autoUpdateTimezone: "UTC" };
// 2026-11-27 is a Friday
const at = (hhmm: string, day = "27") => new Date(`2026-11-${day}T${hhmm}:00Z`);

describe("inWindow", () => {
  it("is always open without a window", () => {
    expect(inWindow(at("13:00"), W)).toBe(true);
  });
  it("checks the hours", () => {
    const w = { ...W, autoUpdateFrom: "02:00", autoUpdateTo: "04:00" };
    expect(inWindow(at("02:00"), w)).toBe(true);
    expect(inWindow(at("03:59"), w)).toBe(true);
    expect(inWindow(at("04:00"), w)).toBe(false);
    expect(inWindow(at("13:00"), w)).toBe(false);
  });
  it("checks the days", () => {
    const w = { ...W, autoUpdateDays: "6,0" }; // weekend
    expect(inWindow(at("13:00"), w)).toBe(false);
    expect(inWindow(at("13:00", "28"), w)).toBe(true);
  });
  it("runs past midnight and belongs to the day it starts", () => {
    const w = { ...W, autoUpdateDays: "5", autoUpdateFrom: "22:00", autoUpdateTo: "04:00" }; // Friday night
    expect(inWindow(at("23:00"), w)).toBe(true);
    expect(inWindow(at("03:00", "28"), w)).toBe(true); // Saturday 03:00, still Friday's window
    expect(inWindow(at("03:00"), w)).toBe(false); // Friday 03:00 is Thursday's window
    expect(inWindow(at("12:00"), w)).toBe(false);
  });
  it("uses the time zone", () => {
    const w = { ...W, autoUpdateFrom: "02:00", autoUpdateTo: "04:00", autoUpdateTimezone: "Europe/Sofia" }; // UTC+2 in November
    expect(inWindow(at("00:30"), w)).toBe(true);
    expect(inWindow(at("02:30"), w)).toBe(false);
  });
  it("describes the window", () => {
    expect(describeWindow({ ...W, autoUpdateDays: "1,2", autoUpdateFrom: "02:00", autoUpdateTo: "04:00" })).toBe("Mon, Tue, 02:00–04:00 (UTC)");
  });
});

describe("isDue", () => {
  const base = { ...W, autoUpdateEvery: 15, autoUpdateCheckedAt: at("12:00") };
  it("waits for the interval", () => {
    expect(isDue({ ...base, autoUpdateCheckedAt: null }, at("12:01"))).toBe(true);
    expect(isDue(base, at("12:10"))).toBe(false);
    expect(isDue(base, at("12:15"))).toBe(true);
  });
  it("checks as soon as the window opens", () => {
    const w = { ...base, autoUpdateEvery: 1440, autoUpdateFrom: "12:05", autoUpdateTo: "13:00" };
    expect(isDue(w, at("12:04"))).toBe(false);
    expect(isDue(w, at("12:06"))).toBe(true);
    // Once checked inside the window, back to the interval
    expect(isDue({ ...w, autoUpdateCheckedAt: at("12:06") }, at("12:30"))).toBe(false);
  });
});

describe("validateAutoUpdateInput", () => {
  it("accepts a full setting", () => {
    expect(
      validateAutoUpdateInput({ autoUpdate: true, autoUpdateEvery: 60, autoUpdateDays: [5, 1, 1], autoUpdateFrom: "22:00", autoUpdateTo: "04:00", autoUpdateTimezone: "Europe/Sofia", autoUpdateRollback: false }),
    ).toEqual({ autoUpdate: true, autoUpdateEvery: 60, autoUpdateDays: "1,5", autoUpdateFrom: "22:00", autoUpdateTo: "04:00", autoUpdateTimezone: "Europe/Sofia", autoUpdateRollback: false });
  });
  it("treats the old auto-digest policy as auto-update", () => {
    expect(validateAutoUpdateInput({ updatePolicy: "auto-digest" })).toEqual({ autoUpdate: true });
  });
  it("stores all seven days as every day", () => {
    expect(validateAutoUpdateInput({ autoUpdateDays: "0,1,2,3,4,5,6" }).autoUpdateDays).toBe("");
  });
  it("rejects bad values", () => {
    expect(() => validateAutoUpdateInput({ autoUpdateEvery: 7 })).toThrow(/Check every/);
    expect(() => validateAutoUpdateInput({ autoUpdateDays: [7] })).toThrow(/Sunday/);
    expect(() => validateAutoUpdateInput({ autoUpdateFrom: "25:00", autoUpdateTo: "01:00" })).toThrow(/HH:MM/);
    expect(() => validateAutoUpdateInput({ autoUpdateFrom: "02:00" })).toThrow(/both/);
    expect(() => validateAutoUpdateInput({ autoUpdateFrom: "02:00", autoUpdateTo: "02:00" })).toThrow(/same time/);
    expect(() => validateAutoUpdateInput({ autoUpdateTimezone: "Mars/Olympus" })).toThrow(/time zone/);
  });
  it("checks the window against the stored half", () => {
    expect(validateAutoUpdateInput({ autoUpdateTo: "05:00" }, { autoUpdateFrom: "02:00", autoUpdateTo: "04:00" })).toEqual({ autoUpdateTo: "05:00" });
  });
});

describe("compose images", () => {
  it("interpolates like compose", () => {
    expect(interpolate("ghcr.io/acme/${APP}:${TAG:-latest}", { APP: "web" })).toBe("ghcr.io/acme/web:latest");
    expect(interpolate("x:${TAG-1}", { TAG: "" })).toBe("x:");
    expect(interpolate("x:${TAG:-1}", { TAG: "" })).toBe("x:1");
    expect(interpolate("$REPO:1", { REPO: "nginx" })).toBe("nginx:1");
    expect(interpolate("a$$b", {})).toBe("a$b");
    expect(interpolate("x:${MISSING}", {})).toBeNull();
  });
  it("lists registry images and leaves out built and pinned ones", () => {
    const yaml = `services:
  web:
    image: nginx:1.27
  api:
    build: .
    image: dn/app-api:123
  db:
    image: postgres@sha256:${"a".repeat(64)}
  worker:
    image: ghcr.io/acme/\${APP}:\${TAG:-latest}
  cron:
    image: \${UNKNOWN}
`;
    expect(composeImages(yaml, { APP: "worker" })).toEqual([
      { service: "web", image: "nginx:1.27" },
      { service: "worker", image: "ghcr.io/acme/worker:latest" },
    ]);
    expect(composeImages("not: [yaml")).toEqual([]);
  });
  it("fingerprints changes regardless of order", () => {
    const a = { kind: "image" as const, name: "web", from: "x", to: "sha256:1" };
    const b = { kind: "commit" as const, name: "main", from: "y", to: "abc" };
    expect(fingerprintOf([a, b])).toBe(fingerprintOf([b, a]));
    expect(summarize([b])).toBe("new commit abc on main");
  });
});

describe("rollback pins", () => {
  const d = "sha256:" + "b".repeat(64);
  it("pins registry services, not built ones", () => {
    const yaml = "services:\n  web:\n    image: nginx:latest\n  api:\n    build: .\n    image: dn/a-api:1\n  db:\n    image: postgres:16\n";
    const r = pinImages(yaml, { web: `nginx@${d}`, api: `dn/a-api@${d}`, db: "garbage" });
    expect(r.pinned).toBe(1);
    expect(r.yaml).toContain(`image: nginx@${d}`);
    expect(r.yaml).toContain("image: dn/a-api:1");
    expect(r.yaml).toContain("image: postgres:16");
    expect(pinImages(yaml, {}).yaml).toBe(yaml);
  });
  it("matches Docker Hub repo digests however the name is written", () => {
    expect(imageRepo("ghcr.io/acme/web:1")).toBe("ghcr.io/acme/web");
    expect(imageRepo("localhost:5000/web")).toBe("localhost:5000/web");
    expect(matchRepoDigest("nginx:latest", [`docker.io/library/nginx@${d}`])).toBe(`docker.io/library/nginx@${d}`);
    expect(matchRepoDigest("docker.io/library/redis:7", [`redis@${d}`])).toBe(`redis@${d}`);
    expect(matchRepoDigest("ghcr.io/acme/web:1", [`ghcr.io/other/web@${d}`])).toBe("");
  });
});

describe("parseChallenge", () => {
  it("reads a bearer challenge", () => {
    expect(parseChallenge('Bearer realm="https://quay.io/v2/auth",service="quay.io",scope="repository:a/b:pull"')).toEqual({
      scheme: "bearer",
      params: { realm: "https://quay.io/v2/auth", service: "quay.io", scope: "repository:a/b:pull" },
    });
  });
});

describe("remoteBranchHead", () => {
  it("reads the branch head with git ls-remote", async () => {
    const { execSync } = await import("child_process");
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const { remoteBranchHead } = await import("@/lib/apps/autoUpdate");
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dn-lsremote-"));
    const git = (c: string) => execSync(`git -c user.email=t@t -c user.name=t ${c}`, { cwd: repo, stdio: "pipe" }).toString().trim();
    git("init -q -b main");
    fs.writeFileSync(path.join(repo, "a"), "1");
    git("add a");
    git("commit -q -m one");
    const sha = git("rev-parse HEAD");
    expect(await remoteBranchHead(repo, "main")).toBe(sha);
    await expect(remoteBranchHead(repo, "nope")).rejects.toThrow(/isn't in the repository/);
    await expect(remoteBranchHead(repo, "-x")).rejects.toThrow(/Invalid branch/);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
