/** Static export: the site is served as static assets by the signa-api Worker (same origin as the API). */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};
export default nextConfig;
