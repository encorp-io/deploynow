import { authenticateClient } from "@/lib/oauth/clients";
import { formBody, json, oauthError, preflight } from "@/lib/oauth/http";
import { revokeToken } from "@/lib/oauth/server";

/** RFC 7009 token revocation. Answers 200 for unknown tokens too. */
export async function POST(request: Request) {
  const body = await formBody(request);
  try {
    const client = await authenticateClient(request, body);
    await revokeToken(client, body.get("token") ?? "");
    return json({});
  } catch (err) {
    return oauthError(err);
  }
}

export const OPTIONS = preflight;
