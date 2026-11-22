import { prisma } from "./prisma";
import { decryptSecret } from "./secretsCrypto";
import { parseImageRef } from "./imageRef";

export interface AuthConfig {
  username: string;
  password: string;
  serveraddress: string;
}

/** Registry credentials Docker should use to pull `image`, if we have any. */
export async function registryAuthFor(image: string): Promise<AuthConfig | undefined> {
  const { registry } = parseImageRef(image);
  if (registry !== "ghcr.io") return undefined;
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const token = settings?.githubToken ? decryptSecret(settings.githubToken) : "";
  if (!token) return undefined;
  return { username: settings?.githubUser || "token", password: token, serveraddress: "ghcr.io" };
}
