/**
 * Docker multiplexes stdout and stderr on one stream for containers without a
 * TTY: each frame is an 8-byte header (stream type, 3 zero bytes, big-endian
 * length) followed by the payload. TTY containers send raw bytes.
 */

export interface LogLine {
  stream: "stdout" | "stderr";
  text: string;
}

export function isMultiplexed(buf: Buffer): boolean {
  return buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
}

/** Decodes a complete buffer. Returns the frames and any trailing partial frame. */
export function demux(buf: Buffer): { frames: LogLine[]; rest: Buffer } {
  const frames: LogLine[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const type = buf[offset];
    const len = buf.readUInt32BE(offset + 4);
    if (offset + 8 + len > buf.length) break;
    frames.push({
      stream: type === 2 ? "stderr" : "stdout",
      text: buf.subarray(offset + 8, offset + 8 + len).toString("utf8"),
    });
    offset += 8 + len;
  }
  return { frames, rest: buf.subarray(offset) };
}

/** Plain text of a log buffer, multiplexed or not. */
export function logBufferToText(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "binary") : buf;
  if (!isMultiplexed(b)) return b.toString("utf8");
  return demux(b).frames.map((f) => f.text).join("");
}

/** Removes ANSI colour codes and other control characters except newline and tab. */
export function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
