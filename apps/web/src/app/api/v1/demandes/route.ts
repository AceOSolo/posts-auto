/**
 * POST /api/v1/demandes : reprise d'une demande de post de l'outil actuel (incrément 1b).
 * Idempotent : la même référence renvoie la demande déjà reprise (200), sans doublon.
 * Une demande « nouvelle » sera rédigée par l'application dans l'heure (IDE-06).
 */
import { IMPORTED_REQUEST_STATUSES, importPostRequest } from '@posts-auto/services';
import { apiError, parseInstant, withApiKey } from '../../../../server/api.ts';
import { database } from '../../../../server/context.ts';

export const dynamic = 'force-dynamic';

const optionalText = (value: unknown) => (typeof value === 'string' ? value : undefined);

export function POST(request: Request) {
  return withApiKey(request, async (ctx) => {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return apiError(400, 'json_invalide', 'Le corps de la requête doit être un objet JSON.');
    }
    for (const field of ['reference', 'texte'] as const) {
      if (typeof body[field] !== 'string') return apiError(400, `${field}_manquant`, `${field} : texte obligatoire.`);
    }
    const accounts = body['comptes'];
    if (!Array.isArray(accounts) || accounts.some((id) => typeof id !== 'string')) return apiError(400, 'comptes_invalides', 'comptes : liste d’identifiants, obligatoire.');
    const links = body['liens'] ?? [];
    if (!Array.isArray(links) || links.some((l) => typeof l !== 'string')) return apiError(400, 'liens_invalides', 'liens : liste d’adresses.');
    const status = body['statut'];
    if (status !== undefined && !(typeof status === 'string' && status in IMPORTED_REQUEST_STATUSES)) {
      return apiError(400, 'statut_invalide', `statut : ${Object.keys(IMPORTED_REQUEST_STATUSES).join(', ')}.`);
    }
    const wishedAt = body['souhaite_le'] === undefined ? undefined : parseInstant(body['souhaite_le']);
    const createdAt = body['cree_le'] === undefined ? undefined : parseInstant(body['cree_le']);
    if (wishedAt === null || createdAt === null) return apiError(400, 'date_invalide', 'souhaite_le, cree_le : dates ISO 8601 avec fuseau.');
    const result = await importPostRequest(
      database(),
      ctx,
      {
        reference: body['reference'] as string,
        text: body['texte'] as string,
        accountIds: accounts as string[],
        links: links as string[],
        ...(optionalText(body['demandeur_email']) !== undefined && { requesterEmail: optionalText(body['demandeur_email']) as string }),
        ...(optionalText(body['demandeur_nom']) !== undefined && { requesterName: optionalText(body['demandeur_nom']) as string }),
        ...(optionalText(body['suivi']) !== undefined && { followup: optionalText(body['suivi']) as string }),
        ...(status !== undefined && { status: status as keyof typeof IMPORTED_REQUEST_STATUSES }),
        ...(wishedAt !== undefined && { wishedAt }),
        ...(createdAt !== undefined && { createdAt }),
      },
      new Date(),
    );
    return Response.json({ cree: result.created, demande: { id: result.id, reference: body['reference'] } }, { status: result.created ? 201 : 200 });
  });
}
