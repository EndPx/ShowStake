import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.SHOWSTAKE_NEXT_DIST_DIR || ".next",
  // Same-origin public API proxy: the browser fetches `/api/v1/*` only (no
  // cross-origin, no CORS) and Next rewrites that fixed prefix to the backend.
  // This is a strict, closed rewrite — it cannot reach arbitrary hosts, only
  // the ONE configured upstream, and it exposes the `/v1` API prefix the app
  // actually consumes. The upstream is server-side config, never inlined to the
  // client.
  async rewrites() {
    const upstream = process.env.SHOWSTAKE_API_UPSTREAM_URL || "http://127.0.0.1:3001";
    return [
      {
        source: "/api/v1/:path*",
        destination: `${upstream}/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;