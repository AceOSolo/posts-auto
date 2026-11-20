/**
 * Demandes de post traitées dans l'heure (IDE-06), toutes les 5 minutes (section 8.4).
 *
 * Pour chaque compte de la demande : post rédigé et vérifié par l'IA, photos de la
 * demande dans l'ordre choisi, créneau souhaité s'il est libre, sinon le prochain ;
 * statut « à valider ». Le demandeur suit l'avancement (IDE-06).
 *
 * Une demande est prise avec un bail : une passe interrompue est reprise quand il expire.
 * Les posts déjà rédigés pour une demande ne sont pas refaits (reprise après échec partiel).
 */
import { ModelError, PROMPT_VERSION, renderBrief, writePost } from '@posts-auto/ai';
import { addMinutes, firstFreeSlot, isSlotFree } from '@posts-auto/core';
import { asSystem, weekStartOf } from '@posts-auto/db';
import { allowanceForWorkspace, currentEditorialLine, offerItems } from '@posts-auto/services';
import { notify } from '../notifications/recipients.ts';
import { storeVisual } from '../visuals/prepare.ts';
import { openVisualSession, photoPlan, tryPrepareVisual } from '../visuals/session.ts';
import { loadAccounts, loadOccupied, loadOtherPosts, loadSettings } from './load.ts';
import { accountContext, insertGeneratedPost, recordUsage, slotLabel } from './store.ts';
import type { GenerationDeps } from './weekly.ts';

export const REQUEST_LEASE_MINUTES = 30;
export const REQUEST_MAX_ATTEMPTS = 3;
/** Le post laisse au moins une heure au titulaire pour valider. */
export const REQUEST_LEAD_MINUTES = 60;
/** Délai minimal d'un créneau choisi (RÈG-04). */
const MANUAL_LEAD_MINUTES = 15;
const SEARCH_DAYS = 14;
const BATCH = 5;

export interface RequestTickReport {
  readonly done: readonly string[];
  readonly impossible: readonly string[];
  readonly retrying: readonly string[];
}

export async function runRequestTick(deps: GenerationDeps): Promise<RequestTickReport> {
  const { db } = deps;
  const clock = deps.clock ?? (() => new Date());
  const now = clock();

  const claimed = await asSystem(db, async (trx) => {
    const rows = await trx
      .selectFrom('post_requests')
      .select(['id'])
      .where((eb) => eb.or([eb('status', '=', 'new'), eb.and([eb('status', '=', 'in_progress'), eb('lease_until', '<', now)])]))
      .orderBy('created_at')
      .limit(BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await trx
        .updateTable('post_requests')
        .set((eb) => ({ status: 'in_progress', lease_until: addMinutes(now, REQUEST_LEASE_MINUTES), attempts: eb('attempts', '+', 1) }))
        .where('id', 'in', ids)
        .execute();
    }
    return ids;
  });

  const report = { done: [] as string[], impossible: [] as string[], retrying: [] as string[] };
  for (const requestId of claimed) {
    const outcome = await processRequest(deps, requestId, clock);
    report[outcome].push(requestId);
  }
  return report;
}

type Outcome = 'done' | 'impossible' | 'retrying';

