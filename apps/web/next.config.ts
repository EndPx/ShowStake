import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.SHOWSTAKE_NEXT_DIST_DIR || ".next",
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  // Same-origin public API proxy: the browser fetches `/api/v1/*` only (no
  // cross-origin, no CORS) and Next rewrites that fixed prefix to the backend.
  // This is a strict, closed rewrite — it cannot reach arbitrary hosts, only
  // the ONE configured upstream, and it exposes the `/v1` API prefix the app
  // actually consumes. The upstream is server-side config, never inlined to the
  // client.
  async rewrites() {
    const configured = process.env.SHOWSTAKE_API_UPSTREAM_URL;
    if (process.env.VERCEL === "1" && !configured) {
      return [{ source: "/api/v1/:path*", destination: "/api/backend-unavailable" }];
    }
    const upstream = configured || "http://127.0.0.1:3001";
    const prefix = process.env.SHOWSTAKE_API_PREFIX || "";
    if (prefix !== "" && prefix !== "/testnet") throw new Error("SHOWSTAKE_API_PREFIX must be empty or /testnet");
    const url = new URL(upstream);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !["http:", "https:"].includes(url.protocol)) throw new Error("SHOWSTAKE_API_UPSTREAM_URL must be a plain API origin");
    if (process.env.VERCEL === "1" && (url.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Vercel requires a public HTTPS API origin");
    return [
      {
        source: "/api/v1/:path*",
        destination: `${url.origin}${prefix}/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
