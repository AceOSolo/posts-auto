/**
 * Fiche d'un compte (EDI-04), exemples de référence (EDI-05) et préférences apprises
 * (EDI-06).
 *
 * Matrice 3.3 : le propriétaire, les administrateurs et les éditeurs modifient toute la
 * fiche ; le titulaire modifie sa propre fiche pour le ton et les sujets à éviter, et
 * gère ses exemples et ses préférences. Les validateurs délégués se règlent dans les
 * réglages de l'espace (ROL-01).
 */
import type { IsoWeekday, UsualSlot } from '@posts-auto/core';
import { type Database, type Tx, asUser } from '@posts-auto/db';
import { canManageContent, workspaceRole } from '../access.ts';
import { audit, cleanText } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';

export type Voice = 'je' | 'nous';
export type Sensitivity = 'standard' | 'prudent' | 'strict';
const SENSITIVITIES: readonly Sensitivity[] = ['standard', 'prudent', 'strict'];

export interface AccountProfile {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly displayName: string | null;
  readonly kind: 'profile' | 'page';
  readonly holderUserId: string | null;
  readonly voice: Voice | null;
  readonly tenor: string | null;
  readonly sensitivity: Sensitivity;
  readonly avoid: string | null;
  readonly postsPerWeek: number;
  readonly optionalPerWeek: number;
  readonly usualSlots: readonly UsualSlot[];
  /** VIS-04 : part des visuels avec photo (0 à 1). */
  readonly aiImageRatio: number;
}

/** VIS-04 : parts proposées pour les visuels avec photo. */
export const IMAGE_RATIOS: readonly { readonly value: number; readonly label: string }[] = [
  { value: 0, label: 'Jamais : visuels texte seulement' },
  { value: 0.25, label: 'Un visuel sur quatre' },
  { value: 0.5, label: 'Un visuel sur deux' },
  { value: 0.75, label: 'Trois visuels sur quatre' },
  { value: 1, label: 'Toujours' },
];

export interface ProfileRights {
  /** Toute la fiche (gestion du contenu). */
  readonly canEditAll: boolean;
  /** Ton et sujets à éviter (titulaire). */
  readonly canEditOwn: boolean;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Créneaux habituels saisis : jour ISO et heure HH:mm, sans doublon, triés. */
export function parseUsualSlots(raw: unknown): UsualSlot[] {
  if (!Array.isArray(raw)) return [];
  const slots = new Map<string, UsualSlot>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { weekday, time } = item as Record<string, unknown>;
    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) continue;
    if (typeof time !== 'string' || !TIME.test(time)) continue;
    slots.set(`${weekday}-${time}`, { weekday: weekday as IsoWeekday, time });
  }
  return [...slots.values()].sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time)).slice(0, 14);
}

async function loadProfile(trx: Tx, accountId: string): Promise<AccountProfile | null> {
  const row = await trx
    .selectFrom('social_accounts as a')
    .leftJoin('account_profiles as p', 'p.account_id', 'a.id')
    .select([
      'a.id',
      'a.workspace_id',
      'a.display_name',
      'a.kind',
      'a.holder_user_id',
      'p.voice',
      'p.tenor',
      'p.sensitivity',
      'p.avoid',
      'p.posts_per_week',
      'p.optional_per_week',
      'p.usual_slots',
      'p.ai_image_ratio',
    ])
    .where('a.id', '=', accountId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    accountId: row.id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    kind: row.kind as 'profile' | 'page',
    holderUserId: row.holder_user_id,
    voice: (row.voice as Voice | null) ?? null,
    tenor: row.tenor ?? null,
    sensitivity: (row.sensitivity as Sensitivity | null) ?? 'standard',
    avoid: row.avoid ?? null,
    postsPerWeek: row.posts_per_week ?? 1,
    optionalPerWeek: row.optional_per_week ?? 0,
    usualSlots: parseUsualSlots(row.usual_slots),
    aiImageRatio: row.ai_image_ratio === null ? 0.5 : Number(row.ai_image_ratio),
  };
}

/** Fiche lue par le code système (génération). */
export async function accountProfileForSystem(trx: Tx, accountId: string): Promise<AccountProfile | null> {
  return loadProfile(trx, accountId);
}

