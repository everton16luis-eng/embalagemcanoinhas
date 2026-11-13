import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4010';

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  // O navegador fala so com esta origem; a API fica atras do proxy.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...(process.env.NODE_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
        ],
      },
      // O painel nunca abre dentro de outro site.
      { source: '/painel/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] },
    ];
  },
};

export default config;
