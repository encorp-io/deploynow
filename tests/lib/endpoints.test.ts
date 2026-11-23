import { describe, it, expect } from "vitest";
import { encryptCredentials, parseCredentials, serializeEndpoint, validateEndpointInput } from "@/lib/endpoints";
import { buildDockerOptions, sshFingerprint } from "@/lib/docker/client";
import type { Endpoint } from "@prisma/client";

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
const CERT = "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----";
const PKEY = "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----";

function endpoint(extra: Partial<Endpoint>): Endpoint {
  return { id: "e", name: "prod", type: "ssh", host: "10.0.0.2", port: 22, username: "deploy", credentials: encryptCredentials({ privateKey: KEY }), hostKeyFingerprint: "SHA256:abc", labels: "", status: "online", ...extra } as Endpoint;
}

describe("validateEndpointInput", () => {
  it("defaults a socket endpoint to the standard path", () => {
    expect(validateEndpointInput({ name: "local", type: "socket" }).data).toMatchObject({ host: "/var/run/docker.sock", port: null });
  });

  it("rejects unsafe socket paths", () => {
    expect(validateEndpointInput({ name: "x", type: "socket", host: "relative.sock" }).error).toBeTruthy();
    expect(validateEndpointInput({ name: "x", type: "socket", host: "/var/../etc/passwd" }).error).toBeTruthy();
  });

  it("validates names, types, hosts and ports", () => {
    expect(validateEndpointInput({ name: "<script>", type: "socket" }).error).toBeTruthy();
    expect(validateEndpointInput({ name: "x", type: "ftp" }).error).toBeTruthy();
    expect(validateEndpointInput({ name: "x", type: "ssh", host: "bad host;rm", privateKey: KEY }).error).toBeTruthy();
    expect(validateEndpointInput({ name: "x", type: "ssh", host: "169.254.169.254", privateKey: KEY }).error).toBe("That host is not allowed");
    expect(validateEndpointInput({ name: "x", type: "ssh", host: "h.example.com", port: 70000, privateKey: KEY }).error).toBeTruthy();
  });

  it("needs a private key for SSH and defaults the port and user", () => {
    expect(validateEndpointInput({ name: "x", type: "ssh", host: "h.example.com" }).error).toMatch(/private key/);
    expect(validateEndpointInput({ name: "x", type: "ssh", host: "h.example.com", privateKey: KEY }).data).toMatchObject({ port: 22, username: "root" });
  });

  it("needs all three PEMs for TLS", () => {
    expect(validateEndpointInput({ name: "x", type: "tls", host: "h", ca: CERT, cert: CERT }).error).toBeTruthy();
    expect(validateEndpointInput({ name: "x", type: "tls", host: "h", ca: CERT, cert: CERT, key: PKEY }).data?.port).toBe(2376);
  });

  it("keeps stored keys when an edit leaves them empty", () => {
    const res = validateEndpointInput({ name: "prod2" }, endpoint({}));
    expect(res.data?.credentials.privateKey).toBe(KEY);
    expect(res.data?.name).toBe("prod2");
  });

  it("cleans labels", () => {
    expect(validateEndpointInput({ name: "x", type: "socket", labels: "Prod, eu-west ,bad label!,," }).data?.labels).toBe("prod,eu-west");
  });
});

describe("endpoint credentials", () => {
  it("are encrypted at rest and never serialised", () => {
    const enc = encryptCredentials({ privateKey: KEY });
    expect(enc).not.toContain("PRIVATE KEY");
    expect(parseCredentials(enc).privateKey).toBe(KEY);
    expect(parseCredentials("garbage")).toEqual({});
    const json = JSON.stringify(serializeEndpoint(endpoint({})));
    expect(json).not.toContain("PRIVATE KEY");
    expect(json).not.toContain(enc);
    expect(serializeEndpoint(endpoint({})).hasPrivateKey).toBe(true);
  });
});

describe("buildDockerOptions", () => {
  it("pins the SSH host key", () => {
    const key = Buffer.from("host-key");
    const fp = sshFingerprint(key);
    const seen: string[] = [];
    const opts = buildDockerOptions({ type: "ssh", host: "h", port: 22, username: "u", credentials: { privateKey: KEY }, hostKeyFingerprint: fp, onHostKey: (f) => seen.push(f) });
    const verify = (opts.sshOptions as { hostVerifier: (k: Buffer) => boolean }).hostVerifier;
    expect(verify(key)).toBe(true);
    expect(verify(Buffer.from("other-key"))).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it("builds socket and TLS options", () => {
    expect(buildDockerOptions({ type: "socket", host: "/run/docker.sock", credentials: {} })).toEqual({ socketPath: "/run/docker.sock" });
    expect(buildDockerOptions({ type: "tls", host: "h", port: null, credentials: { ca: CERT, cert: CERT, key: PKEY } })).toMatchObject({ protocol: "https", port: 2376 });
  });
});
