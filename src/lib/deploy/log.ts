/** Deployment logs: one plain-text file per deployment under <data>/deployments. */
import fs from "fs";
import path from "path";
import { dataDir } from "../paths";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function logPath(deploymentId: string): string {
  if (!/^c[a-z0-9]{20,32}$/.test(deploymentId)) throw new Error("Invalid deployment id");
  return path.join(dataDir(), "deployments", `${deploymentId}.log`);
}

export interface DeployLogger {
  (line: string): void;
  setMask(mask: (text: string) => string): void;
  close(): void;
}

export function createLogger(deploymentId: string): DeployLogger {
  const file = logPath(deploymentId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, "a", 0o600);
  let mask = (t: string) => t;
  let written = 0;
  let truncated = false;
  const log = ((line: string) => {
    if (truncated) return;
    const text = `${new Date().toISOString().slice(11, 19)} ${mask(line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")}\n`;
    written += Buffer.byteLength(text);
    if (written > MAX_LOG_BYTES) {
      truncated = true;
      fs.writeSync(fd, "… log truncated at 5 MB\n");
      return;
    }
    fs.writeSync(fd, text);
  }) as DeployLogger;
  log.setMask = (m) => (mask = m);
  log.close = () => {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  };
  return log;
}

/** Read from a byte offset; returns the text and the next offset. */
export function readLog(deploymentId: string, offset = 0): { text: string; next: number } {
  const file = logPath(deploymentId);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { text: "", next: 0 };
  }
  if (offset >= size) return { text: "", next: size };
  const len = Math.min(size - offset, 512 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, len, offset);
  } finally {
    fs.closeSync(fd);
  }
  return { text: buf.toString("utf8"), next: offset + len };
}

export function removeLog(deploymentId: string) {
  try {
    fs.unlinkSync(logPath(deploymentId));
  } catch {
    /* gone */
  }
}
