import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-host deployment kit (Task 15): produces `.next/standalone` — a
  // self-contained server.js + trimmed node_modules — so the Docker runtime
  // image doesn't need the full source tree or a `next start` invocation.
  // Confirmed still the current mechanism in Next 16 (see
  // node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md);
  // no changed conventions vs. earlier Next majors. `public/` and
  // `.next/static` are NOT copied into `.next/standalone` automatically per
  // that doc — the Dockerfile copies them in explicitly.
  //
  // better-sqlite3 and pino are on Next's built-in serverExternalPackages
  // default list (native/Node-specific packages excluded from Server
  // Component bundling), so no explicit `serverExternalPackages` entry is
  // needed here.
  output: "standalone",
};

export default nextConfig;
