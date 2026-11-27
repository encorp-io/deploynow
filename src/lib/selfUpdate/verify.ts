/**
 * Checking an image before DeployNow switches to it.
 *
 * The updater starts the new image as root with the Docker socket, so a tag that
 * was moved to someone else's image would own the host. Before the switch:
 *
 *   1. The image is identified by its digest from here on: the updater gets the
 *      image id and refuses to start anything else (runner.ts).
 *   2. A release lists the digests it shipped (image-digests.txt on the GitHub
 *      release, written by .github/workflows/docker-publish.yml). When the target
 *      is a release and that file is there, the pulled digest must be in it.
 *   3. The cosign signature must come from this repository's docker-publish
 *      workflow, for the git ref the tag stands for: refs/tags/v1.2.3 for 1.2.3,
 *      refs/heads/main for edge, any release tag for latest or 1.2. cosign runs
 *      in its own container (pinned by digest), pulled through the Docker socket,
 *      so the DeployNow image doesn't carry it.
 *
 * DEPLOYNOW_VERIFY_IMAGES=off skips 2 and 3 (an air-gapped mirror, say). Images
 * from another repository (a fork or your own build) are only checked when
 * DEPLOYNOW_IMAGE_SIGNER names the certificate identity (a regular expression)
 * to expect.
 */
import type Docker from "dockerode";
import type { AuthConfig } from "../registryAuth";
import { pullImage } from "../docker/recreate";
import { demuxLogs, isPinnedTag, type NextImage } from "./shared";

export const OFFICIAL_REPO = "ghcr.io/encorp-io/deploynow";
export const SIGNER_WORKFLOW = "https://github.com/encorp-io/deploynow/.github/workflows/docker-publish.yml";
export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
// cosign v3.1.6. Update: crane digest ghcr.io/sigstore/cosign/cosign:<version>
export const COSIGN_IMAGE =
  process.env.DEPLOYNOW_COSIGN_IMAGE ||
  "ghcr.io/sigstore/cosign/cosign:v3.1.6@sha256:7d08ec40d6f6fd9ced81a498c367ee6d4dd90d73218f58a791f78661bdbef769";
const RELEASE_DOWNLOAD = process.env.DEPLOYNOW_RELEASE_DOWNLOAD_URL || "https://github.com/encorp-io/deploynow/releases/download";
const COSIGN_TIMEOUT_MS = 120_000;

export class VerifyError extends Error {}

export function verifyEnabledByEnv(): boolean {
  return String(process.env.DEPLOYNOW_VERIFY_IMAGES ?? "").toLowerCase() !== "off";
}

export interface Signer {
  identity?: string; // exact certificate identity
  identityRegexp?: string;
  issuer: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Which signature to expect for repo:tag, or null when there's nothing to check it against. */
export function signerFor(repo: string, tag: string): Signer | null {
  const custom = process.env.DEPLOYNOW_IMAGE_SIGNER;
  if (repo !== OFFICIAL_REPO) {
    return custom ? { identityRegexp: custom, issuer: process.env.DEPLOYNOW_IMAGE_SIGNER_ISSUER || OIDC_ISSUER } : null;
  }
  if (isPinnedTag(tag)) return { identity: `${SIGNER_WORKFLOW}@refs/tags/v${tag.replace(/^v/, "")}`, issuer: OIDC_ISSUER };
  if (tag === "edge") return { identity: `${SIGNER_WORKFLOW}@refs/heads/main`, issuer: OIDC_ISSUER };
  // latest, 1, 1.2: some stable release
  return { identityRegexp: `^${esc(SIGNER_WORKFLOW)}@refs/tags/v\\d+\\.\\d+\\.\\d+$`, issuer: OIDC_ISSUER };
}

/** repo@sha256:… of a pulled image (the registry's manifest digest), or "" when Docker doesn't know it. */
export function repoDigestOf(image: Pick<Docker.ImageInspectInfo, "RepoDigests">, repo: string): string {
  return (image.RepoDigests ?? []).find((d) => d.startsWith(`${repo}@sha256:`)) ?? "";
}

/** The digest a release lists for repo, null when the release has no image-digests.txt. */
export async function releaseDigest(tag: string, repo: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const url = `${RELEASE_DOWNLOAD}/v${tag.replace(/^v/, "")}/image-digests.txt`;
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
  } catch {
    return null; // GitHub unreachable: the signature check still applies
  }
  if (!res.ok) return null;
  const text = await res.text();
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith(`${repo}@sha256:`));
  return line ?? "";
}

