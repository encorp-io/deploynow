/**
 * Outbound requests to addresses a user typed in (a registry host, a token
 * realm the registry names) must not reach DeployNow's own network: the
 * loopback, the Docker networks, the LAN or a cloud metadata service.
 *
 * guardedLookup resolves the host and refuses it if any address is internal,
 * and the connection is made to the address it returned. A name can't pass the
 * check and then resolve somewhere else (DNS rebinding), because there is no
 * second lookup.
 *
 * - Metadata and link-local addresses are always refused.
 * - Loopback, private, CGNAT and unique-local addresses are refused unless the
 *   caller allows them (admins testing a registry on their LAN).
 */
import dns from "dns";
import https from "https";
import net from "net";

export class BlockedAddressError extends Error {}

export interface GuardOptions {
  /** Allow loopback and private ranges. Metadata and link-local stay refused. */
  allowPrivate?: boolean;
}

function list(entries: [string, number, "ipv4" | "ipv6"][]): net.BlockList {
  const b = new net.BlockList();
  for (const [addr, prefix, type] of entries) b.addSubnet(addr, prefix, type);
  return b;
}

// Never reachable from a user-supplied URL
const ALWAYS = list([
  ["0.0.0.0", 8, "ipv4"], // "this network"; 0.0.0.0 reaches the loopback on Linux
  ["169.254.0.0", 16, "ipv4"], // link-local, cloud metadata (169.254.169.254)
  ["100.100.100.200", 32, "ipv4"], // Alibaba Cloud metadata
  ["192.0.0.0", 24, "ipv4"], // IETF protocol assignments (incl. Oracle metadata 192.0.0.192)
  ["224.0.0.0", 4, "ipv4"], // multicast
  ["240.0.0.0", 4, "ipv4"], // reserved, broadcast
  ["::", 128, "ipv6"],
  ["fe80::", 10, "ipv6"], // link-local
  ["fd00:ec2::254", 128, "ipv6"], // AWS metadata over IPv6
  ["ff00::", 8, "ipv6"], // multicast
]);

// Internal unless the caller allows it
const PRIVATE = list([
  ["127.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"], // Docker's default bridge networks live here
  ["192.168.0.0", 16, "ipv4"],
  ["100.64.0.0", 10, "ipv4"], // CGNAT, Tailscale
  ["198.18.0.0", 15, "ipv4"], // benchmarking
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"], // unique local
  ["64:ff9b::", 96, "ipv6"], // NAT64 can embed any IPv4 address
  ["2002::", 16, "ipv6"], // 6to4 likewise
]);

/** The 8 groups of an IPv6 address as numbers, or null. */
function v6Groups(a: string): number[] | null {
  let head = a;
  let tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    head = a.slice(0, -v4[1].length).replace(/:$/, a.endsWith("::" + v4[1]) ? ":" : "");
  }
  const parse = (part: string) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - left.length - right.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...left, ...Array(halves.length === 2 ? fill : 0).fill(0), ...right, ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * Lower-case, zone id dropped, and IPv4 embedded in IPv6 unwrapped: IPv4-mapped
 * (::ffff:7f00:1 and ::ffff:127.0.0.1, both reach 127.0.0.1 on Linux) and the
 * old IPv4-compatible form (::7f00:1).
 */
function normalize(ip: string): string {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  if (net.isIP(bare) !== 6) return bare;
  const g = v6Groups(bare);
  if (!g) return bare;
  const embedsV4 = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || (g[5] === 0 && (g[6] !== 0 || g[7] > 1)));
  return embedsV4 ? [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".") : bare;
}

/** Why `ip` is refused, or null if it may be reached. */
export function blockedReason(ip: string, opts: GuardOptions = {}): "metadata" | "private" | "invalid" | null {
  const a = normalize(ip);
  const family = net.isIP(a);
  if (!family) return "invalid";
  const type = family === 4 ? "ipv4" : "ipv6";
  if (ALWAYS.check(a, type)) return "metadata";
  if (!opts.allowPrivate && PRIVATE.check(a, type)) return "private";
  return null;
}

