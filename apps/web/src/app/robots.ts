/** SIT-06 : le site public est indexable ; l'application et l'API ne le sont pas. */
import type { MetadataRoute } from 'next';
import { appUrl } from '../server/context.ts';

export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: ['/', '/tarifs', '/pme-eti', '/agences', '/confiance', '/en', '/inscription', '/comment-fonctionne-la-redaction', '/mentions-legales', '/cgu', '/cgv', '/confidentialite', '/cookies', '/sous-traitants', '/llms.txt'], disallow: ['/api/', '/admin', '/media/', '/valider/', '/connexion/'] }],
    sitemap: `${appUrl()}/sitemap.xml`,
  };
}
