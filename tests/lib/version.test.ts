import { describe, expect, it } from "vitest";
import { defaultAgentImage } from "@/lib/agent/hub";

describe("defaultAgentImage", () => {
  it("uses the agent of the same release", () => {
    expect(defaultAgentImage("2.1.0")).toBe("ghcr.io/encorp-io/deploynow-agent:2.1.0");
    expect(defaultAgentImage("2.1.0-rc.1")).toBe("ghcr.io/encorp-io/deploynow-agent:2.1.0-rc.1");
  });
  it("uses the edge agent for builds of main and local builds", () => {
    expect(defaultAgentImage("edge-abc1234")).toBe("ghcr.io/encorp-io/deploynow-agent:edge");
    expect(defaultAgentImage("dev")).toBe("ghcr.io/encorp-io/deploynow-agent:edge");
  });
});
