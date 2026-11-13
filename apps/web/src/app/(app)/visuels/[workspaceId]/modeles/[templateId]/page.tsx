import { NotFoundError, findMediaForUser, getTemplate } from '@posts-auto/services';
import { FORMAT_SIZES, type Zone, renderTemplate, sampleContent } from '@posts-auto/visuals';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../../../components/flash.tsx';
import { TemplateLivePreview } from '../../../../../../components/template-live-preview.tsx';
import { database, mediaStore } from '../../../../../../server/context.ts';
import { requireUserId } from '../../../../../../server/session.ts';
import { TEXT_ZONES, ZONE_LABELS, defaultAccent } from '../../../../../../server/template-form.ts';
import { archiveTemplateAction, saveTemplateAction } from '../../../actions.ts';

export const metadata: Metadata = { title: 'Modèle de visuel' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEIGHTS = [
  [400, 'Normal'],
  [600, 'Demi-gras'],
  [700, 'Gras'],
  [800, 'Très gras'],
] as const;

function Num({ id, name, label, value, min, max, step = 1 }: { id: string; name: string; label: string; value: number | undefined; min: number; max: number; step?: number }) {
  return (
    <label htmlFor={id} className="field">
      {label}
      <input id={id} name={name} type="number" inputMode="decimal" min={min} max={max} step={step} defaultValue={value ?? ''} />
    </label>
  );
}

function ZoneFields({ zone, index, width, height }: { zone: Zone; index: number; width: number; height: number }) {
  const p = `zone-${index}-`;
  const id = (name: string) => `${p}${name}`;
  const style = zone.style;
  return (
    <fieldset className="zone">
      <legend>
        {ZONE_LABELS[zone.kind]} « {zone.key} »
      </legend>
      <input type="hidden" name={`${p}type`} value={zone.kind} />
      <label htmlFor={id('cle')} className="field">
        Nom de la zone
        <input id={id('cle')} name={`${p}cle`} defaultValue={zone.key} pattern="[a-z][a-z0-9_\-]{0,30}" required />
      </label>
      <div className="grid4">
        <Num id={id('x')} name={`${p}x`} label="Gauche" value={zone.box.x} min={0} max={width - 1} />
        <Num id={id('y')} name={`${p}y`} label="Haut" value={zone.box.y} min={0} max={height - 1} />
        <Num id={id('l')} name={`${p}l`} label="Largeur" value={zone.box.w} min={1} max={width} />
        <Num id={id('h')} name={`${p}h`} label="Hauteur" value={zone.box.h} min={1} max={height} />
      </div>
      {TEXT_ZONES.includes(zone.kind) && style ? (
        <>
          <div className="grid4">
            <label htmlFor={id('couleur')} className="field">
              Couleur
              <input id={id('couleur')} name={`${p}couleur`} type="color" list="couleurs-charte" defaultValue={style.color} />
            </label>
            <label htmlFor={id('graisse')} className="field">
              Graisse
              <select id={id('graisse')} name={`${p}graisse`} defaultValue={String(style.weight)}>
                {WEIGHTS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <Num id={id('taille-max')} name={`${p}taille-max`} label="Taille max." value={style.maxSize} min={12} max={200} />
            <Num id={id('taille-min')} name={`${p}taille-min`} label="Taille min." value={style.minSize} min={12} max={200} />
          </div>
          <div className="grid4">
            <label htmlFor={id('alignement')} className="field">
              Alignement
              <select id={id('alignement')} name={`${p}alignement`} defaultValue={style.align}>
                <option value="left">À gauche</option>
                <option value="center">Centré</option>
                <option value="right">À droite</option>
              </select>
            </label>
            <label htmlFor={id('vertical')} className="field">
              Position
              <select id={id('vertical')} name={`${p}vertical`} defaultValue={style.valign ?? 'top'}>
                <option value="top">En haut</option>
                <option value="middle">Au milieu</option>
                <option value="bottom">En bas</option>
              </select>
            </label>
            <Num id={id('interligne')} name={`${p}interligne`} label="Interligne" value={style.lineHeight} min={0.9} max={2} step={0.05} />
            <label className="check">
              <input type="checkbox" name={`${p}majuscules`} defaultChecked={style.uppercase === true} /> Majuscules
            </label>
          </div>
          <div className="grid4">
            <label className="check">
              <input type="checkbox" name={`${p}fond-actif`} defaultChecked={style.background !== undefined} /> Bandeau de fond
            </label>
            <label htmlFor={id('fond')} className="field">
              Couleur du bandeau
              <input id={id('fond')} name={`${p}fond`} type="color" list="couleurs-charte" defaultValue={style.background ?? '#0f3d5e'} />
            </label>
            <Num id={id('marge')} name={`${p}marge`} label="Marge intérieure" value={style.padding ?? 0} min={0} max={200} />
          </div>
        </>
      ) : (
        <div className="grid4">
          <label htmlFor={id('cadrage')} className="field">
            Cadrage
            <select id={id('cadrage')} name={`${p}cadrage`} defaultValue={zone.fit ?? 'cover'}>
              <option value="cover">Remplir la zone (recadrée)</option>
              <option value="contain">Image entière</option>
            </select>
          </label>
          <Num id={id('arrondi')} name={`${p}arrondi`} label="Arrondi des coins" value={zone.radius ?? 0} min={0} max={540} />
          {zone.kind === 'photo' && <Num id={id('voile')} name={`${p}voile`} label="Voile sombre (0 à 0,9)" value={zone.overlay ?? 0} min={0} max={0.9} step={0.05} />}
        </div>
      )}
      <label className="check">
        <input type="checkbox" name={`${p}supprimer`} /> Retirer cette zone
      </label>
    </fieldset>
  );
}

/** VIS-02 : éditeur simple — zones, couleurs de la charte, logo ; aperçu en direct. */
export default async function TemplateEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; templateId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, templateId } = await params;
  const { message, detail } = await searchParams;
  if (!UUID.test(workspaceId) || !UUID.test(templateId)) notFound();
  const userId = await requireUserId();
  let template;
  try {
    template = await getTemplate(database(), userId, templateId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (template.workspaceId !== workspaceId) notFound();
  const { definition, branding } = template;
  const { width, height } = FORMAT_SIZES[definition.format];
  const accent = defaultAccent(definition);
  // Problèmes du modèle enregistré, rendu avec des textes d'exemple.
  const logoAsset = branding.logoAssetId === null ? null : await findMediaForUser(database(), userId, branding.logoAssetId);
  const logo = logoAsset === null ? null : await mediaStore().read(logoAsset.storageKey).catch(() => null);
  const { issues } = await renderTemplate(definition, await sampleContent({ logo }));
  const previewUrl = `/visuels/${workspaceId}/modeles/${templateId}/apercu`;

  return (
    <>
      <p>
        <Link href={`/visuels/${workspaceId}#modeles`}>← Modèles de visuels</Link>
      </p>
      <h1>
        {template.name} {template.archived && <span className="badge">Archivé</span>}
      </h1>
      <Flash code={message} />
      {typeof detail === 'string' && <p className="flash error">{detail}</p>}
      <p className="hint">
        Visuel {definition.format === 'square' ? 'carré' : 'portrait'} de {width} × {height} pixels. Les positions et tailles sont en pixels du visuel final. Le texte prend la plus grande
        taille qui tient dans sa zone, sans descendre sous la taille minimale.
      </p>

      <div className="editor">
        <TemplateLivePreview formId="editeur" src={previewUrl} alt={`Aperçu du modèle ${template.name}`} initialProblems={issues.map((i) => i.message)} />
        {template.canManage ? (
          <form id="editeur" action={saveTemplateAction.bind(null, workspaceId, templateId)} className="stack">
            <datalist id="couleurs-charte">
              {[branding.primary, branding.secondary, branding.light, branding.dark, '#ffffff', '#000000'].map((color) => (
                <option key={color} value={color} />
              ))}
            </datalist>
            <label htmlFor="nom">Nom du modèle</label>
            <input id="nom" name="nom" defaultValue={template.name} maxLength={80} required />
            <label htmlFor="compte">Utilisé pour</label>
            <select id="compte" name="compte" defaultValue={template.accountId ?? ''}>
              <option value="">Tous les comptes de l’espace</option>
              {template.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  Seulement {account.name}
                </option>
              ))}
            </select>
            <div className="grid4">
              <label htmlFor="format" className="field">
                Format
                <select id="format" name="format" defaultValue={definition.format}>
                  <option value="square">Carré 1080 × 1080</option>
                  <option value="portrait">Portrait 1080 × 1350</option>
                </select>
              </label>
              <label htmlFor="fond" className="field">
                Couleur de fond
                <input id="fond" name="fond" type="color" list="couleurs-charte" defaultValue={definition.background} />
              </label>
            </div>
            <fieldset>
              <legend>Bandeau décoratif</legend>
              <label className="check">
                <input type="checkbox" name="bandeau" defaultChecked={definition.accent !== undefined} /> Afficher un bandeau de couleur
              </label>
              <div className="grid4">
                <label htmlFor="bandeau-couleur" className="field">
                  Couleur
                  <input id="bandeau-couleur" name="bandeau-couleur" type="color" list="couleurs-charte" defaultValue={accent.color} />
                </label>
                <Num id="bandeau-x" name="bandeau-x" label="Gauche" value={accent.box.x} min={0} max={width - 1} />
                <Num id="bandeau-y" name="bandeau-y" label="Haut" value={accent.box.y} min={0} max={height - 1} />
                <Num id="bandeau-l" name="bandeau-l" label="Largeur" value={accent.box.w} min={1} max={width} />
                <Num id="bandeau-h" name="bandeau-h" label="Hauteur" value={accent.box.h} min={1} max={height} />
              </div>
            </fieldset>

            <h2 id="zones">Zones</h2>
            <input type="hidden" name="zones" value={definition.zones.length} />
            {definition.zones.map((zone, index) => (
              <ZoneFields key={`${zone.key}-${index}`} zone={zone} index={index} width={width} height={height} />
            ))}
            {definition.zones.length < 12 && (
              <div className="inline-add">
                <label htmlFor="nouvelle-zone">Ajouter une zone</label>
                <select id="nouvelle-zone" name="nouvelle-zone" defaultValue="">
                  <option value="">—</option>
                  {Object.entries(ZONE_LABELS).map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {label}
                    </option>
                  ))}
                </select>
                <p className="hint">La zone est ajoutée à l’enregistrement, avec une position par défaut à ajuster.</p>
              </div>
            )}
            <button type="submit" className="primary">
              Enregistrer le modèle
            </button>
          </form>
        ) : (
          <p className="hint">Seules les personnes qui gèrent le contenu de l’espace modifient les modèles.</p>
        )}
      </div>

      {template.canManage && (
        <form action={archiveTemplateAction.bind(null, workspaceId, templateId, !template.archived)}>
          <button type="submit">{template.archived ? 'Remettre ce modèle en service' : 'Archiver ce modèle (il ne sera plus proposé à l’IA)'}</button>
        </form>
      )}
    </>
  );
}
