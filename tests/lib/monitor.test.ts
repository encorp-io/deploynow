import { describe, it, expect } from "vitest";
import { isCrashLoop, parseProbe, usage } from "@/lib/monitor";

describe("monitor helpers", () => {
  it("parses the probe output", () => {
    const m = parseProbe("cpus=4\nload=1.25\nmemtotal=8000000\nmemavail=2000000\ndisktotal=100000000\ndiskfree=5000000\n", "/var/lib/docker");
    expect(m).toMatchObject({ cpus: 4, load1: 1.25, memTotal: 8_192_000_000, memAvailable: 2_048_000_000, diskTotal: 102_400_000_000, diskFree: 5_120_000_000 });
    expect(usage(m)).toEqual({ disk: 95, mem: 75 });
    expect(usage(parseProbe("", "/"))).toEqual({ disk: 0, mem: 0 });
  });

  it("spots a crash loop inside the window", () => {
    const now = 1_000_000_000;
    const at = (minAgo: number, count: number) => ({ at: now - minAgo * 60_000, count });
    expect(isCrashLoop([at(5, 1), at(0, 4)], now, 3)).toBe(true);
    expect(isCrashLoop([at(5, 1), at(0, 2)], now, 3)).toBe(false);
    expect(isCrashLoop([at(20, 1), at(0, 4)], now, 3)).toBe(false); // outside the window
    expect(isCrashLoop([at(0, 9)], now, 3)).toBe(false);
  });
});
