/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  experimental: { serverComponentsExternalPackages: ["better-sqlite3"] },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default config;