export function isBlockedAddress(ip: string, opts: GuardOptions = {}): boolean {
  return blockedReason(ip, opts) !== null;
}

type LookupAll = (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void;
type LookupOne = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

/** A dns.lookup replacement for net/http(s) that refuses internal addresses. */
export function guardedLookup(opts: GuardOptions = {}) {
  return (hostname: string, options: dns.LookupOptions | number | undefined, callback: LookupAll | LookupOne) => {
    const o: dns.LookupOptions = typeof options === "number" ? { family: options } : options ?? {};
    dns.lookup(hostname, { ...o, all: true }, (err, addresses) => {
      if (err) return (callback as LookupOne)(err, "", 0);
      // Refuse the name if any of its addresses is internal, so round-robin can't sneak one in
      const bad = addresses.find((a) => isBlockedAddress(a.address, opts));
      if (!addresses.length || bad) {
        const e = new BlockedAddressError(`${hostname} resolves to an address that isn't allowed`) as NodeJS.ErrnoException;
        e.code = "EBLOCKED";
        return (callback as LookupOne)(e, "", 0);
      }
      if (o.all) return (callback as LookupAll)(null, addresses);
      (callback as LookupOne)(null, addresses[0].address, addresses[0].family);
    });
  };
}

export interface GuardedResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  /** The body, when the request asked for it with maxBodyBytes (else ""). */
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface GuardedRequest extends GuardOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Keep up to this many bytes of the body; larger bodies fail. Default: discard it. */
  maxBodyBytes?: number;
}

/**
 * GET an https URL without following redirects, refusing internal addresses.
 * The body is discarded unless `maxBodyBytes` asks for it (capped). The deadline
 * covers reading the body too.
 */
export function guardedGet(rawUrl: string | URL, req: GuardedRequest = {}): Promise<GuardedResponse> {
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return Promise.reject(new BlockedAddressError("Not a valid URL"));
  }
  if (url.protocol !== "https:") return Promise.reject(new BlockedAddressError("Only https addresses are allowed"));
  if (url.username || url.password) return Promise.reject(new BlockedAddressError("Credentials in the URL aren't allowed"));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // An IP literal skips the lookup, so check it here
  if (net.isIP(host) && isBlockedAddress(host, req)) return Promise.reject(new BlockedAddressError(`${host} isn't an allowed address`));

  const timeoutMs = req.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    // An absolute deadline: the socket timeout below only fires on inactivity, so a
    // server trickling bytes could otherwise hold the request open forever
    const deadline = setTimeout(() => r.destroy(new Error("timed out")), timeoutMs);
    const done = <T,>(fn: (v: T) => void) => (v: T) => {
      clearTimeout(deadline);
      fn(v);
    };
    const r = https.request(
      url,
      {
        method: "GET",
        headers: req.headers,
        agent: false, // a fresh socket, always to the address just checked
        lookup: guardedLookup(req) as unknown as typeof dns.lookup,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers = {
          get(name: string) {
            const v = res.headers[name.toLowerCase()];
            return v === undefined ? null : Array.isArray(v) ? v.join(", ") : String(v);
          },
        };
        const respond = (body: string) => {
          const text = async () => body;
          done(resolve)({ status, ok: status >= 200 && status < 300, headers, text, json: async () => JSON.parse(body) as unknown });
        };
        const max = req.maxBodyBytes ?? 0;
        if (!max) {
          res.resume(); // drain and drop the body
          return respond("");
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > max) return r.destroy(new Error("response too large"));
          chunks.push(c);
        });
        res.on("end", () => respond(Buffer.concat(chunks).toString("utf8")));
        res.on("error", done(reject));
      },
    );
    r.on("timeout", () => r.destroy(new Error("timed out")));
    r.on("error", done(reject));
    r.end();
  });
}
