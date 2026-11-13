/**
 * Ligne éditoriale de l'espace (EDI-01, EDI-02) et son historique (EDI-07), état de
 * l'offre (EDI-03).
 *
 * Chaque enregistrement de la ligne éditoriale crée une version : l'historique dit qui a
 * changé quoi, et quand. Modifiable par le propriétaire, les administrateurs et les
 * éditeurs (matrice 3.3) ; lisible par tous les membres.
 */
import { DEFAULT_EDITORIAL_RULES, type EditorialRules, parseEditorialRules } from '@posts-auto/core';
import { type Database, type Tx, asUser } from '@posts-auto/db';
import { canManageContent, workspaceRole } from '../access.ts';
import { audit, cleanLines, cleanText } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';

export interface EditorialLine {
  /** 0 : aucune version enregistrée, les valeurs par défaut s'appliquent. */
  readonly version: number;
  readonly positioning: string | null;
  readonly offers: string | null;
  readonly audiences: string | null;
  readonly allowedProofs: string | null;
  readonly tone: string | null;
  readonly bannedPhrases: readonly string[];
  readonly rules: EditorialRules;
  readonly savedAt: Date | null;
  readonly savedBy: string | null;
}

export type EditorialLineInput = Omit<EditorialLine, 'version' | 'savedAt' | 'savedBy'>;

const FIELD_LABELS: Record<keyof EditorialLineInput, string> = {
  positioning: 'Positionnement',
  offers: 'Offres',
  audiences: 'Cibles',
  allowedProofs: 'Preuves autorisées',
  tone: 'Ton',
  bannedPhrases: 'Mots et formules interdits',
  rules: 'Règles communes',
};

const TEXT_MAX = 4000;

async function requireReader(trx: Tx, userId: string, workspaceId: string) {
  const role = await workspaceRole(trx, userId, workspaceId);
  if (role === null) throw new NotFoundError('Espace');
  return role;
}

async function currentRow(trx: Tx, workspaceId: string) {
  return trx
    .selectFrom('editorial_lines as e')
    .leftJoin('users as u', 'u.id', 'e.created_by')
    .select(['e.version', 'e.positioning', 'e.offers', 'e.audiences', 'e.allowed_proofs', 'e.tone', 'e.banned_phrases', 'e.rules', 'e.created_at', 'u.full_name', 'u.email'])
    .where('e.workspace_id', '=', workspaceId)
    .where('e.is_current', '=', true)
    .executeTakeFirst();
}

function toLine(row: Awaited<ReturnType<typeof currentRow>>): EditorialLine {
  if (row === undefined) {
    return {
      version: 0,
      positioning: null,
      offers: null,
      audiences: null,
      allowedProofs: null,
      tone: null,
      bannedPhrases: [],
      rules: DEFAULT_EDITORIAL_RULES,
      savedAt: null,
      savedBy: null,
    };
  }
  return {
    version: row.version,
    positioning: row.positioning,
    offers: row.offers,
    audiences: row.audiences,
    allowedProofs: row.allowed_proofs,
    tone: row.tone,
    bannedPhrases: row.banned_phrases,
    rules: parseEditorialRules(row.rules),
    savedAt: row.created_at,
    savedBy: row.full_name ?? row.email,
  };
}

/** Ligne en vigueur, lue par le code système (génération) : sans contrôle de droits. */
export async function currentEditorialLine(trx: Tx, workspaceId: string): Promise<EditorialLine> {
  return toLine(await currentRow(trx, workspaceId));
}

export async function getEditorialLine(db: Database, userId: string, workspaceId: string): Promise<{ line: EditorialLine; canEdit: boolean }> {
  return asUser(db, userId, async (trx) => {
    const role = await requireReader(trx, userId, workspaceId);
    return { line: toLine(await currentRow(trx, workspaceId)), canEdit: canManageContent(role) };
  });
}

function normalizeInput(input: EditorialLineInput): EditorialLineInput {
  return {
    positioning: cleanText(input.positioning, TEXT_MAX),
    offers: cleanText(input.offers, TEXT_MAX),
    audiences: cleanText(input.audiences, TEXT_MAX),
    allowedProofs: cleanText(input.allowedProofs, TEXT_MAX),
    tone: cleanText(input.tone, TEXT_MAX),
    bannedPhrases: cleanLines(input.bannedPhrases, 200, 200),
    rules: parseEditorialRules(input.rules),
  };
}

