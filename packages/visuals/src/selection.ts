/**
 * Choix d'un visuel : avec ou sans photo (VIS-04), puis quel modèle (VIS-01).
 */
import type { TemplateDefinition } from './template.ts';

/**
 * VIS-04 : pour chacun des `count` prochains visuels d'un compte, photo ou non, de sorte
 * que la part des visuels avec photo approche `ratio` (0 : jamais, 1 : toujours, 0,5 : un
 * sur deux). `history` : les derniers visuels du compte, du plus ancien au plus récent.
 * En cas d'égalité, la photo l'emporte : le premier visuel d'un compte en a une.
 */
export function photoTurns(history: readonly boolean[], count: number, ratio: number): boolean[] {
  const target = Math.min(1, Math.max(0, ratio));
  let total = history.length;
  let photos = history.filter(Boolean).length;
  const turns: boolean[] = [];
  for (let i = 0; i < count; i += 1) {
    // Avec photo si l'écart à la cible ne dépasse pas celui d'un visuel sans photo.
    const photo = target > 0 && 2 * photos + 1 <= 2 * target * (total + 1);
    turns.push(photo);
    total += 1;
    if (photo) photos += 1;
  }
  return turns;
}

export interface TemplateCandidate {
  readonly id: string;
  /** Modèle réservé à un compte, ou modèle de l'espace (null). */
  readonly accountId: string | null;
  readonly definition: TemplateDefinition;
  readonly createdAt: Date;
}

export function hasZone(definition: TemplateDefinition, kind: string): boolean {
  return definition.zones.some((zone) => zone.kind === kind);
}

/**
 * Modèles possibles, du meilleur au moins bon :
 * - avec ou sans photo selon le choix fait ;
 * - les modèles du compte s'il en a de ce genre, sinon ceux de l'espace ;
 * - un modèle à liste de points seulement s'il y a des points à y mettre ;
 * - le moins utilisé récemment par le compte d'abord (variété), puis le plus ancien.
 */
export function rankTemplates(
  candidates: readonly TemplateCandidate[],
  options: { readonly accountId: string; readonly withPhoto: boolean; readonly bullets: number; readonly uses: ReadonlyMap<string, number> },
): TemplateCandidate[] {
  const kind = candidates.filter((t) => hasZone(t.definition, 'photo') === options.withPhoto && (t.accountId === null || t.accountId === options.accountId));
  const own = kind.filter((t) => t.accountId === options.accountId);
  const pool = own.length > 0 ? own : kind.filter((t) => t.accountId === null);
  const fitting = pool.filter((t) => options.bullets >= 3 || !hasZone(t.definition, 'bullets'));
  return [...(fitting.length > 0 ? fitting : pool)].sort(
    (a, b) => (options.uses.get(a.id) ?? 0) - (options.uses.get(b.id) ?? 0) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}

/** Taille de la zone photo d'un modèle (pour demander une image aux bonnes proportions). */
export function photoBox(definition: TemplateDefinition): { readonly width: number; readonly height: number } | null {
  const zone = definition.zones.find((z) => z.kind === 'photo');
  return zone === undefined ? null : { width: zone.box.w, height: zone.box.h };
}
