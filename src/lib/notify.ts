/**
 * Notification channels: Slack, Discord, Telegram, email (SMTP or the Mailgun
 * API), or a generic webhook (JSON body signed with HMAC-SHA256 in X-DeployNow-Signature).
 */
import crypto from "crypto";
import nodemailer from "nodemailer";
import { prisma } from "./prisma";
import { decryptSecret, encryptSecret } from "./secretsCrypto";

export const CHANNEL_TYPES = ["slack", "discord", "telegram", "email", "mailgun", "webhook"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const EVENTS = [
  "deploy.success",
  "deploy.failure",
  "backup.success",
  "backup.failure",
  "restore.success",
  "restore.failure",
  "task.failure",
  "alert.firing",
  "alert.resolved",
  "update.available",
  "uptime.down",
  "uptime.up",
  "uptime.cert",
] as const;
export type NotifyEvent = (typeof EVENTS)[number];

export interface ChannelConfig {
  url?: string;
  botToken?: string;
  chatId?: string;
  secret?: string;
  // email
  host?: string;
  port?: string;
  security?: string; // tls (implicit, 465), starttls (587) or none
  user?: string;
  pass?: string;
  from?: string;
  to?: string;
  // mailgun
  apiKey?: string;
  domain?: string;
  region?: string; // us or eu
}

/** Mailgun's API host for a region. */
export function mailgunBase(region: string | undefined): string {
  return region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
}

const EMAIL_RE = /^[^@\s<>,]+@[^@\s<>,]+\.[^@\s<>,]+$/;

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
    case "email": {
      const host = str("host").toLowerCase();
      if (!/^[a-z0-9.-]+$/.test(host) || host.length > 253) throw new Error("Enter the SMTP server's host name");
      const security = ["tls", "starttls", "none"].includes(str("security")) ? str("security") : "starttls";
      const port = str("port") || (security === "tls" ? "465" : "587");
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Enter the SMTP port");
      const from = str("from");
      if (!EMAIL_RE.test(from.replace(/^.*<(.+)>$/, "$1"))) throw new Error("Enter the sender address");
      const to = str("to").split(/[,;\s]+/).filter(Boolean);
      if (!to.length || to.length > 20 || !to.every((a) => EMAIL_RE.test(a))) throw new Error("Enter one or more recipient addresses");
      const user = str("user");
      const pass = typeof raw.pass === "string" && raw.pass && raw.pass !== "••••••••" ? raw.pass : existing?.pass ?? "";
      return { host, port, security, user, pass, from, to: to.join(",") };
    }
    case "mailgun": {
      const domain = str("domain").toLowerCase();
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain) || domain.length > 253) {
        throw new Error("Enter your Mailgun sending domain, e.g. mg.example.com");
      }
      const region = str("region") === "eu" ? "eu" : "us";
      const apiKey = typeof raw.apiKey === "string" && raw.apiKey.trim() && raw.apiKey !== "••••••••" ? raw.apiKey.trim() : existing?.apiKey ?? "";
      if (!/^[\w-]{20,}$/.test(apiKey)) throw new Error("Enter a Mailgun API key (Sending API key)");
      const from = str("from") || `DeployNow <deploynow@${domain}>`;
      if (!EMAIL_RE.test(from.replace(/^.*<(.+)>$/, "$1"))) throw new Error("Enter the sender address");
      const to = str("to").split(/[,;\s]+/).filter(Boolean);
      if (!to.length || to.length > 20 || !to.every((a) => EMAIL_RE.test(a))) throw new Error("Enter one or more recipient addresses");
      return { apiKey, domain, region, from, to: to.join(",") };
    }
    default:
      throw new Error("Choose Slack, Discord, Telegram, email, Mailgun or webhook");
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

export function buildRequest(type: Exclude<ChannelType, "email">, cfg: ChannelConfig, n: Notification): { url: string; init: RequestInit } {
  if (type === "mailgun") {
    const mail = buildEmail(cfg, n);
    const form = new URLSearchParams();
    form.set("from", mail.from);
    for (const to of mail.to.split(",")) form.append("to", to);
    form.set("subject", mail.subject);
    form.set("text", mail.text);
    form.set("html", mail.html);
    form.set("h:X-DeployNow-Event", n.event);
    return {
      url: `${mailgunBase(cfg.region)}/v3/${encodeURIComponent(cfg.domain ?? "")}/messages`,
      init: {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`api:${cfg.apiKey ?? ""}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
    };
  }
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

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function buildEmail(cfg: ChannelConfig, n: Notification) {
  const rows = Object.entries(n.fields ?? {})
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join("");
  const html =
    `<div style="font-family:system-ui,sans-serif;font-size:14px">` +
    `<h2 style="font-size:16px;margin:0 0 8px">${n.ok ? "✅" : "❌"} ${escapeHtml(n.title)}</h2>` +
    `<p style="white-space:pre-wrap">${escapeHtml(n.text)}</p>` +
    (rows ? `<table style="font-size:13px">${rows}</table>` : "") +
    (n.link && /^https?:\/\//.test(n.link) ? `<p><a href="${escapeHtml(n.link)}">Open in DeployNow</a></p>` : "") +
    `</div>`;
  return {
    from: cfg.from!,
    to: cfg.to!,
    subject: `[DeployNow] ${n.title}`.replace(/[\r\n]+/g, " ").slice(0, 200),
    text: plain(n),
    html,
    headers: { "X-DeployNow-Event": n.event },
  };
}

export function smtpTransport(cfg: ChannelConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port),
    secure: cfg.security === "tls",
    requireTLS: cfg.security === "starttls",
    ignoreTLS: cfg.security === "none",
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

export async function sendTo(channel: { id: string; type: string; config: string }, n: Notification): Promise<void> {
  if (channel.type === "email") {
    const cfg = decryptConfig(channel.config);
    await smtpTransport(cfg).sendMail(buildEmail(cfg, n));
    return;
  }
  const { url, init } = buildRequest(channel.type as Exclude<ChannelType, "email">, decryptConfig(channel.config), n);
  const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    if (channel.type === "mailgun") {
      const detail = await res.text().catch(() => "");
      const hint = res.status === 401 ? " (check the API key and the region)" : res.status === 404 ? " (check the domain and the region)" : "";
      throw new Error(`Mailgun answered ${res.status}${hint}${detail ? `: ${detail.slice(0, 150)}` : ""}`);
    }
    throw new Error(`The channel answered ${res.status}`);
  }
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

