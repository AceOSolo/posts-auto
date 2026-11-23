import { parseCron } from '@posts-auto/core';
import { NotFoundError, generationStatus } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../../components/flash.tsx';
import { database } from '../../../../../server/context.ts';
import { requireUserId } from '../../../../../server/session.ts';
import { configureGenerationAction, requestGenerationAction } from '../../actions.ts';

export const metadata: Metadata = { title: 'Rédaction' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEEKDAYS = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Paris' });
const euros = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const STATUS: Record<string, string> = { running: 'En cours', done: 'Terminée', failed: 'Interrompue' };

/** GEN-01 : lancer et programmer la rédaction ; GEN-05 : rapports ; GEN-11 : coût de l'IA. */
export default async function GenerationPage({
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
  let status;
  try {
    status = await generationStatus(database(), userId, workspaceId, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const schedule = parseCron(status.cron);
  const day = schedule && schedule.daysOfWeek.size === 1 ? [...schedule.daysOfWeek][0] : 1;
  const hour = schedule && schedule.hours.size === 1 ? [...schedule.hours][0] : 7;
  const minute = schedule && schedule.minutes.size === 1 ? [...schedule.minutes][0] : 30;
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const pending = status.requestedAt !== null && !status.running;

  return (
    <>
      <h1>Rédaction par l’IA</h1>
      <Flash code={message} />
      <p className="hint">
        La rédaction prépare un post par créneau sur la semaine en cours et la suivante, à partir du planning, des événements, des idées et de
        la banque de sujets. Les posts déjà validés ne sont jamais modifiés. <Link href="/comment-fonctionne-la-redaction">En savoir plus</Link>
      </p>

      <section aria-labelledby="lancer">
        <h2 id="lancer">Lancer</h2>
        {status.running && <p className="flash success">Une rédaction est en cours : les posts arrivent au fil de l’eau.</p>}
        {pending && <p className="flash success">Rédaction demandée : elle démarre dans les 5 minutes.</p>}
        {status.canLaunch && !status.running && !pending && (
          <form action={requestGenerationAction.bind(null, workspaceId)}>
            <button type="submit" className="primary">
              Lancer la rédaction maintenant
            </button>
          </form>
        )}
        <p className="muted">
          {status.autoGeneration && schedule
            ? `Rédaction automatique chaque ${WEEKDAYS[day ?? 1]} à ${time.replace(':', 'h')}.`
            : 'Rédaction automatique désactivée : la rédaction se lance avec le bouton.'}
        </p>
      </section>

      {status.canConfigure && (
        <details>
          <summary>Programmer la rédaction automatique</summary>
          <form action={configureGenerationAction.bind(null, workspaceId)} className="stack">
            <label className="check">
              <input type="checkbox" name="auto" defaultChecked={status.autoGeneration} /> Rédiger automatiquement chaque semaine
            </label>
            <p className="hint">À n’activer qu’une fois l’ancien outil de rédaction arrêté, pour ne pas recevoir deux séries de posts.</p>
            <div className="inline-fields">
              <div>
                <label htmlFor="jour">Jour</label>
                <select id="jour" name="jour" defaultValue={day}>
                  {WEEKDAYS.slice(1).map((label, index) => (
                    <option key={label} value={index + 1}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="heure">Heure</label>
                <input id="heure" name="heure" type="time" step={300} defaultValue={time} required />
              </div>
            </div>
            <button type="submit">Enregistrer</button>
          </form>
        </details>
      )}

      <section aria-labelledby="cout">
        <h2 id="cout">Coût de l’IA ce mois-ci</h2>
        <p>
          {euros.format(status.month.costEur)} · {status.month.countedPosts} post{status.month.countedPosts > 1 ? 's' : ''} rédigé
          {status.month.countedPosts > 1 ? 's' : ''} (les reprises ne comptent pas)
        </p>
      </section>

      <section aria-labelledby="rapports">
        <h2 id="rapports">Dernières rédactions</h2>
        {status.runs.length === 0 && <p className="muted">Aucune rédaction pour l’instant.</p>}
        <ul className="cards">
          {status.runs.map((run) => (
            <li key={run.id} className="card">
              <p>
                <Link href={`/planning/${workspaceId}/redactions/${run.id}`}>{dateTime.format(run.startedAt)}</Link> ·{' '}
                <span className={`badge ${run.status === 'done' ? 'status-publie' : run.status === 'failed' ? 'status-erreur' : 'status-a_valider'}`}>{STATUS[run.status]}</span>
              </p>
              <p className="muted">
                {run.created} post{run.created > 1 ? 's' : ''}
                {run.withMarkers > 0 && ` · ${run.withMarkers} avec un marqueur à traiter`}
                {run.unplaced > 0 && ` · ${run.unplaced} sujet${run.unplaced > 1 ? 's' : ''} sans créneau`}
                {run.errors > 0 && ` · ${run.errors} erreur${run.errors > 1 ? 's' : ''}`}
              </p>
              {run.error && <p className="flash error">{run.error}</p>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
