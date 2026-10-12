import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["pdfmake"],
  outputFileTracingIncludes: {
    "/reservations/*/invoice/pdf": ["./node_modules/pdfmake/fonts/**"],
    "/shipments/*/pdf": ["./node_modules/pdfmake/fonts/**"],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "6mb",
    },
  },
};

export default nextConfig;
