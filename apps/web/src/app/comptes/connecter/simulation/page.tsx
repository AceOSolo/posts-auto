import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const metadata: Metadata = { title: 'LinkedIn (simulation)' };
export const dynamic = 'force-dynamic';

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '');

/**
 * Remplace l'écran d'autorisation de LinkedIn en développement (LINKEDIN_MODE=fake). Le
 * formulaire classique provoque une vraie navigation, comme le retour de LinkedIn en
 * production : la page des comptes s'affiche ensuite. Introuvable hors simulation.
 */
export default async function LinkedInSimulationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env['LINKEDIN_MODE'] !== 'fake') notFound();
  const query = await searchParams;
  const code = one(query['code']);
  const state = one(query['state']);
  if (!code.startsWith('fake-') || state === '') notFound();
  return (
    <main className="narrow">
      <h1>Autoriser Rostra sur LinkedIn (simulation)</h1>
      <p className="hint">En production, cet écran est celui de LinkedIn. Ici, rien n’est envoyé à LinkedIn.</p>
      <form action="/comptes/connecter/retour" method="get" className="stack">
        <input type="hidden" name="code" value={code} />
        <input type="hidden" name="state" value={state} />
        <button type="submit" className="primary">
          Autoriser
        </button>
      </form>
    </main>
  );
}
