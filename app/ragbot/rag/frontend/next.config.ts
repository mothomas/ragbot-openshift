import type { NextConfig } from "next";

// Frappe serves the page at /ask (rag/www/ask.html) and these assets from /assets/rag/ask.
// Next compiles this config to next.config.compiled.js and requires that, so an import of
// lib/peers.ts (ASSETS) is not resolvable from there, by either path: the two change together.
const config: NextConfig = {
  output: "export",
  assetPrefix: "/assets/rag/ask",
  images: { unoptimized: true },
};

export default config;