function changedFields(before: EditorialLineInput, after: EditorialLineInput): (keyof EditorialLineInput)[] {
  return (Object.keys(FIELD_LABELS) as (keyof EditorialLineInput)[]).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

/** Enregistre une nouvelle version, sauf si rien n'a changé. */
export async function saveEditorialLine(
  db: Database,
  userId: string,
  workspaceId: string,
  input: EditorialLineInput,
  now: Date,
): Promise<{ version: number; changed: readonly string[] }> {
  const next = normalizeInput(input);
  return asUser(db, userId, async (trx) => {
    if (!canManageContent(await requireReader(trx, userId, workspaceId))) throw new ForbiddenError('editEditorialLine');
    const current = toLine(await currentRow(trx, workspaceId));
    const changed = changedFields(current, next);
    if (current.version > 0 && changed.length === 0) return { version: current.version, changed: [] };

    await trx.updateTable('editorial_lines').set({ is_current: false }).where('workspace_id', '=', workspaceId).where('is_current', '=', true).execute();
    const version = current.version + 1;
    const row = await trx
      .insertInto('editorial_lines')
      .values({
        workspace_id: workspaceId,
        version,
        positioning: next.positioning,
        offers: next.offers,
        audiences: next.audiences,
        allowed_proofs: next.allowedProofs,
        tone: next.tone,
        banned_phrases: [...next.bannedPhrases],
        rules: JSON.stringify(next.rules),
        created_by: userId,
        created_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const labels = changed.map((key) => FIELD_LABELS[key]);
    await audit(trx, { workspaceId, actorUserId: userId, action: 'ligne_editoriale.modifiee', entity: 'editorial_line', entityId: row.id, details: { version, changed: labels }, at: now });
    return { version, changed: labels };
  });
}

export interface EditorialVersion {
  readonly version: number;
  readonly savedAt: Date;
  readonly savedBy: string | null;
  /** Rubriques modifiées par rapport à la version précédente. */
  readonly changed: readonly string[];
}

/** EDI-07 : historique, de la plus récente à la plus ancienne. */
export async function editorialHistory(db: Database, userId: string, workspaceId: string): Promise<EditorialVersion[]> {
  return asUser(db, userId, async (trx) => {
    await requireReader(trx, userId, workspaceId);
    const rows = await trx
      .selectFrom('editorial_lines as e')
      .leftJoin('users as u', 'u.id', 'e.created_by')
      .select(['e.version', 'e.positioning', 'e.offers', 'e.audiences', 'e.allowed_proofs', 'e.tone', 'e.banned_phrases', 'e.rules', 'e.created_at', 'u.full_name', 'u.email'])
      .where('e.workspace_id', '=', workspaceId)
      .orderBy('e.version')
      .execute();
    const lines = rows.map((row) => toLine({ ...row }));
    return lines
      .map((line, i) => ({
        version: line.version,
        savedAt: line.savedAt as Date,
        savedBy: line.savedBy,
        changed: i === 0 ? ['Première version'] : changedFields(lines[i - 1] as EditorialLine, line).map((key) => FIELD_LABELS[key]),
      }))
      .reverse();
  });
}

// --- État de l'offre (EDI-03) ---

export type OfferStatus = 'available' | 'planned' | 'retired';
export type OfferPricing = 'free' | 'paid' | null;
const OFFER_STATUSES: readonly OfferStatus[] = ['available', 'planned', 'retired'];

export interface OfferItem {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: OfferStatus;
  readonly pricing: OfferPricing;
}

export async function listOffer(db: Database, userId: string, workspaceId: string): Promise<{ items: OfferItem[]; canEdit: boolean }> {
  return asUser(db, userId, async (trx) => {
    const role = await requireReader(trx, userId, workspaceId);
    return { items: await offerItems(trx, workspaceId), canEdit: canManageContent(role) };
  });
}

/** État de l'offre, lu par le code système (génération). */
export async function offerItems(trx: Tx, workspaceId: string): Promise<OfferItem[]> {
  const rows = await trx
    .selectFrom('offer_items')
    .select(['id', 'name', 'description', 'status', 'pricing'])
    .where('workspace_id', '=', workspaceId)
    .orderBy('position')
    .orderBy('created_at')
    .execute();
  return rows.map((row) => ({ id: row.id, name: row.name, description: row.description, status: row.status as OfferStatus, pricing: row.pricing as OfferPricing }));
}

export interface OfferItemInput {
  readonly name: string;
  readonly description?: string | null;
  readonly status: OfferStatus;
  readonly pricing?: OfferPricing;
}

export async function saveOfferItem(
  db: Database,
  userId: string,
  workspaceId: string,
  itemId: string | null,
  input: OfferItemInput,
  now: Date,
): Promise<string> {
  const name = cleanText(input.name, 200);
  if (name === null) throw new RefusedError('nom_requis', 'Donnez un nom à l’offre.');
  if (!OFFER_STATUSES.includes(input.status)) throw new RefusedError('statut_invalide', 'Disponibilité inconnue.');
  const pricing = input.pricing === 'free' || input.pricing === 'paid' ? input.pricing : null;
  const values = { name, description: cleanText(input.description, 2000), status: input.status, pricing };
  return asUser(db, userId, async (trx) => {
    if (!canManageContent(await requireReader(trx, userId, workspaceId))) throw new ForbiddenError('editOffer');
    let id: string;
    if (itemId === null) {
      const last = await trx
        .selectFrom('offer_items')
        .select((eb) => eb.fn.max('position').as('max'))
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      const row = await trx
        .insertInto('offer_items')
        .values({ workspace_id: workspaceId, position: Number(last?.max ?? 0) + 1, ...values })
        .returning('id')
        .executeTakeFirstOrThrow();
      id = row.id;
    } else {
      const row = await trx.updateTable('offer_items').set(values).where('id', '=', itemId).where('workspace_id', '=', workspaceId).returning('id').executeTakeFirst();
      if (row === undefined) throw new NotFoundError('Offre');
      id = row.id;
    }
    await audit(trx, { workspaceId, actorUserId: userId, action: itemId === null ? 'offre.ajoutee' : 'offre.modifiee', entity: 'offer_item', entityId: id, details: values, at: now });
    return id;
  });
}

export async function deleteOfferItem(db: Database, userId: string, workspaceId: string, itemId: string, now: Date): Promise<void> {
  await asUser(db, userId, async (trx) => {
    if (!canManageContent(await requireReader(trx, userId, workspaceId))) throw new ForbiddenError('editOffer');
    const row = await trx.deleteFrom('offer_items').where('id', '=', itemId).where('workspace_id', '=', workspaceId).returning('name').executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Offre');
    await audit(trx, { workspaceId, actorUserId: userId, action: 'offre.supprimee', entity: 'offer_item', entityId: itemId, details: { name: row.name }, at: now });
  });
}
