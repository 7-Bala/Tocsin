/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // The root dashboard (app/page.tsx) was removed -- /voice-test is now the
  // only page. Redirect rather than 404 so the bare site URL still resolves
  // to something.
  async redirects() {
    return [
      {
        source: '/',
        destination: '/voice-test',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
