import path from "path";

/** Where DeployNow keeps files next to its database (/data in the container). */
export function dataDir(): string {
  if (process.env.DEPLOYNOW_DATA_DIR) return process.env.DEPLOYNOW_DATA_DIR;
  const db = process.env.DATABASE_URL?.startsWith("file:") ? process.env.DATABASE_URL.slice(5) : "";
  return db ? path.dirname(path.resolve(db)) : "/data";
}
