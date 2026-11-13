import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { confirmLogin } from '../actions.ts';

export const metadata: Metadata = { title: 'Connexion' };

/**
 * Page ouverte depuis l'e-mail. Elle ne consomme pas le lien : les antivirus de messagerie
 * ouvrent les liens automatiquement. Seul le clic sur « Se connecter » ouvre la session.
 */
export default async function LoginLinkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { jeton } = await searchParams;
  if (typeof jeton !== 'string' || jeton.length < 20) redirect('/connexion?message=lien');
  return (
    <main className="narrow">
      <h1>Connexion</h1>
      <p>Cliquez pour ouvrir votre session sur cet appareil.</p>
      <form action={confirmLogin}>
        <input type="hidden" name="jeton" value={jeton} />
        <button type="submit" className="primary">
          Se connecter
        </button>
      </form>
    </main>
  );
}
