import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { prepareComposeEnvFile } from "@/lib/deploy/envFile";
import { parseDotenv } from "@/lib/apps/dotenv";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dn-envfile-"));
const read = (dir: string) => Object.fromEntries(parseDotenv(fs.readFileSync(path.join(dir, ".env"), "utf8")).entries.map((e) => [e.key, e.value]));

describe("prepareComposeEnvFile", () => {
  it("creates an empty .env so env_file: .env resolves, even with no variables", () => {
    const dir = tmp();
    const f = prepareComposeEnvFile(dir);
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe("");
    f.write([]);
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe("");
  });

  it("keeps secrets out of the file until write (so builds never see them)", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".env"), "B=repo");
    const f = prepareComposeEnvFile(dir);
    expect(read(dir)).toEqual({ B: "repo" });
    f.write([{ key: "S", value: "p'w$d" }]);
    expect(read(dir)).toEqual({ B: "repo", S: "p'w$d" });
    expect(fs.statSync(path.join(dir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("lets the app's values win over the repository's", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".env"), "A=repo\nB=repo");
    prepareComposeEnvFile(dir).write([{ key: "A", value: "app" }]);
    expect(read(dir)).toEqual({ A: "app", B: "repo" });
  });

  it("replaces a symlink instead of writing through it", () => {
    const dir = tmp();
    const outside = path.join(tmp(), "target");
    fs.writeFileSync(outside, "untouched");
    fs.symlinkSync(outside, path.join(dir, ".env"));
    prepareComposeEnvFile(dir).write([{ key: "A", value: "1" }]);
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    expect(fs.lstatSync(path.join(dir, ".env")).isSymbolicLink()).toBe(false);
  });
});
