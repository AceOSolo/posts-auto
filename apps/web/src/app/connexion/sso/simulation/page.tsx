import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const metadata: Metadata = { title: 'Connexion simulée' };
export const dynamic = 'force-dynamic';

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '');

/** Remplace Google ou Microsoft en développement (SSO_MODE=fake). Introuvable sinon. */
export default async function SsoSimulationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env['SSO_MODE'] !== 'fake') notFound();
  const query = await searchParams;
  const retour = one(query['retour']);
  // Le retour ne peut viser que la route de retour de cette application.
  const path = retour.startsWith('http') ? new URL(retour).pathname : '';
  if (!/^\/connexion\/sso\/(google|microsoft)\/retour$/.test(path)) notFound();
  return (
    <main className="narrow">
      <h1>Connexion {one(query['fournisseur']) === 'microsoft' ? 'Microsoft' : 'Google'} (simulation)</h1>
      <p className="hint">En production, cette page est celle du fournisseur. L’adresse saisie ici est considérée comme vérifiée.</p>
      <form action={path} method="get" className="stack">
        <input type="hidden" name="state" value={one(query['state'])} />
        <label htmlFor="code">Adresse du compte (préfixée « fake- »)</label>
        <input id="code" name="code" defaultValue="fake-" required />
        <button type="submit" className="primary">
          Continuer
        </button>
      </form>
    </main>
  );
}
