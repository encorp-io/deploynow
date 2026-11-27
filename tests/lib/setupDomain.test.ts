import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { setupDomainPlan } from "@/lib/setupDomain";

describe("DEPLOYNOW_DOMAIN", () => {
  it("does nothing when unset", () => {
    expect(setupDomainPlan(undefined, "", null).action).toBe("skip");
    expect(setupDomainPlan("  ", "", null).action).toBe("skip");
  });

  it("applies a new domain, forgiving a pasted URL", () => {
    expect(setupDomainPlan("https://Deploy.Example.com/", "", null)).toEqual({ action: "apply", domain: "deploy.example.com" });
  });

  it("rejects IPs and bare names", () => {
    const r = setupDomainPlan("1.2.3.4", "", null);
    expect(r.action).toBe("skip");
    expect(r.action === "skip" && r.reason).toMatch(/^DEPLOYNOW_DOMAIN:/);
  });

  it("leaves a domain alone once it was applied, so removing it in Settings sticks", () => {
    expect(setupDomainPlan("deploy.example.com", "", { domain: "deploy.example.com", done: true }).action).toBe("skip");
  });

  it("retries after a failed attempt", () => {
    expect(setupDomainPlan("deploy.example.com", "", { domain: "deploy.example.com", done: false }).action).toBe("apply");
  });

  it("never replaces a domain set in Settings", () => {
    expect(setupDomainPlan("deploy.example.com", "other.example.com", null)).toEqual({ action: "skip", reason: "Settings → Domain already uses other.example.com" });
    expect(setupDomainPlan("deploy.example.com", "deploy.example.com", null)).toEqual({ action: "skip", reason: "already active" });
  });
});
