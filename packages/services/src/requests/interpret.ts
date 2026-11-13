/**
 * IDE-04 : l'IA pré-remplit le formulaire de demande à partir du texte libre (ou dicté).
 * La personne vérifie les champs avant d'envoyer : rien n'est enregistré ici, hormis le coût
 * de l'appel (GEN-11) et une trace qui sert à limiter la fréquence.
 */
import { type Interpretation, type TextModel, costUsd, interpretRequest } from '@posts-auto/ai';
import { type Database, asSystem, asUser } from '@posts-auto/db';
import { canPropose, workspaceRole } from '../access.ts';
import { audit, cleanText } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';

/** Au plus 20 pré-remplissages par personne et par heure : chaque clic coûte un appel à l'IA. */
export const INTERPRET_MAX_PER_HOUR = 20;

const DAY_OPTIONS: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };

export async function interpretPostRequest(
  db: Database,
  model: TextModel,
  userId: string,
  workspaceId: string,
  rawText: string,
  now: Date,
  usdToEur = 0.86,
): Promise<Interpretation> {
  const text = cleanText(rawText, 5000);
  if (text === null) throw new RefusedError('demande_vide', 'Décrivez d’abord le post souhaité.');
  const { accounts, timeZone } = await asUser(db, userId, async (trx) => {
    const role = await workspaceRole(trx, userId, workspaceId);
    if (role === null) throw new NotFoundError('Espace');
    if (!canPropose(role)) throw new ForbiddenError('requestPost');
    const recent = await trx
      .selectFrom('audit_log')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', workspaceId)
      .where('actor_user_id', '=', userId)
      .where('action', '=', 'demande.interpretee')
      .where('at', '>', new Date(now.getTime() - 3_600_000))
      .executeTakeFirstOrThrow();
    if (Number(recent.n) >= INTERPRET_MAX_PER_HOUR) throw new RefusedError('trop_de_preremplissages', 'Trop de pré-remplissages : réessayez dans une heure.');
    await audit(trx, { workspaceId, actorUserId: userId, action: 'demande.interpretee', entity: 'workspace', entityId: workspaceId, details: {}, at: now });
    const rows = await trx.selectFrom('social_accounts').select(['id', 'display_name']).where('workspace_id', '=', workspaceId).where('status', '<>', 'revoked').execute();
    const ws = await trx.selectFrom('workspaces').select('timezone').where('id', '=', workspaceId).executeTakeFirstOrThrow();
    return { accounts: rows.map((r) => ({ id: r.id, name: r.display_name ?? 'Compte' })), timeZone: ws.timezone };
  });
  const today = `${new Intl.DateTimeFormat('fr-FR', { ...DAY_OPTIONS, timeZone }).format(now)} (${new Intl.DateTimeFormat('en-CA', { timeZone }).format(now)})`;
  const { interpretation, call } = await interpretRequest(model, { rawText: text, accounts, today });
  const usd = costUsd(call.model, call.usage);
  await asSystem(db, (trx) =>
    trx
      .insertInto('ai_usage')
      .values({
        workspace_id: workspaceId,
        provider: call.provider,
        model: call.model,
        purpose: 'interpret',
        kind: 'text',
        input_tokens: call.usage.inputTokens,
        output_tokens: call.usage.outputTokens,
        cache_read_tokens: call.usage.cacheReadTokens,
        cache_write_tokens: call.usage.cacheWriteTokens,
        cost_usd: usd.toFixed(6),
        cost_eur: (usd * usdToEur).toFixed(6),
        counted_in_quota: false,
        at: now,
      })
      .execute(),
  );
  return interpretation;
}
