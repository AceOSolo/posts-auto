/**
 * GET  /api/v1/posts?depuis=…&jusqua=… : posts de l'espace et décisions des titulaires.
 * POST /api/v1/posts : dépôt d'un post « à valider » ou d'une reprise (PUB-10).
 */
import { POST_ORIGINS, type PostOrigin } from '@posts-auto/core';
import { type SubmittedImage, listPosts, submitPost } from '@posts-auto/services';
import { apiError, parseInstant, withApiKey } from '../../../../server/api.ts';
import { database, mediaStore } from '../../../../server/context.ts';

export const dynamic = 'force-dynamic';

/** 9 images de 10 Mo encodées en base64 dépasseraient largement ce plafond : 50 Mo par requête. */
const MAX_BODY_BYTES = 50 * 1024 * 1024;

export function GET(request: Request) {
  return withApiKey(request, async (ctx) => {
    const params = new URL(request.url).searchParams;
    const now = new Date();
    const from = params.has('depuis') ? parseInstant(params.get('depuis')) : new Date(now.getTime() - 7 * 86_400_000);
    const to = params.has('jusqua') ? parseInstant(params.get('jusqua')) : new Date(now.getTime() + 14 * 86_400_000);
    if (from === null || to === null) return apiError(400, 'date_invalide', 'depuis et jusqua : dates ISO 8601 avec fuseau (ex. 2026-11-16T00:00:00Z).');
    return Response.json({ posts: await listPosts(database(), ctx, { from, to }) });
  });
}

interface ImagePayload {
  donnees_base64?: unknown;
  type?: unknown;
  texte_alternatif?: unknown;
  generee_par_ia?: unknown;
}

export function POST(request: Request) {
  return withApiKey(request, async (ctx) => {
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'requete_trop_grosse', 'Requête de plus de 50 Mo.');
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return apiError(400, 'json_invalide', 'Le corps de la requête doit être un objet JSON.');
    }

    const scheduledAt = parseInstant(body['creneau']);
    if (scheduledAt === null) return apiError(400, 'creneau_invalide', 'creneau : date ISO 8601 avec fuseau, obligatoire.');
    const mustPublishBy = body['date_limite'] === undefined ? undefined : parseInstant(body['date_limite']);
    if (mustPublishBy === null) return apiError(400, 'date_limite_invalide', 'date_limite : date ISO 8601 avec fuseau.');
    const origin = body['origine'] ?? 'planning';
    if (typeof origin !== 'string' || !(POST_ORIGINS as readonly string[]).includes(origin)) {
      return apiError(400, 'origine_invalide', `origine : une valeur parmi ${POST_ORIGINS.join(', ')}.`);
    }
    for (const field of ['reference', 'compte', 'texte'] as const) {
      if (typeof body[field] !== 'string') return apiError(400, `${field}_manquant`, `${field} : texte obligatoire.`);
    }
    const rawImages = body['images'] ?? [];
    if (!Array.isArray(rawImages)) return apiError(400, 'images_invalides', 'images : liste attendue.');
    const images: SubmittedImage[] = [];
    for (const [index, raw] of (rawImages as ImagePayload[]).entries()) {
      if (typeof raw?.donnees_base64 !== 'string') return apiError(400, 'images_invalides', `images[${index}].donnees_base64 : texte base64 obligatoire.`);
      images.push({
        bytes: new Uint8Array(Buffer.from(raw.donnees_base64, 'base64')),
        ...(typeof raw.type === 'string' ? { mime: raw.type } : {}),
        ...(typeof raw.texte_alternatif === 'string' ? { altText: raw.texte_alternatif } : {}),
        aiGenerated: raw.generee_par_ia === true,
      });
    }

    const result = await submitPost(
      database(),
      ctx,
      mediaStore(),
      {
        reference: body['reference'] as string,
        accountId: body['compte'] as string,
        scheduledAt,
        text: (body['texte'] as string).replace(/\r\n/g, '\n'),
        origin: origin as PostOrigin,
        ...(typeof body['note_source'] === 'string' ? { sourceNote: body['note_source'] } : {}),
        ...(mustPublishBy === undefined ? {} : { mustPublishBy }),
        ...(typeof body['remplace'] === 'string' ? { replaces: body['remplace'] } : {}),
        images,
      },
      new Date(),
    );
    return Response.json({ cree: result.created, post: result.post }, { status: result.created ? 201 : 200 });
  });
}
