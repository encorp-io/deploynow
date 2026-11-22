import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

const mockPrisma = vi.hoisted(() => ({ notificationChannel: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) } }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { buildRequest, decryptConfig, encryptConfig, notify, parseEvents, validateChannel, type Notification } from "@/lib/notify";

const n: Notification = { event: "deploy.failure", ok: false, title: "shop failed", text: "Health check timed out", link: "https://dn/apps/1", fields: { Commit: "abc123" } };

beforeEach(() => vi.clearAllMocks());

describe("validateChannel", () => {
  it("accepts each channel type", () => {
    expect(validateChannel("slack", { url: "https://hooks.slack.com/services/x" })).toEqual({ url: "https://hooks.slack.com/services/x" });
    expect(validateChannel("discord", { url: "https://discord.com/api/webhooks/1/x" }).url).toContain("discord");
    expect(validateChannel("telegram", { botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", chatId: "-1001234" })).toEqual({ botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", chatId: "-1001234" });
    const w = validateChannel("webhook", { url: "https://example.com/hook" });
    expect(w.secret).toMatch(/^[0-9a-f]{48}$/);
  });

  it("keeps stored values that aren't sent again", () => {
    expect(validateChannel("webhook", {}, { url: "https://example.com/h", secret: "keep" })).toEqual({ url: "https://example.com/h", secret: "keep" });
  });

  it("rejects bad input", () => {
    expect(() => validateChannel("slack", { url: "http://hooks.slack.com" })).toThrow(/https/);
    expect(() => validateChannel("slack", { url: "nope" })).toThrow(/URL/);
    expect(() => validateChannel("webhook", { url: "https://192.168.1.5/x" })).toThrow(/Private/);
    expect(() => validateChannel("webhook", { url: "https://localhost/x" })).toThrow(/Private/);
    expect(() => validateChannel("telegram", { botToken: "x", chatId: "1" })).toThrow(/bot token/);
    expect(() => validateChannel("telegram", { botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", chatId: "abc" })).toThrow(/chat id/);
    expect(() => validateChannel("email", {})).toThrow(/Choose/);
  });
});

describe("buildRequest", () => {
  it("formats Slack, Discord and Telegram messages", () => {
    const s = buildRequest("slack", { url: "https://s" }, n);
    expect(JSON.parse(s.init.body as string).text).toBe("❌ shop failed\nHealth check timed out\nCommit: abc123\nhttps://dn/apps/1");
    expect(JSON.parse(buildRequest("discord", { url: "https://d" }, n).init.body as string).content).toContain("shop failed");
    const t = buildRequest("telegram", { botToken: "1:x", chatId: "42" }, { ...n, ok: true });
    expect(t.url).toBe("https://api.telegram.org/bot1:x/sendMessage");
    expect(JSON.parse(t.init.body as string)).toMatchObject({ chat_id: "42", disable_web_page_preview: true });
  });

  it("signs generic webhooks", () => {
    const w = buildRequest("webhook", { url: "https://w", secret: "k" }, n);
    const h = w.init.headers as Record<string, string>;
    expect(h["X-DeployNow-Event"]).toBe("deploy.failure");
    expect(h["X-DeployNow-Signature"]).toBe("sha256=" + crypto.createHmac("sha256", "k").update(w.init.body as string).digest("hex"));
  });
});

describe("config encryption", () => {
  it("round-trips and survives junk", () => {
    expect(decryptConfig(encryptConfig({ url: "https://x" }))).toEqual({ url: "https://x" });
    expect(decryptConfig("junk")).toEqual({});
  });
});

describe("parseEvents", () => {
  it("keeps known events once", () => {
    expect(parseEvents(["deploy.success", "x", "deploy.success"])).toBe("deploy.success");
    expect(parseEvents("deploy.failure, deploy.success")).toBe("deploy.failure,deploy.success");
    expect(parseEvents(undefined)).toBe("");
  });
});

describe("notify", () => {
  it("sends to subscribed channels and records failures", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("", { status: 200 })).mockResolvedValueOnce(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    mockPrisma.notificationChannel.findMany.mockResolvedValue([
      { id: "a", type: "slack", config: encryptConfig({ url: "https://a" }), events: "deploy.failure", lastError: "old" },
      { id: "b", type: "slack", config: encryptConfig({ url: "https://b" }), events: "deploy.failure,deploy.success", lastError: "" },
      { id: "c", type: "slack", config: encryptConfig({ url: "https://c" }), events: "deploy.success", lastError: "" },
    ]);
    await notify(n);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockPrisma.notificationChannel.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { lastError: "" } });
    expect(mockPrisma.notificationChannel.update).toHaveBeenCalledWith({ where: { id: "b" }, data: { lastError: "The channel answered 500" } });
    vi.unstubAllGlobals();
  });

  it("never throws when the database is down", async () => {
    mockPrisma.notificationChannel.findMany.mockRejectedValue(new Error("db"));
    await expect(notify(n)).resolves.toBeUndefined();
  });
});