export interface CosignResult {
  code: number;
  output: string;
}

export type CosignRunner = (docker: Docker, args: string[], auth?: AuthConfig) => Promise<CosignResult>;

/** Run cosign in a throwaway container (network on, nothing mounted). */
export const runCosign: CosignRunner = async (docker, args, auth) => {
  try {
    await docker.getImage(COSIGN_IMAGE).inspect();
  } catch {
    await pullImage(docker, COSIGN_IMAGE);
  }
  const authArgs = auth?.username && auth?.password ? ["--registry-username", auth.username, "--registry-password", auth.password] : [];
  const c = await docker.createContainer({
    Image: COSIGN_IMAGE,
    Cmd: [...args, ...authArgs],
    Labels: { "deploynow.role": "verify" },
    HostConfig: { AutoRemove: false, ReadonlyRootfs: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] },
  } as Docker.ContainerCreateOptions);
  try {
    await c.start();
    const waited = await Promise.race([
      c.wait() as Promise<{ StatusCode: number }>,
      new Promise<null>((r) => setTimeout(() => r(null), COSIGN_TIMEOUT_MS).unref?.()),
    ]);
    const buf = (await c.logs({ stdout: true, stderr: true, tail: 40 })) as unknown as Buffer;
    const output = demuxLogs(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))).trim();
    if (!waited) return { code: -1, output: `cosign didn't finish in ${COSIGN_TIMEOUT_MS / 1000}s. ${output}`.trim() };
    return { code: waited.StatusCode, output };
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
};

export interface Verified {
  digest: string; // repo@sha256:…
  imageId: string;
  signature: "verified" | "skipped";
  releaseDigest: "matched" | "absent" | "skipped";
  note: string; // one line for the audit log
}

/**
 * Check the pulled target before the switch. Throws VerifyError when it isn't the
 * image the tag should stand for.
 */
export async function verifyTarget(
  docker: Docker,
  repo: string,
  next: NextImage,
  pulled: Pick<Docker.ImageInspectInfo, "Id" | "RepoDigests">,
  opts: { auth?: AuthConfig; cosign?: CosignRunner; fetchImpl?: typeof fetch } = {},
): Promise<Verified> {
  const digest = repoDigestOf(pulled, repo);
  const out: Verified = { digest, imageId: pulled.Id, signature: "skipped", releaseDigest: "skipped", note: "" };
  if (!verifyEnabledByEnv()) {
    out.note = "Signature check is off (DEPLOYNOW_VERIFY_IMAGES=off)";
    return out;
  }
  const signer = signerFor(repo, next.tag);
  if (!signer) {
    out.note = `Not checked: ${repo} isn't DeployNow's official image (set DEPLOYNOW_IMAGE_SIGNER to check your own)`;
    return out;
  }
  if (!digest) throw new VerifyError(`Docker doesn't report a registry digest for ${next.ref}, so it can't be checked.`);

  if (repo === OFFICIAL_REPO && next.pinned) {
    const listed = await releaseDigest(next.tag, repo, opts.fetchImpl);
    if (listed === null) out.releaseDigest = "absent";
    else if (listed !== digest) {
      throw new VerifyError(`${next.ref} pulled as ${digest.split("@")[1]}, but release ${next.tag} lists ${listed.split("@")[1] || "no digest for it"}. Not switching.`);
    } else out.releaseDigest = "matched";
  }

  const args = [
    "verify",
    digest,
    "--certificate-oidc-issuer",
    signer.issuer,
    ...(signer.identity ? ["--certificate-identity", signer.identity] : ["--certificate-identity-regexp", signer.identityRegexp!]),
    "--output",
    "text",
  ];
  let res: CosignResult;
  try {
    res = await (opts.cosign ?? runCosign)(docker, args, opts.auth);
  } catch (err) {
    throw new VerifyError(`Couldn't run cosign to check the signature: ${(err as Error).message}`);
  }
  if (res.code !== 0) {
    const why = res.output.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 600);
    throw new VerifyError(`${next.ref} has no valid signature from ${signer.identity ?? signer.identityRegexp}. Not switching. ${why}`.trim());
  }
  out.signature = "verified";
  out.note = `Signature verified (${signer.identity ?? "a release of encorp-io/deploynow"})${out.releaseDigest === "matched" ? ", digest matches the release" : ""}`;
  return out;
}
