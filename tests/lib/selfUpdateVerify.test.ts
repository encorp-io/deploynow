import { describe, it, expect, vi, beforeEach } from "vitest";
import type Docker from "dockerode";
import { OFFICIAL_REPO, SIGNER_WORKFLOW, repoDigestOf, releaseDigest, signerFor, verifyTarget, type CosignRunner } from "@/lib/selfUpdate/verify";
import { nextImageRef } from "@/lib/selfUpdate/shared";

const DIGEST = `${OFFICIAL_REPO}@sha256:${"a".repeat(64)}`;
const pulled = { Id: "sha256:img", RepoDigests: [`other.io/x@sha256:${"b".repeat(64)}`, DIGEST] };
const docker = {} as Docker;

const okCosign = () => vi.fn<CosignRunner>(async () => ({ code: 0, output: "Verification for … The cosign claims were validated" }));
const fetchWith = (status: number, body = "") => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

beforeEach(() => {
  delete process.env.DEPLOYNOW_VERIFY_IMAGES;
  delete process.env.DEPLOYNOW_IMAGE_SIGNER;
});

describe("which signature an image needs", () => {
  it("a release is signed by the workflow run for its own tag", () => {
    expect(signerFor(OFFICIAL_REPO, "2.1.0")).toEqual({ identity: `${SIGNER_WORKFLOW}@refs/tags/v2.1.0`, issuer: "https://token.actions.githubusercontent.com" });
    expect(signerFor(OFFICIAL_REPO, "v2.1.0-rc.1")?.identity).toBe(`${SIGNER_WORKFLOW}@refs/tags/v2.1.0-rc.1`);
  });

  it("edge by main, latest and 2.1 by some stable release tag", () => {
    expect(signerFor(OFFICIAL_REPO, "edge")?.identity).toBe(`${SIGNER_WORKFLOW}@refs/heads/main`);
    const re = new RegExp(signerFor(OFFICIAL_REPO, "latest")!.identityRegexp!);
    expect(re.test(`${SIGNER_WORKFLOW}@refs/tags/v2.1.0`)).toBe(true);
    expect(re.test(`${SIGNER_WORKFLOW}@refs/heads/main`)).toBe(false);
    expect(re.test(`${SIGNER_WORKFLOW}@refs/tags/v2.1.0-rc.1`)).toBe(false);
    expect(re.test(`https://github.com/evil/deploynow/.github/workflows/docker-publish.yml@refs/tags/v2.1.0`)).toBe(false);
  });

  it("another repository is only checked with DEPLOYNOW_IMAGE_SIGNER", () => {
    expect(signerFor("ghcr.io/me/deploynow", "2.1.0")).toBeNull();
    process.env.DEPLOYNOW_IMAGE_SIGNER = "^https://github.com/me/";
    expect(signerFor("ghcr.io/me/deploynow", "2.1.0")).toMatchObject({ identityRegexp: "^https://github.com/me/" });
  });

  it("finds the registry digest for the repository", () => {
    expect(repoDigestOf(pulled, OFFICIAL_REPO)).toBe(DIGEST);
    expect(repoDigestOf({ RepoDigests: [] }, OFFICIAL_REPO)).toBe("");
  });
});

