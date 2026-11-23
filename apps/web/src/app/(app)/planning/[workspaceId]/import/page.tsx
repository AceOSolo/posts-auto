import { parseCsv, readPamLayout, readSubjectSheet, subjectsOfCell } from '@posts-auto/core';
import { canManageContent, listWorkspaceAccounts, workspaceRole } from '@posts-auto/services';
import { asUser } from '@posts-auto/db';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../../components/flash.tsx';
import { database, mediaStore } from '../../../../../server/context.ts';
import { requireUserId } from '../../../../../server/session.ts';
import { previewImportAction, runImportAction } from '../../actions.ts';
import { draftKey } from '../../import-draft.ts';
import { PlanningBack, mondayLabel } from '../../planning-ui.tsx';

export const metadata: Metadata = { title: 'Importer un planning' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/** Compte proposé pour une ligne du fichier : même nom, ou nom qui contient le libellé (« Jean-Pierre » → « Jean-Pierre Martin »). */
function guessAccount(label: string, accounts: readonly { id: string; name: string }[]): string {
  const l = normalize(label).trim();
  return (accounts.find((a) => normalize(a.name) === l) ?? accounts.find((a) => normalize(a.name).includes(l) || l.includes(normalize(a.name))))?.id ?? '';
}

async function readDraft(workspaceId: string, draftId: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await mediaStore().read(draftKey(workspaceId, draftId)));
  } catch {
    return null;
  }
}

