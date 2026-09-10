import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@react-pdf/renderer", "bcryptjs", "sharp"],
  experimental: { serverActions: { bodySizeLimit: "16mb" } },
  turbopack: { root: fileURLToPath(new URL("../..", import.meta.url)) },
};

export default nextConfig;
