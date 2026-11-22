import { describe, it, expect } from "vitest";
import {
  BackupConfigError,
  nextRun,
  recoveryKit,
  repoUrl,
  resticEnv,
  sourceKey,
  snapshotPath,
  validateDestination,
  validateHook,
  validateRetention,
  validateSources,
  parseSources,
  parseHook,
  resticOptions,
} from "@/lib/backup/config";
import { encryptSecret } from "@/lib/secretsCrypto";
import { jsonSummary, lastError, tagValue } from "@/lib/backup/restic";
import type { BackupDestination, BackupRepo } from "@prisma/client";

const dest = {
  id: "d",
  name: "r2",
  provider: "r2",
  endpointUrl: "https://abc.r2.cloudflarestorage.com",
  bucket: "backups",
  prefix: "dn",
  region: "auto",
  accessKeyId: "AK",
  secretKey: encryptSecret("SK"),
  pruneKeyId: "",
  pruneSecretKey: "",
  objectLock: false,
} as unknown as BackupDestination;
const repo = { id: "r", destinationId: "d", scope: "cendpoint", password: encryptSecret("pw") } as BackupRepo;

describe("backup sources", () => {
  it("accepts volumes, binds, databases and apps", () => {
    const s = validateSources(
      [
        { type: "volume", name: "pgdata" },
        { type: "bind", path: "/srv/uploads/" },
        { type: "db", engine: "postgres", container: "db", database: "app" },
        { type: "app", applicationId: "capp000000000000000000001" },
      ],
      false,
    );
    expect(s.map(sourceKey)).toEqual(["volume:pgdata", "bind:/srv/uploads", "db:db/app", "app:capp000000000000000000001"]);
    expect(snapshotPath(s[0])).toBe("/data/volume/pgdata");
    expect(snapshotPath(s[1])).toBe("/data/bind/srv/uploads");
    expect(snapshotPath(s[2])).toBe("/data/db/db");
    expect(() => snapshotPath(s[3])).toThrow(BackupConfigError);
  });

  it("refuses dangerous or malformed input", () => {
    expect(() => validateSources([], false)).toThrow(/at least one/);
    expect(() => validateSources([{ type: "bind", path: "/" }], false)).toThrow(/can't be backed up/);
    expect(() => validateSources([{ type: "bind", path: "/etc" }], false)).toThrow(/can't be backed up/);
    expect(() => validateSources([{ type: "bind", path: "/srv/../etc" }], false)).toThrow(/Invalid path/);
    expect(() => validateSources([{ type: "bind", path: "/srv/$(rm -rf)" }], false)).toThrow(/Invalid path/);
    expect(() => validateSources([{ type: "volume", name: "../x" }], false)).toThrow(/Invalid volume/);
    expect(() => validateSources([{ type: "db", engine: "oracle", container: "x" }], false)).toThrow(/engine/);
    expect(() => validateSources([{ type: "db", engine: "mysql", container: "x", database: "a b" }], false)).toThrow(/database name/);
    expect(() => validateSources([{ type: "volume", name: "a" }, { type: "volume", name: "a" }], false)).toThrow(/twice/);
    expect(() => validateSources([{ type: "nope" }], false)).toThrow(/Unknown/);
    expect(() => validateSources([{ type: "volume", name: "a" }], true)).toThrow(/DeployNow itself/);
    expect(validateSources([{ type: "instance" }], true)).toEqual([{ type: "instance" }]);
    expect(parseSources("not json")).toEqual([]);
  });

  it("validates hooks", () => {
    expect(validateHook(null)).toBeNull();
    expect(validateHook({ container: "", command: "" })).toBeNull();
    expect(validateHook({ container: "redis", command: "redis-cli BGSAVE" })).toEqual({ container: "redis", command: "redis-cli BGSAVE" });
    expect(() => validateHook({ container: "", command: "x" })).toThrow(/container/);
    expect(() => validateHook({ container: "x", command: "" })).toThrow(/command/);
    expect(parseHook('{"container":"a","command":"b"}')).toEqual({ container: "a", command: "b" });
    expect(parseHook("garbage")).toBeNull();
  });
});

describe("schedules and retention", () => {
  it("computes the next run of a cron expression", () => {
    const from = new Date("2026-01-01T10:00:00Z");
    const n = nextRun("*/15 * * * *", from);
    expect(n.getTime() - from.getTime()).toBe(15 * 60_000);
    expect(() => nextRun("0 3 * *")).toThrow(/5-field/);
    expect(() => nextRun("99 3 * * *")).toThrow(/Invalid schedule/);
  });

  it("defaults retention to 7 daily, 4 weekly, 6 monthly", () => {
    expect(validateRetention({})).toEqual({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6 });
    expect(validateRetention({ keepDaily: "3", keepWeekly: 0, keepMonthly: 0 })).toEqual({ keepDaily: 3, keepWeekly: 0, keepMonthly: 0 });
    expect(() => validateRetention({ keepDaily: 0, keepWeekly: 0, keepMonthly: 0 })).toThrow(/at least one/);
    expect(() => validateRetention({ keepDaily: -1 })).toThrow(/whole numbers/);
  });
});

describe("destinations", () => {
  it("expands an R2 account id and validates the rest", () => {
    const v = validateDestination({ name: "R2", provider: "r2", endpointUrl: "0123456789abcdef0123456789abcdef", bucket: "my-backups", accessKeyId: "AK", secretKey: "SK" });
    expect(v.endpointUrl).toBe("https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    expect(v.region).toBe("auto");
    expect(v.prefix).toBe("deploynow");
  });

  it("refuses plain http, paths in the endpoint and bad buckets", () => {
    const base = { name: "x", provider: "s3", bucket: "bucket", accessKeyId: "a", secretKey: "b" };
    expect(() => validateDestination({ ...base, endpointUrl: "http://s3.example.com" })).toThrow(/https/);
    expect(() => validateDestination({ ...base, endpointUrl: "https://s3.example.com/bucket" })).toThrow(/bare host/);
    expect(() => validateDestination({ ...base, endpointUrl: "https://s3.example.com", bucket: "B!" })).toThrow(/bucket/);
    expect(() => validateDestination({ ...base, endpointUrl: "https://s3.example.com", secretKey: "" })).toThrow(/secret/);
    expect(() => validateDestination({ ...base, endpointUrl: "https://s3.example.com", pruneKeyId: "p" })).toThrow(/prune key/);
    expect(() => validateDestination({ ...base, endpointUrl: "nonsense" })).toThrow(/URL/);
  });

  it("keeps stored secrets when the mask comes back", () => {
    const v = validateDestination({ name: "r2", secretKey: "••••••••" }, dest);
    expect(v.secret).toBeNull();
  });

  it("builds the restic repository and environment", () => {
    expect(repoUrl(dest, "cendpoint")).toBe("s3:https://abc.r2.cloudflarestorage.com/backups/dn/cendpoint");
    const env = resticEnv(dest, repo);
    expect(env).toMatchObject({ RESTIC_PASSWORD: "pw", AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" });
    const withPrune = { ...dest, pruneKeyId: "PK", pruneSecretKey: encryptSecret("PS") } as BackupDestination;
    expect(resticEnv(withPrune, repo, { prune: true })).toMatchObject({ AWS_ACCESS_KEY_ID: "PK", AWS_SECRET_ACCESS_KEY: "PS" });
    expect(resticEnv(withPrune, repo)).toMatchObject({ AWS_ACCESS_KEY_ID: "AK" });
    expect(resticOptions(dest)).toEqual(["-o", "s3.region=auto"]);
    expect(() => resticEnv({ ...dest, secretKey: "broken" } as BackupDestination, repo)).toThrow(/decrypted/);
  });

  it("writes a recovery kit with the password and restore steps, without the secret key", () => {
    const kit = recoveryKit(dest, repo, "prod-1");
    expect(kit).toContain("Password:       pw");
    expect(kit).toContain("s3:https://abc.r2.cloudflarestorage.com/backups/dn/cendpoint");
    expect(kit).toContain("restic restore");
    expect(kit).not.toContain("SK");
  });
});

describe("restic output", () => {
  it("finds the summary line and the error", () => {
    expect(jsonSummary('{"message_type":"status"}\n{"message_type":"summary","snapshot_id":"abc"}\n')).toEqual({ message_type: "summary", snapshot_id: "abc" });
    expect(jsonSummary("nothing")).toBeNull();
    expect(lastError({ code: 1, stdout: "", stderr: "a\nFatal: wrong password\n" })).toBe("wrong password");
    expect(lastError({ code: 7, stdout: "", stderr: "" })).toBe("restic exited with code 7");
    expect(tagValue({ id: "", short_id: "", time: "", hostname: "", paths: [], tags: ["dn-source=volume:x", "dn-policy=p"] }, "dn-source")).toBe("volume:x");
  });
});
