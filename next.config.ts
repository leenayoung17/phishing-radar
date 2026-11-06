import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // 빌드(배포)된 시각. /api/health 에서 '언제 배포된 코드인지' 확인하는 데 쓴다.
  env: { BUILD_TIME: new Date().toISOString() },
  cacheComponents: true,
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
