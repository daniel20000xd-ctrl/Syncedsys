import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Next 15+ defaults staleTimes.dynamic to 0, meaning every tab navigation
    // triggers a full server re-render even for pages you just visited.
    // Setting dynamic:30 means an already-visited board tab is served from the
    // client router cache instantly for 30 s, then revalidates in the background.
    staleTimes: {
      dynamic: 30,
      static: 300,
    },
  },
};

export default nextConfig;
