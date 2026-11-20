/** SIT-06 : plan du site public (le reste de l'application n'est pas indexé). */
import type { MetadataRoute } from 'next';
import { appUrl } from '../server/context.ts';

export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = appUrl();
  const pages = ['', '/en', '/inscription', '/comment-fonctionne-la-redaction', '/mentions-legales', '/cgu', '/cgv', '/confidentialite', '/cookies', '/sous-traitants'];
  return pages.map((path) => ({ url: `${base}${path || '/'}`, changeFrequency: path === '' ? 'weekly' : 'monthly', priority: path === '' ? 1 : 0.5 }));
}
