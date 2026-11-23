import { NotFoundError, getGenerationRun } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { database } from '../../../../../../server/context.ts';
import { requireUserId } from '../../../../../../server/session.ts';
import { mondayLabel } from '../../../planning-ui.tsx';

export const metadata: Metadata = { title: 'Rapport de rédaction' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateTime = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
const ORIGINS: Record<string, string> = {
  planning: 'Planning',
  event: 'Événement',
  team_idea: 'Idée de l’équipe',
  ai_idea: 'Idée de l’IA',
  ai_reserve: 'Réserve',
  request: 'Demande',
  external_source: 'Source externe',
};
const UNPLACED: Record<string, string> = { no_slot: 'aucun créneau libre', account_inactive: 'compte déconnecté ou en pause' };

interface ReportPost {
  postId: string;
  accountName: string;
  origin: string;
  subject: string;
  at: string;
  replaced: string | null;
  corrected: string[];
  remaining: string[];
  warnings: string[];
  suspiciousInstructions: string[];
}

const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** GEN-05, GEN-13 : ce que la rédaction a fait, corrigé, laissé à vérifier, et les consignes cachées repérées. */
export default async function GenerationReportPage({ params }: { params: Promise<{ workspaceId: string; runId: string }> }) {
  const { workspaceId, runId } = await params;
  if (!UUID.test(workspaceId) || !UUID.test(runId)) notFound();
  const userId = await requireUserId();
  let run;
  try {
    run = await getGenerationRun(database(), userId, workspaceId, runId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const posts = list<ReportPost>(run.report['posts']);
  const unplaced = list<{ kind: string; label: string; accountName: string | null; weekStart: string | null; reason: string }>(run.report['unplaced']);
  const errors = list<{ accountName: string; subject: string; message: string }>(run.report['errors']);
  const toCheck = posts.filter((p) => p.remaining.length > 0);
  const suspicious = posts.filter((p) => p.suspiciousInstructions.length > 0);

  return (
    <>
      <p>
        <Link href={`/planning/${workspaceId}/redactions`}>← Rédaction</Link>
      </p>
      <h1>Rapport de rédaction</h1>
      <p className="muted">
        {dateTime.format(run.startedAt)} · semaines du {run.weeks.map(mondayLabel).join(' et du ')} · modèle {run.model ?? 'inconnu'}, consignes{' '}
        {run.promptVersion ?? '?'}
      </p>
      {run.error && <p className="flash error">Rédaction interrompue : {run.error}</p>}

      {toCheck.length > 0 && (
        <section aria-labelledby="a-verifier">
          <h2 id="a-verifier">À vérifier avant publication</h2>
          <p className="hint">La relecture a trouvé un problème que la correction n’a pas réglé : le post porte un marqueur [À VÉRIFIER].</p>
          <ul className="cards">
            {toCheck.map((p) => (
              <li key={p.postId} className="card">
                <Link href={`/posts/${p.postId}`}>
                  {p.accountName} · {p.subject}
                </Link>
                <ul>
                  {p.remaining.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      {suspicious.length > 0 && (
        <section aria-labelledby="consignes">
          <h2 id="consignes">Consignes cachées repérées et ignorées</h2>
          <p className="hint">Ces phrases, trouvées dans des contenus externes, s’adressaient à l’IA. Elles n’ont pas été appliquées.</p>
          <ul className="cards">
            {suspicious.map((p) => (
              <li key={p.postId} className="card">
                <Link href={`/posts/${p.postId}`}>
                  {p.accountName} · {p.subject}
                </Link>
                <ul>
                  {p.suspiciousInstructions.map((s) => (
                    <li key={s}>« {s} »</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unplaced.length > 0 && (
        <section aria-labelledby="sans-creneau">
          <h2 id="sans-creneau">Sujets sans créneau</h2>
          <ul>
            {unplaced.map((u, i) => (
              <li key={i}>
                {u.label || 'Créneau du rythme'} {u.accountName && `· ${u.accountName}`} {u.weekStart && `· semaine du ${mondayLabel(u.weekStart)}`} :{' '}
                {UNPLACED[u.reason] ?? u.reason}
              </li>
            ))}
          </ul>
        </section>
      )}

      {errors.length > 0 && (
        <section aria-labelledby="erreurs">
          <h2 id="erreurs">Posts non rédigés</h2>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>
                {e.accountName} · {e.subject} : {e.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="rediges">
        <h2 id="rediges">Posts rédigés ({posts.length})</h2>
        <ul className="cards">
          {posts.map((p) => (
            <li key={p.postId} className="card">
              <p>
                <span className="badge">{ORIGINS[p.origin] ?? p.origin}</span> <Link href={`/posts/${p.postId}`}>{p.subject}</Link>
              </p>
              <p className="muted">
                {p.accountName} · {dateTime.format(new Date(p.at))}
                {p.replaced && ' · remplace un post moins prioritaire'}
                {p.corrected.length > 0 && ` · ${p.corrected.length} problème${p.corrected.length > 1 ? 's' : ''} corrigé${p.corrected.length > 1 ? 's' : ''} à la relecture`}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
