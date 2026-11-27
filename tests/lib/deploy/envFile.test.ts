import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { writeComposeEnvFile } from "@/lib/deploy/envFile";
import { parseDotenv } from "@/lib/apps/dotenv";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dn-envfile-"));

describe("writeComposeEnvFile", () => {
  it("writes nothing without variables", () => {
    const dir = tmp();
    expect(writeComposeEnvFile(dir, [])).toBe(false);
    expect(fs.existsSync(path.join(dir, ".env"))).toBe(false);
  });

  it("writes the variables readable only by the owner", () => {
    const dir = tmp();
    expect(writeComposeEnvFile(dir, [{ key: "A", value: "1" }, { key: "S", value: "p'w$d" }])).toBe(true);
    const file = path.join(dir, ".env");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(parseDotenv(fs.readFileSync(file, "utf8")).entries.map((e) => [e.key, e.value])).toEqual([["A", "1"], ["S", "p'w$d"]]);
  });

  it("keeps a .env from the repository and lets the app's values win", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".env"), "A=repo\nB=repo");
    writeComposeEnvFile(dir, [{ key: "A", value: "app" }]);
    const vals = Object.fromEntries(parseDotenv(fs.readFileSync(path.join(dir, ".env"), "utf8")).entries.map((e) => [e.key, e.value]));
    expect(vals).toEqual({ A: "app", B: "repo" });
  });

  it("replaces a symlink instead of writing through it", () => {
    const dir = tmp();
    const outside = path.join(tmp(), "target");
    fs.writeFileSync(outside, "untouched");
    fs.symlinkSync(outside, path.join(dir, ".env"));
    writeComposeEnvFile(dir, [{ key: "A", value: "1" }]);
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    expect(fs.lstatSync(path.join(dir, ".env")).isSymbolicLink()).toBe(false);
  });
});