async function processRequest(deps: GenerationDeps, requestId: string, clock: () => Date): Promise<Outcome> {
  const { db, model } = deps;
  const now = clock();
  const request = await asSystem(db, async (trx) => {
    const r = await trx
      .selectFrom('post_requests as r')
      .leftJoin('users as u', 'u.id', 'r.created_by')
      .select(['r.id', 'r.workspace_id', 'r.raw_text', 'r.title', 'r.details', 'r.links', 'r.wished_at', 'r.attempts', 'r.created_by', 'r.requester_label', 'u.full_name', 'u.email'])
      .where('r.id', '=', requestId)
      .executeTakeFirstOrThrow();
    const accountIds = (await trx.selectFrom('request_accounts').select('account_id').where('request_id', '=', requestId).execute()).map((a) => a.account_id);
    const photos = await trx.selectFrom('request_photos').select('asset_id').where('request_id', '=', requestId).orderBy('position').execute();
    const existing = await trx.selectFrom('posts').select(['account_id', 'scheduled_at']).where('request_id', '=', requestId).where('status', '<>', 'remplace').execute();
    return { ...r, accountIds, photos: photos.map((p) => p.asset_id), existing };
  });
  const workspaceId = request.workspace_id;
  // Demande reprise de l'ancien outil : le demandeur peut n'avoir qu'un nom.
  const author = request.full_name ?? request.email ?? request.requester_label ?? 'un membre de l’équipe';

  const finish = async (status: 'done' | 'impossible', followup: string, lastError: string | null) => {
    await asSystem(db, async (trx) => {
      await trx
        .updateTable('post_requests')
        .set({ status, followup, last_error: lastError, lease_until: null, processed_at: clock() })
        .where('id', '=', requestId)
        .execute();
      if (request.created_by !== null) await notify(trx, [request.created_by], workspaceId, 'demande_traitee', { workspaceId, requestId, impossible: status === 'impossible' }, ['in_app']);
    });
  };

  const settings = await asSystem(db, (trx) => loadSettings(trx, workspaceId));
  const accounts = await asSystem(db, (trx) => loadAccounts(trx, workspaceId, now, request.accountIds));
  if (accounts.length === 0) {
    await finish('impossible', 'Aucun des comptes choisis n’est connecté : la demande ne peut pas être rédigée.', null);
    return 'impossible';
  }

  const text = [request.raw_text, request.details].filter((t): t is string => t !== null && t.trim() !== '').join('\n\n');
  const subject = (request.title ?? text.split(/\r?\n/)[0] ?? 'Demande de post').trim().slice(0, 160);
  const editorial = await asSystem(db, (trx) => currentEditorialLine(trx, workspaceId));
  const offer = await asSystem(db, (trx) => offerItems(trx, workspaceId));
  const otherPosts = await asSystem(db, (trx) => loadOtherPosts(trx, workspaceId, now));
  const followups: string[] = request.existing.map((p) => `Post déjà rédigé pour le ${slotLabel(p.scheduled_at, settings.calendar.timeZone)}.`);

  const run = await asSystem(db, (trx) =>
    trx
      .insertInto('generation_runs')
      .values({ workspace_id: workspaceId, kind: 'request', status: 'running', lease_until: addMinutes(now, REQUEST_LEASE_MINUTES), started_at: now, model: model.model, prompt_version: PROMPT_VERSION })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  const reportPosts: Record<string, unknown>[] = [];
  let trialBlocked = false;
  // Les photos de la demande font le visuel ; sans photo, un visuel est préparé (1c).
  const visuals = request.photos.length > 0 ? null : await openVisualSession(deps, workspaceId, accounts.map((a) => a.profile.accountId), now);
  try {
    for (const account of accounts) {
      const accountId = account.profile.accountId;
      if (request.existing.some((p) => p.account_id === accountId)) continue;
      // ONB-06, FAC-04, FAC-06 : essai, quota de la période, impayé.
      const allowance = await asSystem(db, (trx) => allowanceForWorkspace(trx, workspaceId, now));
      if (allowance.posts.remaining === 0) {
        trialBlocked = true;
        followups.push(`${account.profile.displayName ?? 'Compte'} : ${allowance.reason ?? allowance.limitReason}`);
        continue;
      }
      // Créneau : celui souhaité s'il est libre, sinon le prochain créneau libre (IDE-06).
      const occupied = await asSystem(db, (trx) => loadOccupied(trx, workspaceId, now, addMinutes(now, SEARCH_DAYS * 24 * 60)));
      const context = { calendar: settings.calendar, rules: settings.slotRules, occupied };
      const wished = request.wished_at;
      const earliest = addMinutes(now, REQUEST_LEAD_MINUTES);
      let at: Date | null = null;
      let wishedKept = false;
      if (wished !== null && wished.getTime() >= addMinutes(now, MANUAL_LEAD_MINUTES).getTime() && isSlotFree(wished, accountId, context)) {
        at = wished;
        wishedKept = true;
      } else {
        const from = wished !== null && wished.getTime() > earliest.getTime() ? wished : earliest;
        at = firstFreeSlot(accountId, from, addMinutes(from, SEARCH_DAYS * 24 * 60), context);
      }
      const name = account.profile.displayName ?? 'le compte';
      if (at === null) {
        followups.push(`Aucun créneau libre sur 2 semaines pour ${name}.`);
        continue;
      }
      const label = slotLabel(at, settings.calendar.timeZone);
      const brief = {
        scheduledAtLabel: label,
        originLabel: `demande ponctuelle de ${author}`,
        subject,
        documents: [{ type: 'demande' as const, id: `demande-${requestId.slice(0, 8)}`, content: text }],
        links: request.links,
        otherAccountsOnSubject: accounts.filter((a) => a !== account).map((a) => a.profile.displayName ?? 'Compte'),
      };
      const outcome = await writePost(model, {
        context: accountContext(settings.name, editorial, editorial.rules, offer, account),
        task: renderBrief(brief),
        purpose: 'write',
        rules: editorial.rules,
        bannedPhrases: editorial.bannedPhrases,
        externalContents: [text],
        otherPosts,
      });
      const visual =
        visuals === null
          ? null
          : await tryPrepareVisual(visuals, {
              accountId,
              postText: outcome.body,
              summary: subject,
              withPhoto: photoPlan(visuals, [{ accountId, at: at as Date }]).values().next().value ?? false,
            });
      const postId = await asSystem(db, async (trx) => {
        const id = await insertGeneratedPost(
          trx,
          {
            workspaceId,
            accountId,
            weekStart: weekStartOf(at as Date, settings.calendar),
            at: at as Date,
            mustPublishBy: null,
            isOptional: false,
            origin: 'request',
            source: { requestId },
            runId: run.id,
            body: outcome.body,
            summary: subject,
            reason: `Rédigé par l’IA (demande de ${author})`,
          },
          clock(),
        );
        for (const [index, assetId] of request.photos.entries()) {
          await trx.insertInto('post_media').values({ workspace_id: workspaceId, post_id: id, asset_id: assetId, position: index + 1 }).execute();
        }
        await recordUsage(trx, { workspaceId, accountId, runId: run.id, postId: id, calls: outcome.calls, usdToEur: deps.usdToEur ?? 0.86, countsInQuota: true }, clock());
        if (visual?.prepared) await storeVisual(trx, visual.prepared, { workspaceId, accountId, postId: id, runId: run.id, usdToEur: deps.usdToEur ?? 0.86 }, clock());
        const people = [account.holderUserId, ...(await trx.selectFrom('account_delegates').select('user_id').where('account_id', '=', accountId).execute()).map((d) => d.user_id)];
        await notify(trx, [...new Set(people.filter((p): p is string => p !== null))], workspaceId, 'posts_prets', { workspaceId, count: 1 }, ['in_app']);
        return id;
      });
      otherPosts.push({ postId, text: outcome.body });
      followups.push(`Post rédigé pour ${name}, ${label}${wished !== null && !wishedKept ? ' (le créneau souhaité était pris : prochain créneau libre)' : ''}. Il attend la validation de son titulaire.`);
      reportPosts.push({
        postId,
        accountId,
        at: at.toISOString(),
        remaining: outcome.report.remaining,
        suspiciousInstructions: outcome.report.suspiciousInstructions,
        ...(visual !== null && { visual: visual.summary }),
      });
    }
    await asSystem(db, (trx) =>
      trx.updateTable('generation_runs').set({ status: 'done', finished_at: clock(), lease_until: null, report: JSON.stringify({ requestId, posts: reportPosts }) }).where('id', '=', run.id).execute(),
    );
    // Rien n'a pu être rédigé à cause de l'essai : la demande ne peut pas aboutir pour l'instant.
    if (trialBlocked && reportPosts.length === 0) {
      await finish('impossible', followups.join(' '), null);
      return 'impossible';
    }
    await finish('done', followups.join(' '), null);
    return 'done';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await asSystem(db, (trx) => trx.updateTable('generation_runs').set({ status: 'failed', finished_at: clock(), lease_until: null, error: message, report: JSON.stringify({ requestId, posts: reportPosts }) }).where('id', '=', run.id).execute());
    const retryable = error instanceof ModelError ? error.retryable : true;
    if (retryable && request.attempts < REQUEST_MAX_ATTEMPTS) {
      await asSystem(db, (trx) => trx.updateTable('post_requests').set({ status: 'new', lease_until: null, last_error: message }).where('id', '=', requestId).execute());
      return 'retrying';
    }
    await finish('impossible', `La rédaction n’a pas abouti (${message}). L’équipe de rédaction peut reprendre la demande à la main.`, message);
    return 'impossible';
  }
}
