/**
 * Éditeur de modèles (VIS-02) : formulaire ⇄ définition. Le même code sert à
 * l'enregistrement et à l'aperçu en direct ; la définition obtenue est toujours validée
 * par parseTemplate avant usage.
 */
import { FORMAT_SIZES, type TemplateDefinition, type ZoneKind } from '@posts-auto/visuals';

export const ZONE_LABELS: Record<ZoneKind, string> = {
  title: 'Titre',
  subtitle: 'Sous-titre',
  bullets: 'Liste de points',
  photo: 'Photo',
  logo: 'Logo',
  signature: 'Signature',
};
export const TEXT_ZONES: readonly ZoneKind[] = ['title', 'subtitle', 'bullets', 'signature'];

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
/** Nombre saisi ; vide ou invalide → undefined (parseTemplate dira lequel manque). */
const num = (form: FormData, name: string) => {
  const raw = text(form, name).replace(',', '.');
  if (raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};
const on = (form: FormData, name: string) => form.get(name) === 'on';

function defaultZone(kind: ZoneKind, key: string, format: 'square' | 'portrait'): Record<string, unknown> {
  const { width, height } = FORMAT_SIZES[format];
  const box = kind === 'photo' ? { x: 0, y: 0, w: width, h: Math.round(height / 2) } : { x: 80, y: Math.round(height / 2) - 60, w: width - 160, h: 120 };
  if (kind === 'photo' || kind === 'logo') return { key, kind, box: kind === 'logo' ? { x: width - 220, y: height - 140, w: 160, h: 100 } : box, fit: kind === 'logo' ? 'contain' : 'cover' };
  return { key, kind, box, style: { color: '#ffffff', weight: kind === 'title' ? 800 : 600, maxSize: kind === 'title' ? 64 : 36, minSize: 24, align: 'left', lineHeight: 1.2 } };
}

/** Définition brute tirée du formulaire de l'éditeur (à valider par parseTemplate). */
export function definitionFromForm(form: FormData): Record<string, unknown> {
  const format = text(form, 'format') === 'portrait' ? 'portrait' : 'square';
  const count = Math.min(12, Math.max(0, Number.parseInt(text(form, 'zones'), 10) || 0));
  const zones: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    const p = `zone-${i}-`;
    if (on(form, `${p}supprimer`)) continue;
    const kind = text(form, `${p}type`) as ZoneKind;
    const zone: Record<string, unknown> = {
      key: text(form, `${p}cle`),
      kind,
      box: { x: num(form, `${p}x`), y: num(form, `${p}y`), w: num(form, `${p}l`), h: num(form, `${p}h`) },
    };
    if (TEXT_ZONES.includes(kind)) {
      zone['style'] = {
        color: text(form, `${p}couleur`),
        weight: num(form, `${p}graisse`),
        maxSize: num(form, `${p}taille-max`),
        minSize: num(form, `${p}taille-min`),
        align: text(form, `${p}alignement`),
        valign: text(form, `${p}vertical`),
        lineHeight: num(form, `${p}interligne`),
        ...(on(form, `${p}fond-actif`) && { background: text(form, `${p}fond`), padding: num(form, `${p}marge`) ?? 0 }),
        ...(on(form, `${p}majuscules`) && { uppercase: true }),
      };
    } else {
      zone['fit'] = text(form, `${p}cadrage`) === 'contain' ? 'contain' : 'cover';
      const radius = num(form, `${p}arrondi`);
      if (radius !== undefined && radius > 0) zone['radius'] = radius;
      const overlay = num(form, `${p}voile`);
      if (overlay !== undefined && overlay > 0) zone['overlay'] = overlay;
    }
    zones.push(zone);
  }
  const added = text(form, 'nouvelle-zone') as ZoneKind;
  if (added in ZONE_LABELS) {
    const used = new Set(zones.map((z) => z['key']));
    let n = 1;
    while (used.has(`${added}-${n}`)) n += 1;
    zones.push(defaultZone(added, `${added}-${n}`, format));
  }
  return {
    format,
    background: text(form, 'fond'),
    ...(on(form, 'bandeau') && {
      accent: { color: text(form, 'bandeau-couleur'), box: { x: num(form, 'bandeau-x'), y: num(form, 'bandeau-y'), w: num(form, 'bandeau-l'), h: num(form, 'bandeau-h') } },
    }),
    zones,
  };
}

/** Bandeau proposé quand on l'active pour la première fois. */
export function defaultAccent(definition: TemplateDefinition): { color: string; box: { x: number; y: number; w: number; h: number } } {
  return definition.accent ?? { color: '#f0a500', box: { x: 0, y: 0, w: 18, h: FORMAT_SIZES[definition.format].height } };
}
