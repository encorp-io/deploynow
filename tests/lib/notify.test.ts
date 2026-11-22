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
    expect(() => validateChannel("sms", {})).toThrow(/Choose/);
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

describe("email channel", () => {
  it("validates SMTP settings and keeps the stored password", () => {
    expect(() => validateChannel("email", {})).toThrow(/host name/);
    expect(() => validateChannel("email", { host: "smtp.example.com", from: "nope", to: "a@b.co" })).toThrow(/sender/);
    expect(() => validateChannel("email", { host: "smtp.example.com", from: "ops@example.com", to: "x" })).toThrow(/recipient/);
    const c = validateChannel("email", { host: "SMTP.example.com", security: "tls", user: "u", pass: "p", from: "DeployNow <ops@example.com>", to: "a@b.co; c@d.co" });
    expect(c).toEqual({ host: "smtp.example.com", port: "465", security: "tls", user: "u", pass: "p", from: "DeployNow <ops@example.com>", to: "a@b.co,c@d.co" });
    expect(validateChannel("email", { pass: "••••••••" }, c).pass).toBe("p");
  });

  it("builds a plain and an escaped HTML message", async () => {
    const { buildEmail } = await import("@/lib/notify");
    const m = buildEmail({ from: "ops@example.com", to: "a@b.co" }, { event: "deploy.failure", ok: false, title: "Deploy <b>failed</b>\nInjected: header", text: "x < y", link: "https://dn/app", fields: { App: "<shop>" } });
    expect(m.subject).toBe("[DeployNow] Deploy <b>failed</b> Injected: header");
    expect(m.html).toContain("Deploy &lt;b&gt;failed&lt;/b&gt;");
    expect(m.html).toContain("&lt;shop&gt;");
    expect(m.html).toContain('href="https://dn/app"');
    expect(m.text).toContain("❌");
    expect(m.headers["X-DeployNow-Event"]).toBe("deploy.failure");
  });
});

describe("email delivery", () => {
  it("sends through SMTP", async () => {
    const net = await import("net");
    const received: string[] = [];
    const server = net.createServer((sock) => {
      let data = false;
      let buf = "";
      sock.write("220 test ESMTP\r\n");
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        let i: number;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (data) {
            if (line === ".") {
              data = false;
              sock.write("250 queued\r\n");
            } else received.push(line);
            continue;
          }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "EHLO" || cmd === "HELO") sock.write("250 test\r\n");
          else if (cmd === "DATA") {
            data = true;
            sock.write("354 go\r\n");
          } else if (cmd === "QUIT") sock.end("221 bye\r\n");
          else sock.write("250 ok\r\n");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = String((server.address() as { port: number }).port);
    const { sendTo, encryptConfig } = await import("@/lib/notify");
    const config = encryptConfig({ host: "127.0.0.1", port, security: "none", from: "ops@example.com", to: "oncall@example.com" });
    await sendTo({ id: "c", type: "email", config }, { event: "backup.failure", ok: false, title: "Backup of db failed", text: "disk full" });
    server.close();
    const raw = received.join("\n");
    expect(raw).toMatch(/Subject: \[DeployNow\] Backup of db failed/);
    expect(raw).toMatch(/To: oncall@example.com/);
    expect(raw).toContain("disk full");
  });
});