describe("the release's digest list", () => {
  it("reads the line for the repository", async () => {
    const f = fetchWith(200, `${DIGEST}\nghcr.io/encorp-io/deploynow-agent@sha256:${"c".repeat(64)}\n`);
    expect(await releaseDigest("2.1.0", OFFICIAL_REPO, f)).toBe(DIGEST);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("https://github.com/encorp-io/deploynow/releases/download/v2.1.0/image-digests.txt");
  });

  it("null when the release has none or GitHub can't be reached", async () => {
    expect(await releaseDigest("2.1.0", OFFICIAL_REPO, fetchWith(404))).toBeNull();
    expect(await releaseDigest("2.1.0", OFFICIAL_REPO, vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe("verifyTarget", () => {
  const next = nextImageRef(`${OFFICIAL_REPO}:2.0.0`, "2.1.0")!;

  it("checks the signature of the pulled digest and the release's digest", async () => {
    const cosign = okCosign();
    const v = await verifyTarget(docker, OFFICIAL_REPO, next, pulled, { cosign, fetchImpl: fetchWith(200, `${DIGEST}\n`) });
    expect(v).toMatchObject({ digest: DIGEST, imageId: "sha256:img", signature: "verified", releaseDigest: "matched" });
    const args = cosign.mock.calls[0][1];
    expect(args.slice(0, 2)).toEqual(["verify", DIGEST]);
    expect(args).toContain(`${SIGNER_WORKFLOW}@refs/tags/v2.1.0`);
    expect(args).toContain("--certificate-identity");
  });

  it("refuses an image the release doesn't list", async () => {
    const other = `${OFFICIAL_REPO}@sha256:${"d".repeat(64)}`;
    const cosign = okCosign();
    await expect(verifyTarget(docker, OFFICIAL_REPO, next, pulled, { cosign, fetchImpl: fetchWith(200, `${other}\n`) })).rejects.toThrow(/lists sha256:d/);
    await expect(verifyTarget(docker, OFFICIAL_REPO, next, pulled, { cosign, fetchImpl: fetchWith(200, "nothing here\n") })).rejects.toThrow(/no digest for it/);
    expect(cosign).not.toHaveBeenCalled();
  });

  it("refuses an unsigned image, or a signature from someone else", async () => {
    const cosign = vi.fn<CosignRunner>(async () => ({ code: 1, output: "Error: no matching signatures: none of the expected identities matched" }));
    await expect(verifyTarget(docker, OFFICIAL_REPO, next, pulled, { cosign, fetchImpl: fetchWith(404) })).rejects.toThrow(/no valid signature.*no matching signatures/);
  });

  it("refuses when cosign can't run", async () => {
    const cosign = vi.fn<CosignRunner>(async () => { throw new Error("pull access denied"); });
    await expect(verifyTarget(docker, OFFICIAL_REPO, next, pulled, { cosign, fetchImpl: fetchWith(404) })).rejects.toThrow(/Couldn't run cosign/);
  });

  it("refuses an image without a registry digest", async () => {
    await expect(verifyTarget(docker, OFFICIAL_REPO, next, { Id: "sha256:img", RepoDigests: [] }, { cosign: okCosign() })).rejects.toThrow(/registry digest/);
  });

  it("edge is checked against main, without a release", async () => {
    const cosign = okCosign();
    const f = fetchWith(200, "");
    const edge = nextImageRef(`${OFFICIAL_REPO}:2.0.0`, "2.1.0", "edge")!;
    expect(await verifyTarget(docker, OFFICIAL_REPO, edge, pulled, { cosign, fetchImpl: f })).toMatchObject({ signature: "verified", releaseDigest: "skipped" });
    expect(cosign.mock.calls[0][1]).toContain(`${SIGNER_WORKFLOW}@refs/heads/main`);
    expect(f).not.toHaveBeenCalled();
  });

  it("skips when turned off or for someone else's image", async () => {
    const cosign = okCosign();
    process.env.DEPLOYNOW_VERIFY_IMAGES = "off";
    expect(await verifyTarget(docker, OFFICIAL_REPO, next, pulled, { cosign })).toMatchObject({ signature: "skipped", note: expect.stringMatching(/off/) });
    delete process.env.DEPLOYNOW_VERIFY_IMAGES;
    const mine = nextImageRef("ghcr.io/me/deploynow:2.0.0", "2.1.0")!;
    expect(await verifyTarget(docker, "ghcr.io/me/deploynow", mine, pulled, { cosign })).toMatchObject({ signature: "skipped", note: expect.stringMatching(/official/) });
    expect(cosign).not.toHaveBeenCalled();
  });
});
