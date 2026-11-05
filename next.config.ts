// Next.js settings for the pages (src/app). The scanners and every /api route come from the engine (server.ts), which
// next-server.ts runs in the same process.
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};
export default config;
