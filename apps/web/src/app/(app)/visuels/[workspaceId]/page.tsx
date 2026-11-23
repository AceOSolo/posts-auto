import { type BrandProposal, type CanvaTemplateChoice, NotFoundError, canvaStatus, getTemplateLibrary, listCanvaBrandTemplates } from '@posts-auto/services';
import { FONTS } from '@posts-auto/visuals';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { PageHeader } from '../../../../components/page-header.tsx';
import { canvaApi, database, mediaStore, tokenCipher } from '../../../../server/context.ts';
import { brandProposalKey } from '../../../../server/drafts.ts';
import { requireUserId } from '../../../../server/session.ts';
import { addCanvaTemplateAction, archiveTemplateAction, disconnectCanvaAction, duplicateTemplateAction, proposeBrandAction, recolorAction, saveBrandingAction } from '../actions.ts';

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
  const { message, charte } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let library;
  try {
    library = await getTemplateLibrary(database(), userId, workspaceId, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { templates, imageBudget, canManage } = library;
  // ONB-05 : charte proposée à partir du site, à relire avant d'enregistrer.
  let proposal: BrandProposal | null = null;
  if (typeof charte === 'string' && UUID.test(charte)) {
    try {
      proposal = JSON.parse(new TextDecoder().decode(await mediaStore().read(brandProposalKey(workspaceId, charte)))) as BrandProposal;
    } catch {
      proposal = null;
    }
  }
  // VIS-07 : connecteur Canva.
  const canvaConfigured = canvaApi() !== null && tokenCipher() !== null;
  const canva = canManage && canvaConfigured ? await canvaStatus(database(), userId, workspaceId) : null;
  let canvaTemplates: CanvaTemplateChoice[] | null = null;
  let canvaError = false;
  if (canva?.connected) {
    try {
      canvaTemplates = await listCanvaBrandTemplates(database(), canvaApi() as NonNullable<ReturnType<typeof canvaApi>>, tokenCipher() as NonNullable<ReturnType<typeof tokenCipher>>, userId, workspaceId, new Date());
    } catch {
      canvaError = true;
    }
  }
  const branding = proposal === null ? library.branding : { ...library.branding, primary: proposal.primary, secondary: proposal.secondary, light: proposal.light, dark: proposal.dark, font: proposal.font };
  const active = templates.filter((t) => !t.archived);
  const archived = templates.filter((t) => t.archived);

  return (
    <>
      <PageHeader
        title="Visuels"
        description="Chaque post reçoit un visuel préparé à partir de ces modèles, avec une de vos photos quand l’une convient."
        action={
          <Link href={`/visuels/${workspaceId}/photos`} className="button">
            Médiathèque
          </Link>
        }
      />
      <Flash code={message} />

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

      {canManage && canvaConfigured && (
        <details id="canva" open={typeof message === 'string' && message.toLowerCase().includes('canva')}>
          <summary>Modèles Canva</summary>
          <p className="hint">
            Reliez le Canva de l’entreprise pour utiliser ses modèles de marque : pour chaque post, une copie du modèle est remplie dans votre Canva (titre, points, photo), puis
            exportée en PNG comme visuel. Vos designs restent dans votre Canva. Les modèles de marque demandent un abonnement Canva qui les propose.
          </p>
          {canva?.connected ? (
            <>
              {canvaError && <p className="flash error">Canva ne répond pas : réessayez plus tard, ou reconnectez Canva.</p>}
              {canvaTemplates !== null && canvaTemplates.length === 0 && <p className="muted">Aucun modèle de marque dans ce Canva.</p>}
              <ul>
                {(canvaTemplates ?? []).map((t) => (
                  <li key={t.id}>
                    {t.title}{' '}
                    {t.added ? (
                      <span className="muted">(ajouté aux modèles)</span>
                    ) : (
                      <form action={addCanvaTemplateAction.bind(null, workspaceId, t.id)} className="inline-fields">
                        <button type="submit">{`Ajouter « ${t.title} »`}</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
              <form action={disconnectCanvaAction.bind(null, workspaceId)}>
                <button type="submit">Déconnecter Canva</button>
              </form>
            </>
          ) : (
            <a href={`/visuels/${workspaceId}/canva`} className="button">
              Connecter Canva
            </a>
          )}
        </details>
      )}

      <details id="charte" open={proposal !== null}>
        <summary>Charte visuelle</summary>
        {canManage && (
          <form action={proposeBrandAction.bind(null, workspaceId)} className="inline-fields" id="proposer-charte">
            <label>
              Proposer la charte à partir du site web
              <input name="site" type="url" inputMode="url" placeholder="https://www.votre-site.fr" required defaultValue={proposal?.sourceUrl ?? ''} />
            </label>
            <button type="submit">Proposer la charte</button>
          </form>
        )}
        {proposal !== null && (
          <div className="ai-note" role="status">
            <p>
              <strong>Charte proposée à partir de {proposal.sourceUrl}</strong>, à relire : rien n’est enregistré tant que vous n’avez pas cliqué « Enregistrer la charte ».
            </p>
            {proposal.notes.map((n) => (
              <p key={n} className="hint">
                {n}
              </p>
            ))}
          </div>
        )}
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
            <label htmlFor="police" className="field">
              Police des titres (les autres textes restent en Inter)
              <select id="police" name="police" defaultValue={branding.font}>
                {Object.entries(FONTS).map(([key, font]) => (
                  <option key={key} value={key}>
                    {font.label}
                  </option>
                ))}
              </select>
            </label>
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
              {proposal?.logoAssetId && (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- image privée servie par /media */}
                  <img src={`/media/${proposal.logoAssetId}`} alt="Logo trouvé sur le site" height={60} className="logo-preview" />
                  <input type="hidden" name="logo-site" value={proposal.logoAssetId} />
                  <label className="check">
                    <input type="checkbox" name="logo-du-site" defaultChecked /> Utiliser le logo trouvé sur le site
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
            <p className="hint">
              Les modèles de départ gardent les couleurs et la police qu’ils avaient à leur création. Vous pouvez les remettre à la charte actuelle : leurs modifications seront
              perdues.
            </p>
            <button type="submit">Remettre les modèles de départ à la charte</button>
          </form>
        )}
      </details>
    </>
  );
}
