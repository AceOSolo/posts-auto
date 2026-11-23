import { addDays } from '@posts-auto/core';
import { type BankSubject, NotFoundError, listSubjects, listWorkspaceAccounts, planningGrid } from '@posts-auto/services';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../../components/flash.tsx';
import { database } from '../../../../../server/context.ts';
import { requireUserId } from '../../../../../server/session.ts';
import { deleteSubjectAction, placeSubjectAction, saveSubjectAction } from '../../actions.ts';
import { PlanningBack, mondayLabel } from '../../planning-ui.tsx';

export const metadata: Metadata = { title: 'Banque de sujets' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Semaines proposées pour placer un sujet dans le planning. */
const PLACE_WEEKS = 8;

function SubjectFields({ subject, accounts }: { subject?: BankSubject; accounts: readonly { id: string; name: string }[] }) {
  const p = subject?.id ?? 'nouveau';
  return (
    <>
      <label htmlFor={`sujet-${p}`}>Sujet</label>
      <input id={`sujet-${p}`} name="sujet" required maxLength={500} defaultValue={subject?.subject ?? ''} />
      <label htmlFor={`compte-${p}`}>Compte</label>
      <select id={`compte-${p}`} name="compte" defaultValue={subject?.accountId ?? ''}>
        <option value="">Commun à tous les comptes</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <label htmlFor={`theme-${p}`}>Thème</label>
      <input id={`theme-${p}`} name="theme" maxLength={200} defaultValue={subject?.theme ?? ''} />
      <label htmlFor={`angle-${p}`}>Angle</label>
      <input id={`angle-${p}`} name="angle" maxLength={500} defaultValue={subject?.angle ?? ''} />
      <label htmlFor={`format-${p}`}>Format</label>
      <input id={`format-${p}`} name="format" maxLength={100} defaultValue={subject?.format ?? ''} />
      <label htmlFor={`offre-${p}`}>Offre</label>
      <input id={`offre-${p}`} name="offre" maxLength={200} defaultValue={subject?.offer ?? ''} />
      <label htmlFor={`cible-${p}`}>Cible</label>
      <input id={`cible-${p}`} name="cible" maxLength={200} defaultValue={subject?.audience ?? ''} />
      <label className="check">
        <input type="checkbox" name="publie" defaultChecked={subject?.published ?? false} /> Déjà publié
      </label>
    </>
  );
}

/** PLA-03 : banque de sujets par compte, et placement d'un sujet dans le planning. */
export default async function SubjectBankPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { message, compte } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  const accountId = typeof compte === 'string' && UUID.test(compte) ? compte : undefined;
  let data;
  try {
    data = await Promise.all([
      listSubjects(database(), userId, workspaceId, accountId),
      listWorkspaceAccounts(database(), userId, workspaceId),
      planningGrid(database(), userId, workspaceId, { weeks: 1 }, new Date()),
    ]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const [{ subjects, canEdit }, accountList, { currentWeek }] = data;
  const accounts = accountList.map((a) => ({ id: a.id, name: a.name }));
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
  const weeks = Array.from({ length: PLACE_WEEKS }, (_, i) => addDays(currentWeek, 7 * i));

  return (
    <>
      <PlanningBack workspaceId={workspaceId} />
      <h1>Banque de sujets</h1>
      <Flash code={message} />
      <p className="hint">L’IA y puise quand le planning, les événements et les idées de l’équipe ne remplissent pas toutes les semaines.</p>

      <form method="get" className="inline">
        <label htmlFor="filtre">Compte</label>
        <select id="filtre" name="compte" defaultValue={accountId ?? ''}>
          <option value="">Tous</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button type="submit">Filtrer</button>
      </form>

      <section aria-label="Sujets" id="banque">
        {subjects.length === 0 && <p className="muted">Aucun sujet dans la banque.</p>}
        <ul className="cards">
          {subjects.map((s) => (
            <li key={s.id} className="card">
              <p>
                <strong>{s.subject}</strong>
              </p>
              <p className="muted">
                {s.accountId === null ? 'Commun à tous les comptes' : nameOf.get(s.accountId)}
                {s.theme && ` · ${s.theme}`}
                {s.angle && ` · angle : ${s.angle}`}
                {s.published && ' · déjà publié'}
                {s.used && ' · déjà rédigé'}
              </p>
              {canEdit && (
                <div className="stack">
                  <details>
                    <summary>Placer dans le planning</summary>
                    <form action={placeSubjectAction.bind(null, workspaceId, s.id)} className="stack">
                      <label htmlFor={`placer-compte-${s.id}`}>Compte</label>
                      <select id={`placer-compte-${s.id}`} name="compte" defaultValue={s.accountId ?? accounts[0]?.id ?? ''}>
                        {(s.accountId === null ? accounts : accounts.filter((a) => a.id === s.accountId)).map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                      <label htmlFor={`placer-semaine-${s.id}`}>Semaine</label>
                      <select id={`placer-semaine-${s.id}`} name="semaine" defaultValue={weeks[1]}>
                        {weeks.map((w) => (
                          <option key={w} value={w}>
                            Semaine du {mondayLabel(w)}
                          </option>
                        ))}
                      </select>
                      <button type="submit">Placer</button>
                    </form>
                  </details>
                  <details>
                    <summary>Modifier</summary>
                    <form action={saveSubjectAction.bind(null, workspaceId, s.id)} className="stack">
                      <SubjectFields subject={s} accounts={accounts} />
                      <button type="submit">Enregistrer</button>
                    </form>
                  </details>
                  <form action={deleteSubjectAction.bind(null, workspaceId, s.id)}>
                    <button type="submit">Supprimer</button>
                  </form>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {canEdit && (
        <details open={subjects.length === 0}>
          <summary>Ajouter un sujet</summary>
          <form action={saveSubjectAction.bind(null, workspaceId, null)} className="stack">
            <SubjectFields accounts={accounts} />
            <button type="submit" className="primary">
              Ajouter
            </button>
          </form>
        </details>
      )}
    </>
  );
}
