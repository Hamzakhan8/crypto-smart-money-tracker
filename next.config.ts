// Next.js settings for the pages (src/app). The scanners and every /api route come from the engine (server.ts), which
// next-server.ts runs in the same process.
import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // This folder is the project root. Without it Next.js also looks at lock files in parent folders (for example a
  // package-lock.json in the user's home folder) and warns about them.
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
};
export default config;
