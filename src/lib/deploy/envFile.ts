import fs from "fs";
import path from "path";
import { serializeDotenv } from "../apps/dotenv";

/**
 * Compose apps: the app's variables go into .env next to the compose file, so a service
 * can load them all with `env_file: .env` (the file is usually not in Git). A .env that is
 * in the repository is kept, and the app's values are appended so they win.
 *
 * Call it before pull and build to put the repository's own .env back (or an empty one, so
 * `env_file: .env` resolves) and to read it; then call `write(vars)` right before `up`, so
 * decrypted values are never in the build context. The work dir, and with it the file, is
 * removed when the deployment ends.
 */
export function prepareComposeEnvFile(composeDir: string): { write: (vars: { key: string; value: string }[]) => void } {
  const target = path.join(composeDir, ".env");
  let original = "";
  try {
    const st = fs.lstatSync(target);
    // Never follow a link the repository planted
    if (st.isFile()) original = fs.readFileSync(target, "utf8");
    fs.rmSync(target, { force: true });
  } catch {
    // not there
  }
  const put = (text: string) => {
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, text, { mode: 0o600 });
  };
  put(original);
  return {
    write(vars) {
      if (!vars.length) return put(original);
      const head = original.trim() ? `${original.replace(/\s*$/, "")}\n\n# Set in DeployNow\n` : "";
      put(head + serializeDotenv(vars));
    },
  };
}