/** PLA-05 : import d'un CSV (export d'un Google Sheet ou d'Excel), avec aperçu et choix du compte de chaque ligne. */
export default async function ImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  const role = await asUser(database(), userId, (trx) => workspaceRole(trx, userId, workspaceId));
  if (role === null) notFound();
  const canEdit = canManageContent(role);
  const accounts = (await listWorkspaceAccounts(database(), userId, workspaceId)).map((a) => ({ id: a.id, name: a.name }));
  const fromWizard = query['depuis'] === 'demarrage';
  const draftId = typeof query['brouillon'] === 'string' && UUID.test(query['brouillon']) ? query['brouillon'] : null;
  const kind = query['type'] === 'banque' ? 'banque' : 'planning';
  const year = Number.parseInt(typeof query['annee'] === 'string' ? query['annee'] : '', 10) || new Date().getFullYear();
  const csv = canEdit && draftId !== null ? await readDraft(workspaceId, draftId) : null;
  const table = csv === null ? null : parseCsv(csv);
  const layout = table !== null && kind === 'planning' ? readPamLayout(table, year) : null;
  const subjects = table !== null && kind === 'banque' ? readSubjectSheet(table) : null;

  return (
    <>
      <PlanningBack workspaceId={workspaceId} />
      <h1>Importer un planning</h1>
      <Flash code={query['message']} />
      {!canEdit && <p>Seuls les administrateurs et les éditeurs peuvent importer un planning.</p>}

      {canEdit && csv === null && (
        <form action={previewImportAction.bind(null, workspaceId)} className="stack">
          <p className="hint">
            Dans Google Sheets : Fichier › Télécharger › Valeurs séparées par des virgules (.csv), onglet par onglet. Dans Excel : Enregistrer sous › CSV.
          </p>
          <fieldset>
            <legend>Contenu du fichier</legend>
            <label className="check">
              <input type="radio" name="type" value="planning" defaultChecked /> Planning : une ligne par compte, une colonne par semaine
            </label>
            <label className="check">
              <input type="radio" name="type" value="banque" /> Banque de sujets : une ligne par sujet (onglets « Edito »)
            </label>
          </fieldset>
          {fromWizard && <input type="hidden" name="depuis" value="demarrage" />}
          <label htmlFor="feuille">Adresse d’une feuille Google Sheets partagée par lien</label>
          <input id="feuille" name="feuille" type="url" inputMode="url" placeholder="https://docs.google.com/spreadsheets/d/…" />
          <p className="hint">Ouvrez l’onglet à importer avant de copier l’adresse. La feuille doit être partagée « à toute personne disposant du lien », en lecture.</p>
          <label htmlFor="fichier">… ou fichier CSV</label>
          <input id="fichier" name="fichier" type="file" accept=".csv,text/csv,text/plain" />
          <label htmlFor="contenu">… ou contenu collé</label>
          <textarea id="contenu" name="contenu" rows={4} />
          <label htmlFor="annee">Année des semaines (si l’en-tête ne la donne pas)</label>
          <input id="annee" name="annee" type="number" min={2020} max={2100} defaultValue={year} />
          <button type="submit" className="primary">
            Voir l’aperçu
          </button>
        </form>
      )}

      {canEdit && draftId !== null && csv === null && <p className="flash error">Ce brouillon d’import n’existe plus. Renvoyez le fichier.</p>}

      {csv !== null && kind === 'planning' && layout === null && (
        <p className="flash error">Aucune colonne de semaine reconnue (« S47 », « 16/11 », « 2026-11-16 »…). Vérifiez le fichier.</p>
      )}

      {csv !== null && draftId !== null && layout !== null && (
        <form action={runImportAction.bind(null, workspaceId, draftId, 'planning', year)} className="stack">
          {fromWizard && <input type="hidden" name="depuis" value="demarrage" />}
          <p>
            {layout.weekColumns.length} semaines reconnues, du {mondayLabel(layout.weekColumns[0]?.weekStart ?? '')} au{' '}
            {mondayLabel(layout.weekColumns.at(-1)?.weekStart ?? '')}. Choisissez à quoi correspond chaque ligne.
          </p>
          {layout.rows.map((row, i) => {
            const count = row.cells.reduce((n, cell) => n + subjectsOfCell(cell).length, 0);
            return (
              <div key={row.label} className="card">
                <label htmlFor={`ligne-${i}`}>
                  {row.label} <small className="muted">· {count} sujet{count > 1 ? 's' : ''}</small>
                </label>
                <select id={`ligne-${i}`} name={`ligne-${i}`} defaultValue={guessAccount(row.label, accounts) || 'ignorer'}>
                  <option value="ignorer">Ne pas importer</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      Compte : {a.name}
                    </option>
                  ))}
                  <option value="evenement">Ligne d’événements</option>
                  <option value="canal">Autre canal</option>
                </select>
              </div>
            );
          })}
          <button type="submit" className="primary">
            Importer
          </button>
          <p className="hint">Un sujet déjà présent dans la même case n’est pas recréé : vous pouvez relancer l’import d’un fichier mis à jour.</p>
        </form>
      )}

      {csv !== null && kind === 'banque' && subjects === null && <p className="flash error">Aucune colonne « Sujet » trouvée. Vérifiez l’en-tête du fichier.</p>}

      {csv !== null && draftId !== null && subjects !== null && (
        <form action={runImportAction.bind(null, workspaceId, draftId, 'banque', year)} className="stack">
          {fromWizard && <input type="hidden" name="depuis" value="demarrage" />}
          <p>
            {subjects.length} sujet{subjects.length > 1 ? 's' : ''} reconnu{subjects.length > 1 ? 's' : ''}, dont {subjects.filter((s) => s.published).length} déjà publié
            {subjects.filter((s) => s.published).length > 1 ? 's' : ''}.
          </p>
          <ul className="plain">
            {subjects.slice(0, 5).map((s) => (
              <li key={s.sourceRef}>{s.subject}</li>
            ))}
            {subjects.length > 5 && <li className="muted">…</li>}
          </ul>
          <label htmlFor="compte">Banque du compte</label>
          <select id="compte" name="compte" defaultValue="">
            <option value="">Commune à tous les comptes</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button type="submit" className="primary">
            Importer
          </button>
        </form>
      )}
    </>
  );
}
