/**
 * Back-office de l'éditeur (ADM-01 à ADM-06). Réservé aux personnes de `platform_admins`,
 * double authentification active (SEC-04). Les lectures portent sur tous les clients :
 * elles passent par l'identité système, après cette vérification.
 */
import { type Database, type Tx, asSystem } from '@posts-auto/db';
import { ForbiddenError, RefusedError } from '../errors.ts';

export async function isPlatformAdmin(db: Database, userId: string): Promise<boolean> {
  const row = await asSystem(db, (trx) => trx.selectFrom('platform_admins').select('user_id').where('user_id', '=', userId).executeTakeFirst());
  return row !== undefined;
}

/** Accès au back-office : personne de l'éditeur, avec la double authentification active. */
export async function requirePlatformAdmin(db: Database, userId: string): Promise<void> {
  const row = await asSystem(db, (trx) =>
    trx
      .selectFrom('platform_admins as p')
      .leftJoin('user_totp as t', (join) => join.onRef('t.user_id', '=', 'p.user_id').on('t.confirmed_at', 'is not', null))
      .select(['p.user_id', 't.user_id as totp'])
      .where('p.user_id', '=', userId)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new ForbiddenError('platformAdmin');
  if (row.totp === null) throw new RefusedError('mfa_requise_admin', 'Activez la double authentification pour accéder au back-office.');
}

/** ADM-04 : paramètres globaux, valeurs par défaut des nouveaux espaces et comptes. */
export const PLATFORM_SETTINGS = {
  image_budget_monthly: { label: 'Images générées par mois et par espace (budget de départ, VIS-05)', min: 0, max: 1000, fallback: 30 },
  max_posts_per_account_per_day: { label: 'Posts par compte et par jour, au plus', min: 1, max: 10, fallback: 2 },
  max_posts_per_slot: { label: 'Posts sur le même créneau, au plus', min: 1, max: 10, fallback: 2 },
  min_gap_minutes: { label: 'Écart minimal entre deux posts de l’espace (minutes)', min: 0, max: 600, fallback: 30 },
  posts_per_week: { label: 'Posts par semaine d’un nouveau compte', min: 0, max: 14, fallback: 1 },
  ai_image_ratio_percent: { label: 'Part des visuels avec une image générée, pour un nouveau compte (%)', min: 0, max: 100, fallback: 50 },
} as const;

export type PlatformSettingKey = keyof typeof PLATFORM_SETTINGS;
export type PlatformSettings = Record<PlatformSettingKey, number>;
export const PLATFORM_SETTING_KEYS = Object.keys(PLATFORM_SETTINGS) as PlatformSettingKey[];

/** Paramètres en vigueur (valeur enregistrée, sinon valeur d'origine). Lisibles sous toute identité. */
export async function loadPlatformSettings(trx: Tx): Promise<PlatformSettings> {
  const rows = await trx.selectFrom('platform_settings').select(['key', 'value']).execute();
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const result = {} as Record<PlatformSettingKey, number>;
  for (const key of PLATFORM_SETTING_KEYS) {
    const spec = PLATFORM_SETTINGS[key];
    const value = stored.get(key);
    result[key] = typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max ? value : spec.fallback;
  }
  return result;
}

/** Valeurs par défaut d'un nouvel espace (signup, agence). */
export async function workspaceDefaults(trx: Tx) {
  const s = await loadPlatformSettings(trx);
  return { image_budget_monthly: s.image_budget_monthly, max_posts_per_account_per_day: s.max_posts_per_account_per_day, max_posts_per_slot: s.max_posts_per_slot, min_gap_minutes: s.min_gap_minutes };
}

/** Valeurs par défaut de la fiche d'un nouveau compte. */
export async function accountProfileDefaults(trx: Tx) {
  const s = await loadPlatformSettings(trx);
  return { posts_per_week: s.posts_per_week, ai_image_ratio: (s.ai_image_ratio_percent / 100).toFixed(2) };
}

export async function updatePlatformSettings(db: Database, adminId: string, input: Readonly<Record<string, string>>, now: Date): Promise<PlatformSettings> {
  await requirePlatformAdmin(db, adminId);
  const values: { key: PlatformSettingKey; value: number }[] = [];
  for (const key of PLATFORM_SETTING_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw.trim() === '') continue;
    const spec = PLATFORM_SETTINGS[key];
    const value = Number(raw.trim());
    if (!Number.isInteger(value) || value < spec.min || value > spec.max) throw new RefusedError('parametre_invalide', `${spec.label} : entre ${spec.min} et ${spec.max}.`);
    values.push({ key, value });
  }
  return asSystem(db, async (trx) => {
    for (const { key, value } of values) {
      await trx
        .insertInto('platform_settings')
        .values({ key, value: JSON.stringify(value), updated_at: now, updated_by: adminId })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_at: now, updated_by: adminId }))
        .execute();
    }
    return loadPlatformSettings(trx);
  });
}
