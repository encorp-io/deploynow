import fs from "fs";
import path from "path";
import { serializeDotenv } from "../apps/dotenv";

/**
 * Compose apps: write the app's variables to .env next to the compose file, so a service
 * can load them all with `env_file: .env` (the file is usually not in Git). A .env that is
 * in the repository is kept, and the app's values are appended so they win.
 * The work dir, and with it the file, is removed when the deployment ends.
 */
export function writeComposeEnvFile(composeDir: string, vars: { key: string; value: string }[]): boolean {
  if (!vars.length) return false;
  const target = path.join(composeDir, ".env");
  let existing = "";
  try {
    const st = fs.lstatSync(target);
    // Never follow a link the repository planted
    if (st.isFile()) existing = fs.readFileSync(target, "utf8");
    fs.rmSync(target, { force: true });
  } catch {
    // not there
  }
  const head = existing ? `${existing.replace(/\s*$/, "")}\n\n# Set in DeployNow\n` : "";
  fs.writeFileSync(target, head + serializeDotenv(vars), { mode: 0o600 });
  return true;
}
