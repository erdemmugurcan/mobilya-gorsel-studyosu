import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The round "N" dev badge sat on top of the sticky ÜRET bar; errors still surface.
  devIndicators: false,
  serverExternalPackages: ["@imgly/background-removal-node", "onnxruntime-node", "sharp"],
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
