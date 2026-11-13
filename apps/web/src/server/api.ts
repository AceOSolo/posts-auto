/**
 * Outils communs de l'API d'échange (/api/v1) : authentification par clé, erreurs au format
 * JSON stable { erreur: { code, message } }, traduction des erreurs métier en statuts HTTP.
 */
import { type ApiKeyContext, ForbiddenError, NotFoundError, RefusedError, authenticateApiKey } from '@posts-auto/services';
import { database } from './context.ts';

export function apiError(status: number, code: string, message: string): Response {
  return Response.json({ erreur: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Codes métier qui signalent un conflit avec l'état actuel (409) plutôt qu'une saisie invalide (422). */
const CONFLICT_CODES = new Set([
  'same_account_same_slot',
  'account_daily_cap',
  'workspace_min_gap',
  'workspace_slot_cap',
  'not_replaceable',
  'too_many_reworks',
]);

export async function withApiKey(request: Request, handler: (ctx: ApiKeyContext) => Promise<Response>): Promise<Response> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const ctx = match ? await authenticateApiKey(database(), match[1] as string, new Date()) : null;
  if (ctx === null) return apiError(401, 'cle_invalide', 'Clé d’API absente, invalide ou révoquée.');
  try {
    return await handler(ctx);
  } catch (error) {
    if (error instanceof ForbiddenError) return apiError(403, 'droit_insuffisant', `Cette clé n’a pas le droit « ${error.action} ».`);
    if (error instanceof NotFoundError) return apiError(404, 'introuvable', error.message);
    if (error instanceof RefusedError) return apiError(CONFLICT_CODES.has(error.code) ? 409 : 422, error.code, error.message);
    console.error('[api] erreur inattendue', error);
    return apiError(500, 'erreur_interne', 'Erreur inattendue. Réessayez plus tard.');
  }
}

export function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
