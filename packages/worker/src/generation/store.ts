/**
 * Dépôt d'un post rédigé par l'IA et enregistrement du coût (GEN-06, GEN-11), communs à la
 * rédaction hebdomadaire, aux demandes (IDE-06) et aux reprises (GEN-07).
 */
import { type UsageRecord, costUsd, renderAccountContext } from '@posts-auto/ai';
import type { EditorialRules, PostOrigin } from '@posts-auto/core';
import type { Tx } from '@posts-auto/db';
import type { EditorialLine, OfferItem } from '@posts-auto/services';
import type { AccountData } from './load.ts';

export interface PostSource {
  readonly planningCellId?: string;
  readonly subjectId?: string;
  readonly ideaId?: string;
  readonly eventId?: string;
  readonly requestId?: string;
}

export interface NewPost {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly weekStart: string;
  readonly at: Date;
  readonly mustPublishBy: Date | null;
  readonly isOptional: boolean;
  readonly origin: PostOrigin;
  readonly source: PostSource;
  readonly runId: string | null;
  readonly body: string;
  /** Sujet en une phrase (GEN-06) : affiché avec l'origine, et repris si le sujet part en réserve. */
  readonly summary: string;
  readonly replacesPostId?: string | null;
  readonly versionNo?: number;
  /** Ligne de l'historique des statuts. */
  readonly reason: string;
}

/** Crée le post « à valider », sa première révision (auteur : l'IA) et la ligne d'historique. */
export async function insertGeneratedPost(trx: Tx, post: NewPost, now: Date): Promise<string> {
  const row = await trx
    .insertInto('posts')
    .values({
      workspace_id: post.workspaceId,
      account_id: post.accountId,
      week_start: post.weekStart,
      scheduled_at: post.at,
      must_publish_by: post.mustPublishBy,
      is_optional: post.isOptional,
      status: 'a_valider',
      origin: post.origin,
      planning_cell_id: post.source.planningCellId ?? null,
      subject_id: post.source.subjectId ?? null,
      idea_id: post.source.ideaId ?? null,
      event_id: post.source.eventId ?? null,
      request_id: post.source.requestId ?? null,
      generation_run_id: post.runId,
      source_note: post.summary.slice(0, 300),
      replaces_post_id: post.replacesPostId ?? null,
      version_no: post.versionNo ?? 1,
      created_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const version = await trx
    .insertInto('post_versions')
    .values({ workspace_id: post.workspaceId, post_id: row.id, revision: 1, body: post.body, author_kind: 'ai', created_at: now })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx.updateTable('posts').set({ current_version_id: version.id }).where('id', '=', row.id).execute();
  await trx
    .insertInto('post_status_history')
    .values({ workspace_id: post.workspaceId, post_id: row.id, from_status: null, to_status: 'a_valider', actor_kind: 'system', reason: post.reason, at: now })
    .execute();
  return row.id;
}

/** GEN-11 : une ligne par appel. Seule la première rédaction d'un nouveau post compte dans le quota (RÈG-19). */
export async function recordUsage(
  trx: Tx,
  entry: {
    readonly workspaceId: string;
    readonly accountId: string | null;
    readonly runId: string | null;
    readonly postId: string | null;
    readonly calls: readonly UsageRecord[];
    readonly usdToEur: number;
    readonly countsInQuota: boolean;
  },
  now: Date,
): Promise<number> {
  let total = 0;
  const rows = entry.calls.map((call, index) => {
    const usd = costUsd(call.model, call.usage);
    total += usd;
    return {
      workspace_id: entry.workspaceId,
      account_id: entry.accountId,
      run_id: entry.runId,
      post_id: entry.postId,
      provider: call.provider,
      model: call.model,
      purpose: call.purpose,
      kind: 'text' as const,
      input_tokens: call.usage.inputTokens,
      output_tokens: call.usage.outputTokens,
      cache_read_tokens: call.usage.cacheReadTokens,
      cache_write_tokens: call.usage.cacheWriteTokens,
      cost_usd: usd.toFixed(6),
      cost_eur: (usd * entry.usdToEur).toFixed(6),
      counted_in_quota: entry.countsInQuota && index === 0 && call.purpose === 'write',
      at: now,
    };
  });
  if (rows.length > 0) await trx.insertInto('ai_usage').values(rows).execute();
  return total;
}

/** Contexte du compte pour l'IA (mis en cache pendant la génération). */
export function accountContext(
  workspaceName: string,
  editorial: EditorialLine,
  rules: EditorialRules,
  offer: readonly OfferItem[],
  account: AccountData,
): string {
  const p = account.profile;
  return renderAccountContext({
    workspaceName,
    editorial,
    rules,
    offer: offer.map((o) => ({ name: o.name, description: o.description, status: o.status, pricing: o.pricing })),
    account: { name: p.displayName ?? 'Compte', kind: p.kind, voice: p.voice, tenor: p.tenor, sensitivity: p.sensitivity, avoid: p.avoid },
    learnedPreferences: account.learned,
    examples: account.examples.map((e) => ({ label: e.label, body: e.body, note: e.note })),
    recentPosts: account.recent,
  });
}

const SLOT_FORMAT: Record<string, Intl.DateTimeFormat> = {};

/** « mardi 24 novembre à 12h00 », à l'heure de l'espace. */
export function slotLabel(at: Date, timeZone: string): string {
  SLOT_FORMAT[timeZone] ??= new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone });
  return (SLOT_FORMAT[timeZone] as Intl.DateTimeFormat).format(at).replace(/(\d{2}):(\d{2})/, '$1h$2');
}

/** « mardi 8 décembre » pour une date civile. */
export function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}
