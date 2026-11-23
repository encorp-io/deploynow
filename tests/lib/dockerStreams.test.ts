import { describe, it, expect } from "vitest";
import { demux, isMultiplexed, logBufferToText, stripControl } from "@/lib/docker/streams";

const frame = (type: 1 | 2, text: string) => {
  const payload = Buffer.from(text);
  const h = Buffer.alloc(8);
  h[0] = type;
  h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
};

describe("docker streams", () => {
  it("splits stdout and stderr frames", () => {
    const buf = Buffer.concat([frame(1, "out\n"), frame(2, "err\n")]);
    expect(isMultiplexed(buf)).toBe(true);
    expect(demux(buf).frames).toEqual([{ stream: "stdout", text: "out\n" }, { stream: "stderr", text: "err\n" }]);
  });

  it("keeps a partial trailing frame for the next chunk", () => {
    const full = Buffer.concat([frame(1, "a"), frame(1, "bcdef")]);
    const { frames, rest } = demux(full.subarray(0, full.length - 2));
    expect(frames).toEqual([{ stream: "stdout", text: "a" }]);
    expect(demux(Buffer.concat([rest, full.subarray(full.length - 2)])).frames[0].text).toBe("bcdef");
  });

  it("passes TTY output through", () => {
    expect(isMultiplexed(Buffer.from("plain log line"))).toBe(false);
    expect(logBufferToText(Buffer.from("plain log line"))).toBe("plain log line");
    expect(logBufferToText(Buffer.concat([frame(1, "x"), frame(2, "y")]))).toBe("xy");
  });

  it("strips ANSI and control characters but keeps newlines and tabs", () => {
    expect(stripControl("\x1b[31mred\x1b[0m\tok\n\x07")).toBe("red\tok\n");
  });
});
