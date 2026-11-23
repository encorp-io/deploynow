/** The public URL DeployNow is reached at. */
/** The configured public URL (AUTH_URL), else the request's forwarded host. */
export function publicOrigin(request: Request): string {
  const configured = process.env.AUTH_URL || process.env.NEXTAUTH_URL;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      /* fall through */
    }
  }
  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "localhost";
  return `${proto}://${host}`;
}
