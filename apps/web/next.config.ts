import type { NextConfig } from 'next';

const config: NextConfig = {
  // Les paquets du dépôt sont publiés en TypeScript source : Next.js les compile.
  transpilePackages: ['@posts-auto/ai', '@posts-auto/core', '@posts-auto/db', '@posts-auto/services', '@posts-auto/worker', '@posts-auto/linkedin'],
  // Pilote PostgreSQL : chargé tel quel côté serveur, jamais empaqueté.
  serverExternalPackages: ['pg'],
  poweredByHeader: false,
  // Ajout de photos depuis le téléphone (REC-11) : plusieurs images de 10 Mo au plus chacune.
  experimental: { serverActions: { bodySizeLimit: '25mb' } },
  // SEC-06 : en-têtes de sécurité sur toutes les pages.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          // Micro autorisé pour le site lui-même seulement : dictée des demandes (IDE-05).
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default config;
