/**
 * VIS-10 : carrousel LinkedIn natif. À partir du visuel d'un post (titre et points clés),
 * un document PDF est composé : une page de couverture puis une page par point, rendues avec
 * le modèle « Citation » aux couleurs de l'espace. Le PDF remplace les images du post et
 * part par l'API Documents de LinkedIn. « Refaire le visuel » revient à une image.
 */
import { randomUUID } from 'node:crypto';
import { type Database, asSystem, asUser } from '@posts-auto/db';
import { galleryTemplates, renderTemplate } from '@posts-auto/visuals';
import { PDFDocument } from 'pdf-lib';
import { canEditPost, loadAccess } from '../access.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { loadBranding } from './branding.ts';

export const CAROUSEL_MAX_PAGES = 10;

export interface CarouselMedia {
  read(storageKey: string): Promise<Uint8Array>;
  write(storageKey: string, bytes: Uint8Array): Promise<void>;
}

/** Pages du carrousel : couverture, puis un point par page (au plus 9). */
export function carouselPages(content: { readonly title: string; readonly subtitle: string | null; readonly bullets: readonly string[]; readonly signature: string }) {
  const bullets = content.bullets.slice(0, CAROUSEL_MAX_PAGES - 1);
  return [
    { title: content.title, subtitle: content.subtitle ?? content.signature },
    ...bullets.map((bullet, i) => ({ title: bullet, subtitle: `${i + 1} / ${bullets.length}` })),
  ];
}

export async function makeCarousel(db: Database, media: CarouselMedia, userId: string, postId: string, now: Date): Promise<string> {
  const post = await asUser(db, userId, async (trx) => {
    const row = await trx.selectFrom('posts').select(['workspace_id', 'account_id', 'status']).where('id', '=', postId).executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Post');
    if (!canEditPost(await loadAccess(trx, userId, row.workspace_id, row.account_id))) throw new ForbiddenError('carousel');
    if (!['brouillon', 'a_valider', 'modif', 'valide'].includes(row.status)) throw new RefusedError('post_parti', 'Ce post est déjà publié ou en cours de publication.');
    return row;
  });
  const visual = await asSystem(db, (trx) =>
    trx
      .selectFrom('post_media as pm')
      .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
      .select(['m.render_content'])
      .where('pm.post_id', '=', postId)
      .where('m.kind', '=', 'rendered')
      .where('m.mime', '<>', 'application/pdf')
      .orderBy('pm.position')
      .executeTakeFirst(),
  );
  const content = visual?.render_content as { title?: string; subtitle?: string | null; bullets?: string[]; signature?: string } | null | undefined;
  if (!content?.title || (content.bullets ?? []).length < 2) throw new RefusedError('carrousel_impossible', 'Le carrousel se fait à partir d’un visuel avec au moins deux points clés.');
  const title = content.title;
  const branding = await asSystem(db, (trx) => loadBranding(trx, post.workspace_id));
  const template = galleryTemplates(branding).find((t) => t.key === 'citation') ?? galleryTemplates(branding)[0];
  if (template === undefined) throw new RefusedError('carrousel_impossible', 'Aucun modèle pour le carrousel.');
  let logo: Uint8Array | null = null;
  if (branding.logoAssetId !== null) {
    const asset = await asSystem(db, (trx) => trx.selectFrom('media_assets').select('storage_key').where('id', '=', branding.logoAssetId as string).executeTakeFirst());
    if (asset !== undefined) logo = await media.read(asset.storage_key).catch(() => null);
  }
  const pdf = await PDFDocument.create();
  pdf.setTitle(content.title);
  pdf.setProducer('Rostra');
  for (const page of carouselPages({ title: content.title, subtitle: content.subtitle ?? null, bullets: content.bullets ?? [], signature: content.signature ?? '' })) {
    const rendered = await renderTemplate(template.definition, { title: page.title, subtitle: page.subtitle, logo });
    const image = await pdf.embedPng(rendered.png);
    pdf.addPage([rendered.width, rendered.height]).drawImage(image, { x: 0, y: 0, width: rendered.width, height: rendered.height });
  }
  const bytes = await pdf.save();
  if (bytes.length > 10 * 1024 * 1024) throw new RefusedError('carrousel_trop_lourd', 'Le carrousel dépasse 10 Mo.');
  const assetId = randomUUID();
  const storageKey = `${post.workspace_id}/visuels/${assetId}.pdf`;
  await media.write(storageKey, bytes);
  await asSystem(db, async (trx) => {
    await trx
      .insertInto('media_assets')
      .values({ id: assetId, workspace_id: post.workspace_id, kind: 'rendered', storage_key: storageKey, mime: 'application/pdf', bytes: bytes.length, label: 'Carrousel', uploaded_by: userId, created_at: now })
      .execute();
    await trx.deleteFrom('post_media').where('post_id', '=', postId).execute();
    await trx.insertInto('post_media').values({ workspace_id: post.workspace_id, post_id: postId, asset_id: assetId, position: 1, alt_text: title.slice(0, 200) }).execute();
    const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', post.workspace_id).executeTakeFirstOrThrow();
    await trx
      .insertInto('audit_log')
      .values({ org_id: ws.org_id, workspace_id: post.workspace_id, actor_user_id: userId, actor_kind: 'user', action: 'post.carrousel', entity: 'post', entity_id: postId, details: JSON.stringify({ pages: (content.bullets ?? []).length + 1 }), at: now })
      .execute();
  });
  return assetId;
}
