import { describe, it, expect } from "vitest";
import { EXEC_TICKET_TTL_MS, issueExecTicket, redeemExecTicket } from "@/lib/execTicket";

const input = { uid: "u", email: "u@x", sid: "s", endpointId: "e", containerId: "c", shell: "/bin/sh" };

describe("exec tickets", () => {
  it("redeem once", () => {
    const t = issueExecTicket(input);
    expect(redeemExecTicket(t)).toMatchObject(input);
    expect(redeemExecTicket(t)).toBeNull();
  });

  it("expire", () => {
    const now = Date.now();
    const t = issueExecTicket(input, now);
    expect(redeemExecTicket(t, now + EXEC_TICKET_TTL_MS + 1)).toBeNull();
  });

  it("reject tampering", () => {
    const t = issueExecTicket(input);
    const [data, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(data, "base64url").toString()), containerId: "other" })).toString("base64url");
    expect(redeemExecTicket(`${forged}.${sig}`)).toBeNull();
    expect(redeemExecTicket(`${data}.${sig.slice(0, -2)}xx`)).toBeNull();
    expect(redeemExecTicket("")).toBeNull();
    expect(redeemExecTicket("nodot")).toBeNull();
  });
});
