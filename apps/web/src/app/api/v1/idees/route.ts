/**
 * POST /api/v1/idees : reprise d'une idée de l'outil actuel (incrément 1b).
 * Idempotent : la même référence renvoie l'idée déjà reprise (200), sans doublon.
 */
import { IMPORTED_IDEA_STATUSES, importIdea } from '@posts-auto/services';
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
    for (const field of ['reference', 'titre'] as const) {
      if (typeof body[field] !== 'string') return apiError(400, `${field}_manquant`, `${field} : texte obligatoire.`);
    }
    const accounts = body['comptes'] ?? [];
    if (!Array.isArray(accounts) || accounts.some((id) => typeof id !== 'string')) return apiError(400, 'comptes_invalides', 'comptes : liste d’identifiants.');
    const status = body['statut'];
    if (status !== undefined && !(typeof status === 'string' && status in IMPORTED_IDEA_STATUSES)) {
      return apiError(400, 'statut_invalide', `statut : ${Object.keys(IMPORTED_IDEA_STATUSES).join(', ')}.`);
    }
    const createdAt = body['cree_le'] === undefined ? undefined : parseInstant(body['cree_le']);
    if (createdAt === null) return apiError(400, 'date_invalide', 'cree_le : date ISO 8601 avec fuseau.');
    const result = await importIdea(database(), ctx, {
      reference: body['reference'] as string,
      title: body['titre'] as string,
      ...(optionalText(body['details']) !== undefined && { details: optionalText(body['details']) as string }),
      ...(optionalText(body['lien']) !== undefined && { link: optionalText(body['lien']) as string }),
      ...(optionalText(body['debut']) !== undefined && { startsOn: optionalText(body['debut']) as string }),
      ...(optionalText(body['fin']) !== undefined && { endsOn: optionalText(body['fin']) as string }),
      ...(optionalText(body['evenement']) !== undefined && { eventOn: optionalText(body['evenement']) as string }),
      ...(optionalText(body['suivi']) !== undefined && { followup: optionalText(body['suivi']) as string }),
      ...(status !== undefined && { status: status as keyof typeof IMPORTED_IDEA_STATUSES }),
      ...(createdAt !== undefined && { createdAt }),
      accountIds: accounts as string[],
    });
    return Response.json({ cree: result.created, idee: { id: result.id, reference: body['reference'] } }, { status: result.created ? 201 : 200 });
  });
}
