import { NotFoundError, getTemplateLibrary } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { archiveTemplateAction, duplicateTemplateAction, recolorAction, saveBrandingAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Visuels' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLORS = [
  ['principale', 'primary', 'Couleur principale (fonds, bandeaux)'],
  ['accent', 'secondary', 'Couleur d’accent (signature, détails)'],
  ['claire', 'light', 'Fond clair'],
  ['sombre', 'dark', 'Texte sombre'],
] as const;

/** VIS-01, ONB-05, VIS-05 : modèles de l'espace, charte visuelle, budget d'images générées. */
export default async function VisualsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { message } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let library;
  try {
    library = await getTemplateLibrary(database(), userId, workspaceId, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { templates, branding, imageBudget, canManage } = library;
  const active = templates.filter((t) => !t.archived);
  const archived = templates.filter((t) => t.archived);

  return (
    <>
      <h1>Visuels</h1>
      <Flash code={message} />
      <p className="hint">
        Chaque post rédigé par l’IA reçoit un visuel : l’IA remplit un de ces modèles avec le titre et les points clés du post. Selon le réglage de chaque compte (fiche du compte),
        environ un visuel sur deux porte une photo : une photo de la <Link href={`/visuels/${workspaceId}/photos`}>médiathèque</Link> quand l’une convient, sinon une image générée par IA,
        signalée comme telle.
      </p>

      <section aria-labelledby="modeles">
        <h2 id="modeles">Modèles</h2>
        {active.length === 0 && <p>Aucun modèle actif : les posts sont rédigés sans visuel.</p>}
        <ul className="template-grid">
          {active.map((t) => (
            <li key={t.id}>
              {/* eslint-disable-next-line @next/next/no-img-element -- aperçu privé rendu par le serveur */}
              <img src={`/visuels/${workspaceId}/modeles/${t.id}/apercu`} alt={`Aperçu du modèle ${t.name}`} width={220} loading="lazy" />
              <strong>{t.name}</strong>
              <span className="hint">
                {t.format === 'square' ? 'Carré' : 'Portrait'} · {t.hasPhoto ? 'avec photo' : 'texte'}
                {t.hasBullets ? ' · liste de points' : ''}
                {t.accountName ? ` · seulement ${t.accountName}` : ''}
              </span>
              <Link href={`/visuels/${workspaceId}/modeles/${t.id}`}>{canManage ? 'Modifier' : 'Voir'}</Link>
            </li>
          ))}
        </ul>
        {canManage && templates.length > 0 && (
          <form action={duplicateTemplateAction.bind(null, workspaceId)} className="inline">
            <label htmlFor="modele">Nouveau modèle à partir de</label>
            <select id="modele" name="modele" defaultValue={active[0]?.id ?? templates[0]?.id}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button type="submit">Créer une copie</button>
          </form>
        )}
        {archived.length > 0 && (
          <details>
            <summary>Modèles archivés ({archived.length})</summary>
            <ul>
              {archived.map((t) => (
                <li key={t.id}>
                  <Link href={`/visuels/${workspaceId}/modeles/${t.id}`}>{t.name}</Link>
                  {canManage && (
                    <form action={archiveTemplateAction.bind(null, workspaceId, t.id, false)} className="inline">
                      <button type="submit">Remettre en service</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section aria-labelledby="charte">
        <h2 id="charte">Charte visuelle</h2>
        {canManage ? (
          <form action={saveBrandingAction.bind(null, workspaceId)} className="stack">
            <div className="grid4">
              {COLORS.map(([name, key, label]) => (
                <label key={name} htmlFor={name} className="field">
                  {label}
                  <input id={name} name={name} type="color" defaultValue={branding[key]} required />
                </label>
              ))}
            </div>
            <fieldset>
              <legend>Logo</legend>
              {branding.logoAssetId !== null && (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- image privée servie par /media */}
                  <img src={`/media/${branding.logoAssetId}`} alt="Logo actuel" height={60} className="logo-preview" />
                  <label className="check">
                    <input type="checkbox" name="retirer-logo" /> Retirer le logo
                  </label>
                </>
              )}
              <label htmlFor="logo">{branding.logoAssetId === null ? 'Ajouter un logo' : 'Remplacer le logo'} (PNG de préférence, fond transparent)</label>
              <input id="logo" name="logo" type="file" accept="image/png,image/jpeg" />
            </fieldset>
            {library.canSetBudget ? (
              <label htmlFor="budget" className="field">
                Images générées par IA, au plus, par mois ({imageBudget.used} ce mois-ci)
                <input id="budget" name="budget" type="number" min={0} max={1000} defaultValue={imageBudget.monthly} required />
              </label>
            ) : (
              <p className="hint">
                Budget d’images générées : {imageBudget.used} sur {imageBudget.monthly} ce mois-ci (réglé par les administrateurs).
              </p>
            )}
            <button type="submit" className="primary">
              Enregistrer la charte
            </button>
          </form>
        ) : (
          <p>
            Couleurs : {COLORS.map(([, key]) => branding[key]).join(', ')}. Images générées ce mois-ci : {imageBudget.used} sur {imageBudget.monthly}.
          </p>
        )}
        {canManage && (
          <form action={recolorAction.bind(null, workspaceId)}>
            <p className="hint">Les modèles de départ gardent les couleurs qu’ils avaient à leur création. Vous pouvez les remettre aux couleurs actuelles de la charte : leurs modifications seront perdues.</p>
            <button type="submit">Remettre les modèles de départ aux couleurs de la charte</button>
          </form>
        )}
      </section>
    </>
  );
}
