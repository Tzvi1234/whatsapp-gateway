import path from 'node:path';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

/**
 * Note: env vars are NOT read here (only `src/server/env.ts` reads `process.env`), so the
 * build works without them. The CSP allows Supabase (REST + Realtime) on *.supabase.co and
 * Cloudflare Turnstile; everything else is same-origin.
 */

const WORKSPACE_PACKAGES = [
  '@htz/core',
  '@htz/policy',
  '@htz/relay',
  '@htz/automations',
  '@htz/mcp',
  '@htz/provider-cloud',
];

function csp(dev: boolean): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      "'unsafe-inline'",
      ...(dev ? ["'unsafe-eval'"] : []),
      'https://challenges.cloudflare.com',
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': [
      "'self'",
      'https://*.supabase.co',
      'wss://*.supabase.co',
      ...(dev ? ['http://127.0.0.1:54321', 'ws://127.0.0.1:54321', 'ws://localhost:*'] : []),
    ],
    'frame-src': ['https://challenges.cloudflare.com'],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'object-src': ["'none'"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`);
  if (!dev) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

export default function config(phase: string): NextConfig {
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  const securityHeaders = [
    { key: 'Content-Security-Policy', value: csp(dev) },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    ...(dev
      ? []
      : [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ]),
  ];

  return {
    poweredByHeader: false,
    reactStrictMode: true,
    transpilePackages: WORKSPACE_PACKAGES,
    // Monorepo root (pnpm workspace) for file tracing and Turbopack resolution.
    outputFileTracingRoot: path.resolve(process.cwd(), '../..'),
    turbopack: { root: path.resolve(process.cwd(), '../..') },
    async headers() {
      return [
        { source: '/:path*', headers: securityHeaders },
        {
          // Owner/dashboard pages, server actions and APIs are never cached (C2: QR no-store).
          source: '/((?!_next/static|_next/image|favicon.ico).*)',
          headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
        },
      ];
    },
  };
}
