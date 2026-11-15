import type { NextConfig } from "next";

/**
 * In production Traefik serves one origin: / the console, /api the control plane and /ingest
 * ingestion. For `next dev`, set RELAY_CONTROL_PLANE_URL (and RELAY_INGEST_URL) and these
 * rewrites proxy the same paths, so the refresh cookie (Path=/api/v1/auth, SameSite=Strict)
 * works exactly as in production.
 */
const controlPlane = process.env.RELAY_CONTROL_PLANE_URL;
const ingest = process.env.RELAY_INGEST_URL;

const config: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      ...(controlPlane ? [{ source: "/api/:path*", destination: `${controlPlane}/api/:path*` }] : []),
      ...(ingest ? [{ source: "/ingest/:path*", destination: `${ingest}/ingest/:path*` }] : []),
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;
