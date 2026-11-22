import { describe, it, expect } from "vitest";
import { can, canAssignRole, effectiveRole, normalizeRole } from "@/lib/rbac";

const A = "endpoint-a";
const B = "endpoint-b";

describe("rbac", () => {
  it("maps v1 and unknown roles", () => {
    expect(normalizeRole("member")).toBe("operator");
    expect(normalizeRole("admin")).toBe("admin");
    expect(normalizeRole("superuser")).toBe("viewer");
    expect(normalizeRole(undefined)).toBe("viewer");
  });

  it("follows the role ladder", () => {
    expect(can({ role: "viewer" }, "endpoint.view")).toBe(true);
    expect(can({ role: "viewer" }, "container.logs")).toBe(false);
    expect(can({ role: "operator" }, "container.exec")).toBe(true);
    expect(can({ role: "operator" }, "container.remove")).toBe(false);
    expect(can({ role: "admin" }, "users.manage")).toBe(true);
    expect(can({ role: "owner" }, "docker.prune")).toBe(true);
  });

  it("raises the role on the granted endpoint only", () => {
    const user = { role: "viewer", bindings: [{ role: "admin", scopeType: "endpoint", scopeId: A }] };
    expect(effectiveRole(user, { endpointId: A })).toBe("admin");
    expect(effectiveRole(user, { endpointId: B })).toBe("viewer");
    expect(can(user, "container.remove", { endpointId: A })).toBe(true);
    expect(can(user, "container.remove", { endpointId: B })).toBe(false);
  });

  it("never lets a grant unlock instance-wide permissions", () => {
    const user = { role: "viewer", bindings: [{ role: "admin", scopeType: "endpoint", scopeId: A }] };
    expect(can(user, "users.manage", { endpointId: A })).toBe(false);
    expect(can(user, "endpoint.manage", { endpointId: A })).toBe(false);
    expect(can(user, "settings.manage", { endpointId: A })).toBe(false);
  });

  it("never lowers a role with a grant", () => {
    const user = { role: "admin", bindings: [{ role: "viewer", scopeType: "endpoint", scopeId: A }] };
    expect(effectiveRole(user, { endpointId: A })).toBe("admin");
  });

  it("only owners create owners", () => {
    expect(canAssignRole("admin", "owner")).toBe(false);
    expect(canAssignRole("owner", "owner")).toBe(true);
    expect(canAssignRole("admin", "operator")).toBe(true);
    expect(canAssignRole("operator", "viewer")).toBe(false);
  });
});
