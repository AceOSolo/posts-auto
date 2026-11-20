/**
 * ADM-05 : galerie de départ proposée à tous les clients. Les modèles intégrés (code)
 * peuvent être retirés ; l'éditeur ajoute ses propres modèles, définis en JSON, avec les
 * couleurs « brand.primary », « brand.secondary », « brand.light », « brand.dark » et la
 * police « brand.font », remplacées par la charte de chaque espace. Un changement vaut pour
 * les espaces qui n'ont pas encore reçu leurs modèles ; les copies existantes ne bougent pas.
 */
import { type Database, type Tx, asSystem } from '@posts-auto/db';
import { type Brand, DEFAULT_BRAND, type GalleryTemplate, TemplateError, galleryTemplates, parseTemplate } from '@posts-auto/visuals';
import { RefusedError } from '../errors.ts';
import { requirePlatformAdmin } from './platform.ts';

/** Remplace les jetons de charte dans une définition. */
export function applyBrand(value: unknown, brand: Brand): unknown {
  if (typeof value === 'string') {
    const tokens: Record<string, string> = { 'brand.primary': brand.primary, 'brand.secondary': brand.secondary, 'brand.light': brand.light, 'brand.dark': brand.dark, 'brand.font': brand.font };
    return tokens[value] ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => applyBrand(v, brand));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, applyBrand(v, brand)]));
  return value;
}

/** Galerie en vigueur, aux couleurs d'une charte (copie des modèles de départ). */
export async function galleryCatalog(trx: Tx, brand: Brand): Promise<GalleryTemplate[]> {
  const entries = await trx.selectFrom('gallery_entries').selectAll().orderBy('position').orderBy('key').execute();
  const disabled = new Set(entries.filter((e) => !e.active).map((e) => e.key));
  const builtins = galleryTemplates(brand).filter((t) => !disabled.has(t.key));
  const custom: GalleryTemplate[] = [];
  for (const e of entries) {
    if (!e.active || e.definition === null || e.name === null) continue;
    try {
      custom.push({ key: e.key, name: e.name, withPhoto: e.with_photo, definition: parseTemplate(applyBrand(e.definition, brand)) });
    } catch {
      // Définition devenue invalide : le modèle n'est pas proposé (vérifiée à l'enregistrement).
    }
  }
  return [...builtins, ...custom];
}

export interface GalleryAdminEntry {
  readonly key: string;
  readonly name: string;
  readonly builtin: boolean;
  readonly active: boolean;
  readonly withPhoto: boolean;
  readonly definitionJson: string;
}

export async function listGalleryEntries(db: Database, adminId: string): Promise<GalleryAdminEntry[]> {
  await requirePlatformAdmin(db, adminId);
  return asSystem(db, async (trx) => {
    const entries = await trx.selectFrom('gallery_entries').selectAll().orderBy('position').orderBy('key').execute();
    const byKey = new Map(entries.map((e) => [e.key, e]));
    const builtins = galleryTemplates(DEFAULT_BRAND).map((t) => ({
      key: t.key,
      name: t.name,
      builtin: true,
      active: byKey.get(t.key)?.active ?? true,
      withPhoto: t.withPhoto,
      definitionJson: JSON.stringify(t.definition, null, 2),
    }));
    const custom = entries
      .filter((e) => e.definition !== null)
      .map((e) => ({ key: e.key, name: e.name as string, builtin: false, active: e.active, withPhoto: e.with_photo, definitionJson: JSON.stringify(e.definition, null, 2) }));
    return [...builtins, ...custom];
  });
}

export async function setGalleryEntryActive(db: Database, adminId: string, key: string, active: boolean, now: Date): Promise<void> {
  await requirePlatformAdmin(db, adminId);
  await asSystem(db, async (trx) => {
    const builtin = galleryTemplates().some((t) => t.key === key);
    if (builtin) {
      await trx.insertInto('gallery_entries').values({ key, active, updated_at: now }).onConflict((oc) => oc.column('key').doUpdateSet({ active, updated_at: now })).execute();
      return;
    }
    const updated = await trx.updateTable('gallery_entries').set({ active, updated_at: now }).where('key', '=', key).returning('key').executeTakeFirst();
    if (updated === undefined) throw new RefusedError('modele_inconnu', 'Modèle inconnu.');
  });
}

/** Ajoute ou modifie un modèle de l'éditeur ; la définition est vérifiée avec la charte par défaut. */
export async function saveGalleryEntry(
  db: Database,
  adminId: string,
  input: { readonly key: string; readonly name: string; readonly definitionJson: string; readonly withPhoto: boolean },
  now: Date,
): Promise<void> {
  await requirePlatformAdmin(db, adminId);
  const key = input.key.trim().toLowerCase();
  const name = input.name.trim();
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(key)) throw new RefusedError('cle_invalide', 'Identifiant : lettres minuscules, chiffres et tirets.');
  if (galleryTemplates().some((t) => t.key === key)) throw new RefusedError('cle_reservee', 'Cet identifiant est celui d’un modèle intégré.');
  if (name.length === 0 || name.length > 80) throw new RefusedError('nom_modele_requis', 'Donnez un nom au modèle.');
  let definition: unknown;
  try {
    definition = JSON.parse(input.definitionJson);
    parseTemplate(applyBrand(definition, DEFAULT_BRAND));
  } catch (error) {
    throw new RefusedError('definition_invalide', error instanceof TemplateError || error instanceof SyntaxError ? error.message : 'Définition invalide.');
  }
  await asSystem(db, (trx) =>
    trx
      .insertInto('gallery_entries')
      .values({ key, name, definition: JSON.stringify(definition), with_photo: input.withPhoto, active: true, updated_at: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ name, definition: JSON.stringify(definition), with_photo: input.withPhoto, updated_at: now }))
      .execute(),
  );
}
