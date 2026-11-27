import { describe, it, expect, vi, afterEach } from "vitest";
import dns from "dns";
import https from "https";
import { BlockedAddressError, blockedReason, guardedGet, guardedLookup, isBlockedAddress } from "@/lib/netGuard";

afterEach(() => vi.restoreAllMocks());

describe("blockedReason", () => {
  it("always refuses metadata, link-local and unspecified addresses", () => {
    for (const ip of ["169.254.169.254", "169.254.1.1", "0.0.0.0", "100.100.100.200", "192.0.0.192", "fe80::1", "fd00:ec2::254", "::", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "224.0.0.1"]) {
      expect(blockedReason(ip), ip).toBe("metadata");
      expect(blockedReason(ip, { allowPrivate: true }), ip).toBe("metadata");
    }
  });

  it("refuses loopback and private ranges unless allowed", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.17.0.2", "172.31.255.255", "192.168.1.10", "100.64.0.1", "::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "[::ffff:7f00:1]", "0:0:0:0:0:ffff:a00:1", "::7f00:1", "::ffff:0a00:0001", "64:ff9b::a00:1"]) {
      expect(blockedReason(ip), ip).toBe("private");
      expect(blockedReason(ip, { allowPrivate: true }), ip).toBeNull();
    }
  });

  it("lets public addresses through", () => {
    for (const ip of ["140.82.112.33", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "[2606:4700::1111]"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it("treats garbage as invalid", () => {
    expect(blockedReason("not-an-ip")).toBe("invalid");
  });
});

describe("guardedLookup", () => {
  const fakeDns = (addresses: dns.LookupAddress[]) =>
    vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) => cb(null, addresses)) as unknown as typeof dns.lookup);

  const run = (opts = {}, lookupOpts: dns.LookupOptions = {}) =>
    new Promise<{ err: NodeJS.ErrnoException | null; result: unknown }>((resolve) =>
      guardedLookup(opts)("registry.example.com", lookupOpts, ((err: NodeJS.ErrnoException | null, result: unknown) => resolve({ err, result })) as never),
    );

  it("refuses a name that resolves to an internal address (rebinding to metadata)", async () => {
    fakeDns([{ address: "169.254.169.254", family: 4 }]);
    const { err } = await run({ allowPrivate: true });
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err?.code).toBe("EBLOCKED");
  });

  it("refuses the name if any of its addresses is internal", async () => {
    fakeDns([{ address: "140.82.112.33", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    expect((await run()).err).toBeInstanceOf(BlockedAddressError);
  });

  it("returns the checked address, alone or all of them", async () => {
    fakeDns([{ address: "140.82.112.33", family: 4 }]);
    expect((await run()).err).toBeNull();
    expect((await run({}, { all: true })).result).toEqual([{ address: "140.82.112.33", family: 4 }]);
  });

  it("allows a private address for admins", async () => {
    fakeDns([{ address: "192.168.1.20", family: 4 }]);
    expect((await run({ allowPrivate: true })).err).toBeNull();
  });
});

describe("guardedGet", () => {
  it("only speaks https", async () => {
    await expect(guardedGet("http://registry.example.com/v2/")).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(guardedGet("file:///etc/passwd")).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(guardedGet("not a url")).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("refuses internal IP literals before connecting", async () => {
    const spy = vi.spyOn(https, "request");
    await expect(guardedGet("https://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(guardedGet("https://127.0.0.1:5000/v2/")).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(guardedGet("https://[::1]/v2/")).rejects.toBeInstanceOf(BlockedAddressError);
    // new URL() turns ::ffff:127.0.0.1 into the hex form ::ffff:7f00:1
    await expect(guardedGet("https://[::ffff:127.0.0.1]:5000/")).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(guardedGet("https://[::ffff:a9fe:a9fe]/", { allowPrivate: true })).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(guardedGet("https://[fd00:ec2::254]/", { allowPrivate: true })).rejects.toBeInstanceOf(BlockedAddressError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("gives up after the deadline even if the server keeps trickling bytes", async () => {
    vi.useFakeTimers();
    const fake = Object.assign(new (require("events").EventEmitter)(), { end: vi.fn(), destroy: vi.fn(function (this: any, e: Error) { this.emit("error", e); }) });
    vi.spyOn(https, "request").mockReturnValue(fake as never);
    vi.spyOn(dns, "lookup");
    const p = guardedGet("https://140.82.112.33/v2/", { timeoutMs: 50 });
    vi.advanceTimersByTime(60);
    await expect(p).rejects.toThrow(/timed out/);
    vi.useRealTimers();
  });

  it("refuses a name that resolves to loopback", async () => {
    await expect(guardedGet("https://localhost:1/v2/")).rejects.toBeInstanceOf(BlockedAddressError);
  });
});

describe("guardedGet body", () => {
  const fakeResponse = (chunks: string[]) => {
    const { EventEmitter } = require("events");
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn(function (this: any, e: Error) { this.emit("error", e); }) });
    vi.spyOn(https, "request").mockImplementation(((_u: unknown, _o: unknown, cb: (r: unknown) => void) => {
      const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": "application/json" }, resume: vi.fn() });
      setImmediate(() => {
        cb(res);
        for (const c of chunks) res.emit("data", Buffer.from(c));
        res.emit("end");
      });
      return req;
    }) as never);
  };

  it("discards the body by default and reads it when asked", async () => {
    fakeResponse(['{"a":', "1}"]);
    expect(await (await guardedGet("https://140.82.112.33/")).text()).toBe("");
    fakeResponse(['{"a":', "1}"]);
    expect(await (await guardedGet("https://140.82.112.33/", { maxBodyBytes: 100 })).json()).toEqual({ a: 1 });
  });

  it("fails a body over the cap", async () => {
    fakeResponse(["x".repeat(60), "x".repeat(60)]);
    await expect(guardedGet("https://140.82.112.33/", { maxBodyBytes: 100 })).rejects.toThrow(/too large/);
  });
});
