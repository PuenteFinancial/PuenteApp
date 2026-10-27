import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  async headers() {
    // /ai is unlisted: keep the page and its assets (logos, scripts) out of search and image indexes
    const noindex = [{ key: 'X-Robots-Tag', value: 'noindex, nofollow, noimageindex' }]
    return [
      { source: '/ai', headers: noindex },
      { source: '/ai/:path*', headers: noindex },
    ]
  },
  async rewrites() {
    return [
      // /ai is a static page (public/ai/index.html) with its own nav and footer.
      // Route matching is case-insensitive, so this also serves /AI.
      { source: '/ai', destination: '/ai/index.html' },
      {
        source: '/ingest/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/ingest/array/:path*',
        destination: 'https://us-assets.i.posthog.com/array/:path*',
      },
      {
        source: '/ingest/:path*',
        destination: 'https://us.i.posthog.com/:path*',
      },
    ]
  },
  skipTrailingSlashRedirect: true,
}

export default nextConfig
