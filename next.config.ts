import type { NextConfig } from "next";
import pkg from "./package.json";

const securityHeaders = [
  { key: "X-Frame-Options",        value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy",        value: "strict-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // HSTS is set by nginx at the TLS layer — not duplicated here
  // { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Next.js requires unsafe-eval in dev; tighten in prod if possible
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'", // also covers the same-origin console WebSocket at /ws/exec
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Shown in the sidebar and at /api/health. Release images pass the git tag as DEPLOYNOW_VERSION.
  env: { NEXT_PUBLIC_DEPLOYNOW_VERSION: (process.env.DEPLOYNOW_VERSION || pkg.version).replace(/^v/, "") },
  serverExternalPackages: ["@prisma/client", "bcryptjs", "dockerode", "docker-modem", "ssh2", "cpu-features", "ws", "qrcode"],
  // OAuth discovery (RFC 8414, RFC 9728) and the MCP endpoint for AI connectors
  async rewrites() {
    return [
      { source: "/.well-known/oauth-authorization-server/:path*", destination: "/api/oauth/metadata" },
      { source: "/.well-known/oauth-protected-resource/:path*", destination: "/api/oauth/resource-metadata" },
      { source: "/mcp", destination: "/api/mcp" },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
