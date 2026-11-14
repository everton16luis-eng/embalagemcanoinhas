import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4010';
const prod = process.env.NODE_ENV === 'production';

// CSP. O painel nao carrega nada de fora: politica fechada. A loja carrega o SDK oficial do Mercado Pago na
// pagina do pedido (cartao); ate conferir em sandbox quais dominios ele usa, a loja recebe so as diretivas que nao
// interferem nele (ver docs/AUDITORIA-2026-11.md). 'unsafe-inline' em script: o Next injeta scripts inline de
// hidratacao; tirar exige nonce por requisicao (renderizacao dinamica em tudo).
const baseCsp = ["object-src 'none'", "base-uri 'self'", "form-action 'self'"];
const panelCsp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  ...baseCsp,
].join('; ');
const storeCsp = ["frame-ancestors 'self'", ...baseCsp].join('; ');

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
      // A loja: so diretivas que nao afetam o SDK do Mercado Pago (a do painel, abaixo, substitui esta la).
      ...(prod ? [{ source: '/((?!painel).*)', headers: [{ key: 'Content-Security-Policy', value: storeCsp }] }] : []),
      // O painel nunca abre dentro de outro site.
      { source: '/painel/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }, ...(prod ? [{ key: 'Content-Security-Policy', value: panelCsp }] : [])] },    ];
  },
};

export default config;
