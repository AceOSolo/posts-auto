/** ADM-05 : aperçu d'un modèle de la galerie, avec la charte par défaut et des textes d'exemple. */
import { ForbiddenError, RefusedError, applyBrand, galleryCatalog, requirePlatformAdmin } from '@posts-auto/services';
import { asSystem } from '@posts-auto/db';
import { DEFAULT_BRAND, galleryTemplates, parseTemplate, renderTemplate, sampleContent } from '@posts-auto/visuals';
import { database } from '../../../../../server/context.ts';
import { currentUserId } from '../../../../../server/session.ts';

export const dynamic = 'force-dynamic';

const notFound = () => new Response('Introuvable', { status: 404 });

export async function GET(request: Request) {
  const userId = await currentUserId();
  if (userId === null) return notFound();
  try {
    await requirePlatformAdmin(database(), userId);
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof RefusedError) return notFound();
    throw error;
  }
  const key = new URL(request.url).searchParams.get('modele') ?? '';
  // Modèles intégrés, même retirés, et modèles ajoutés (y compris retirés).
  let definition = galleryTemplates(DEFAULT_BRAND).find((t) => t.key === key)?.definition;
  if (definition === undefined) {
    const active = (await asSystem(database(), (trx) => galleryCatalog(trx, DEFAULT_BRAND))).find((t) => t.key === key)?.definition;
    const stored = active ?? (await asSystem(database(), (trx) => trx.selectFrom('gallery_entries').select('definition').where('key', '=', key).executeTakeFirst()))?.definition;
    if (stored === undefined || stored === null) return notFound();
    try {
      definition = parseTemplate(applyBrand(stored, DEFAULT_BRAND));
    } catch {
      return notFound();
    }
  }
  const result = await renderTemplate(definition, await sampleContent({}));
  return new Response(new Uint8Array(result.png), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'" } });
}