async function rightsOn(trx: Tx, userId: string, profile: AccountProfile): Promise<ProfileRights> {
  const role = await workspaceRole(trx, userId, profile.workspaceId);
  return { canEditAll: canManageContent(role), canEditOwn: profile.holderUserId === userId };
}

async function requireProfile(trx: Tx, userId: string, accountId: string): Promise<{ profile: AccountProfile; rights: ProfileRights }> {
  const profile = await loadProfile(trx, accountId);
  if (profile === null) throw new NotFoundError('Compte');
  return { profile, rights: await rightsOn(trx, userId, profile) };
}

export async function getAccountProfile(db: Database, userId: string, accountId: string): Promise<{ profile: AccountProfile; rights: ProfileRights }> {
  return asUser(db, userId, (trx) => requireProfile(trx, userId, accountId));
}

export interface AccountProfileInput {
  readonly voice?: Voice | null;
  readonly tenor?: string | null;
  readonly sensitivity?: Sensitivity;
  readonly avoid?: string | null;
  readonly postsPerWeek?: number;
  readonly optionalPerWeek?: number;
  readonly usualSlots?: readonly UsualSlot[];
  readonly aiImageRatio?: number;
}

const OWN_FIELDS: ReadonlySet<keyof AccountProfileInput> = new Set(['tenor', 'avoid']);

function count(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 14) throw new RefusedError(`${name}_invalide`, 'Indiquez un nombre de posts entre 0 et 14 par semaine.');
  return value;
}

/** Modifie la fiche ; seules les rubriques fournies changent. Le titulaire seul ne touche qu'au ton et aux sujets à éviter. */
export async function saveAccountProfile(db: Database, userId: string, accountId: string, input: AccountProfileInput, now: Date): Promise<readonly string[]> {
  if (input.voice !== undefined && input.voice !== null && input.voice !== 'je' && input.voice !== 'nous') throw new RefusedError('voix_invalide', 'Voix inconnue.');
  if (input.sensitivity !== undefined && !SENSITIVITIES.includes(input.sensitivity)) throw new RefusedError('sensibilite_invalide', 'Sensibilité inconnue.');
  if (input.aiImageRatio !== undefined && !IMAGE_RATIOS.some((r) => r.value === input.aiImageRatio)) throw new RefusedError('part_photos_invalide', 'Part des visuels avec photo inconnue.');
  const values = {
    voice: input.voice,
    tenor: input.tenor === undefined ? undefined : cleanText(input.tenor, 2000),
    sensitivity: input.sensitivity,
    avoid: input.avoid === undefined ? undefined : cleanText(input.avoid, 2000),
    posts_per_week: count(input.postsPerWeek, 'rythme'),
    optional_per_week: count(input.optionalPerWeek, 'options'),
    usual_slots: input.usualSlots === undefined ? undefined : JSON.stringify(parseUsualSlots(input.usualSlots)),
    ai_image_ratio: input.aiImageRatio === undefined ? undefined : input.aiImageRatio.toFixed(2),
  };
  const provided = (Object.keys(input) as (keyof AccountProfileInput)[]).filter((key) => input[key] !== undefined);

  return asUser(db, userId, async (trx) => {
    const { profile, rights } = await requireProfile(trx, userId, accountId);
    const allowed = rights.canEditAll || (rights.canEditOwn && provided.every((key) => OWN_FIELDS.has(key)));
    if (!allowed) throw new ForbiddenError('editAccountProfile');
    const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    await trx
      .insertInto('account_profiles')
      .values({ account_id: accountId, workspace_id: profile.workspaceId, ...set, updated_by: userId })
      .onConflict((oc) => oc.column('account_id').doUpdateSet({ ...set, updated_by: userId }))
      .execute();
    await audit(trx, { workspaceId: profile.workspaceId, actorUserId: userId, action: 'fiche_compte.modifiee', entity: 'social_account', entityId: accountId, details: { changed: provided }, at: now });
    return provided;
  });
}

// --- Exemples de référence (EDI-05) ---

export interface ReferencePost {
  readonly id: string;
  readonly body: string;
  readonly label: 'imiter' | 'eviter';
  readonly note: string | null;
  readonly createdAt: Date;
}

