import { createDockerClient, dockerErrorMessage, probeDocker, type ProbeResult } from "./docker/client";
import type { EndpointInput } from "./endpoints";

export interface TestResult {
  ok: boolean;
  error?: string;
  info?: ProbeResult;
  hostKeyFingerprint?: string;
}

/**
 * Connect with the given settings without saving anything. For SSH, any host
 * key is accepted unless `pinnedFingerprint` is set; the key seen is returned
 * so it can be shown to the user and pinned.
 */
export async function testConnection(input: EndpointInput, pinnedFingerprint = ""): Promise<TestResult> {
  let seen: string | undefined;
  if (input.type === "agent") return { ok: false, error: "Agent endpoints connect on their own once the agent enrols" };
  try {
    const docker = createDockerClient({
      type: input.type,
      host: input.host,
      port: input.port,
      username: input.username,
      credentials: input.credentials,
      hostKeyFingerprint: pinnedFingerprint,
      onHostKey: (fp) => {
        seen = fp;
      },
    });
    const info = await probeDocker(docker);
    return { ok: true, info, hostKeyFingerprint: seen };
  } catch (err) {
    const mismatch = pinnedFingerprint && seen && seen !== pinnedFingerprint;
    return {
      ok: false,
      error: mismatch ? `SSH host key changed (now ${seen}); remove and re-add the endpoint if this is expected` : dockerErrorMessage(err),
      hostKeyFingerprint: seen,
    };
  }
}
