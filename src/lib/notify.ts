/**
 * Notification channels: Slack, Discord, Telegram, or a generic webhook
 * (JSON body signed with HMAC-SHA256 in X-DeployNow-Signature).
 */
import crypto from "crypto";
import { prisma } from "./prisma";
import { decryptSecret, encryptSecret } from "./secretsCrypto";

export const CHANNEL_TYPES = ["slack", "discord", "telegram", "webhook"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const EVENTS = ["deploy.success", "deploy.failure"] as const;
export type NotifyEvent = (typeof EVENTS)[number];

export interface ChannelConfig {
  url?: string;
  botToken?: string;
  chatId?: string;
  secret?: string;
}

export interface Notification {
  event: NotifyEvent;
  title: string;
  text: string;
  ok: boolean;
  link?: string;
  fields?: Record<string, string>;
}

const BLOCKED = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|0\.)/i;

export function validateChannel(type: unknown, raw: Record<string, unknown>, existing?: ChannelConfig): ChannelConfig {
  const str = (k: keyof ChannelConfig) => (typeof raw[k] === "string" && (raw[k] as string).trim() ? (raw[k] as string).trim() : existing?.[k] ?? "");
  const httpsUrl = (v: string, what: string) => {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new Error(`Enter the ${what} URL`);
    }
    if (u.protocol !== "https:") throw new Error(`The ${what} URL must use https`);
    if (BLOCKED.test(u.hostname)) throw new Error("Private addresses are not allowed");
    return u.toString();
  };
  switch (type) {
    case "slack":
      return { url: httpsUrl(str("url"), "Slack webhook") };
    case "discord":
      return { url: httpsUrl(str("url"), "Discord webhook") };
    case "telegram": {
      const botToken = str("botToken");
      const chatId = str("chatId");
      if (!/^\d+:[\w-]{20,}$/.test(botToken)) throw new Error("Enter the Telegram bot token from @BotFather");
      if (!/^-?\d{1,20}$|^@\w{4,}$/.test(chatId)) throw new Error("Enter the Telegram chat id");
      return { botToken, chatId };
    }
    case "webhook":
      return { url: httpsUrl(str("url"), "webhook"), secret: str("secret") || crypto.randomBytes(24).toString("hex") };
    default:
      throw new Error("Choose Slack, Discord, Telegram or webhook");
  }
}

export function encryptConfig(c: ChannelConfig): string {
  return encryptSecret(JSON.stringify(c));
}

export function decryptConfig(enc: string): ChannelConfig {
  try {
    return JSON.parse(decryptSecret(enc) || "{}");
  } catch {
    return {};
  }
}

function plain(n: Notification): string {
  const fields = Object.entries(n.fields ?? {}).map(([k, v]) => `${k}: ${v}`);
  return [`${n.ok ? "✅" : "❌"} ${n.title}`, n.text, ...fields, n.link ?? ""].filter(Boolean).join("\n");
}

export function buildRequest(type: ChannelType, cfg: ChannelConfig, n: Notification): { url: string; init: RequestInit } {
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  switch (type) {
    case "slack":
      return { url: cfg.url!, init: json({ text: plain(n) }) };
    case "discord":
      return { url: cfg.url!, init: json({ content: plain(n).slice(0, 1900) }) };
    case "telegram":
      return {
        url: `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
        init: json({ chat_id: cfg.chatId, text: plain(n).slice(0, 4000), disable_web_page_preview: true }),
      };
    case "webhook": {
      const body = JSON.stringify({ event: n.event, ok: n.ok, title: n.title, text: n.text, link: n.link, fields: n.fields ?? {}, sentAt: new Date().toISOString() });
      const sig = crypto.createHmac("sha256", cfg.secret ?? "").update(body).digest("hex");
      return {
        url: cfg.url!,
        init: { method: "POST", headers: { "Content-Type": "application/json", "X-DeployNow-Event": n.event, "X-DeployNow-Signature": `sha256=${sig}` }, body },
      };
    }
  }
}

export async function sendTo(channel: { id: string; type: string; config: string }, n: Notification): Promise<void> {
  const { url, init } = buildRequest(channel.type as ChannelType, decryptConfig(channel.config), n);
  const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`The channel answered ${res.status}`);
}

/** Send to every enabled channel subscribed to the event. Never throws. */
export async function notify(n: Notification): Promise<void> {
  let channels: Awaited<ReturnType<typeof prisma.notificationChannel.findMany>> = [];
  try {
    channels = await prisma.notificationChannel.findMany({ where: { enabled: true } });
  } catch {
    return;
  }
  await Promise.all(
    channels
      .filter((c) => c.events.split(",").includes(n.event))
      .map(async (c) => {
        try {
          await sendTo(c, n);
          if (c.lastError) await prisma.notificationChannel.update({ where: { id: c.id }, data: { lastError: "" } });
        } catch (err) {
          const msg = (err instanceof Error ? err.message : "Send failed").slice(0, 300);
          await prisma.notificationChannel.update({ where: { id: c.id }, data: { lastError: msg } }).catch(() => {});
        }
      }),
  );
}

export function parseEvents(raw: unknown): string {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  const events = list.map((e) => String(e).trim()).filter((e) => (EVENTS as readonly string[]).includes(e));
  return [...new Set(events)].join(",");
}