async function requireExampleEditor(trx: Tx, userId: string, accountId: string): Promise<AccountProfile> {
  const { profile, rights } = await requireProfile(trx, userId, accountId);
  if (!rights.canEditAll && !rights.canEditOwn) throw new ForbiddenError('editReferencePosts');
  return profile;
}

export async function listReferencePosts(db: Database, userId: string, accountId: string): Promise<ReferencePost[]> {
  return asUser(db, userId, async (trx) => {
    await requireProfile(trx, userId, accountId);
    return referencePostsOf(trx, accountId);
  });
}

/** Exemples lus par le code système (génération). */
export async function referencePostsOf(trx: Tx, accountId: string): Promise<ReferencePost[]> {
  const rows = await trx
    .selectFrom('reference_posts')
    .select(['id', 'body', 'label', 'note', 'created_at'])
    .where('account_id', '=', accountId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map((row) => ({ id: row.id, body: row.body, label: row.label as 'imiter' | 'eviter', note: row.note, createdAt: row.created_at }));
}

export async function addReferencePost(
  db: Database,
  userId: string,
  accountId: string,
  input: { body: string; label: 'imiter' | 'eviter'; note?: string | null },
  now: Date,
): Promise<string> {
  const body = cleanText(input.body, 5000);
  if (body === null) throw new RefusedError('texte_requis', 'Collez le texte du post.');
  if (input.label !== 'imiter' && input.label !== 'eviter') throw new RefusedError('etiquette_invalide', 'Choisissez « à imiter » ou « à éviter ».');
  return asUser(db, userId, async (trx) => {
    const profile = await requireExampleEditor(trx, userId, accountId);
    const row = await trx
      .insertInto('reference_posts')
      .values({ workspace_id: profile.workspaceId, account_id: accountId, body, label: input.label, note: cleanText(input.note, 500), created_by: userId, created_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(trx, { workspaceId: profile.workspaceId, actorUserId: userId, action: 'exemple.ajoute', entity: 'reference_post', entityId: row.id, details: { accountId, label: input.label }, at: now });
    return row.id;
  });
}

export async function deleteReferencePost(db: Database, userId: string, accountId: string, referenceId: string, now: Date): Promise<void> {
  await asUser(db, userId, async (trx) => {
    const profile = await requireExampleEditor(trx, userId, accountId);
    const row = await trx.deleteFrom('reference_posts').where('id', '=', referenceId).where('account_id', '=', accountId).returning('id').executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Exemple');
    await audit(trx, { workspaceId: profile.workspaceId, actorUserId: userId, action: 'exemple.supprime', entity: 'reference_post', entityId: referenceId, details: { accountId }, at: now });
  });
}

// --- Préférences apprises (EDI-06) ---

export async function getLearnedPreferences(db: Database, userId: string, accountId: string): Promise<{ summary: string; updatedAt: Date | null }> {
  return asUser(db, userId, async (trx) => {
    await requireProfile(trx, userId, accountId);
    const row = await trx.selectFrom('learned_preferences').select(['summary', 'updated_at']).where('account_id', '=', accountId).executeTakeFirst();
    return { summary: row?.summary ?? '', updatedAt: row?.updated_at ?? null };
  });
}

/** Le résumé est visible et modifiable (EDI-06) par la gestion du contenu et par le titulaire. */
export async function saveLearnedPreferences(db: Database, userId: string, accountId: string, summary: string, now: Date): Promise<void> {
  const text = (summary ?? '').trim().slice(0, 4000);
  await asUser(db, userId, async (trx) => {
    const profile = await requireExampleEditor(trx, userId, accountId);
    await trx
      .insertInto('learned_preferences')
      .values({ account_id: accountId, workspace_id: profile.workspaceId, summary: text, edited_by: userId })
      .onConflict((oc) => oc.column('account_id').doUpdateSet({ summary: text, edited_by: userId }))
      .execute();
    await audit(trx, { workspaceId: profile.workspaceId, actorUserId: userId, action: 'preferences.modifiees', entity: 'social_account', entityId: accountId, details: {}, at: now });
  });
}
