import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { confirmLogin } from '../actions.ts';
import { AuthShell } from '../auth-shell.tsx';
import styles from '../connexion.module.css';

export const metadata: Metadata = { title: 'Connexion' };

/**
 * Page ouverte depuis l'e-mail. Elle ne consomme pas le lien : les antivirus de messagerie
 * ouvrent les liens automatiquement. Seul le clic sur « Se connecter » ouvre la session.
 */
export default async function LoginLinkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { jeton } = await searchParams;
  if (typeof jeton !== 'string' || jeton.length < 20) redirect('/connexion?message=lien');
  return (
    <AuthShell title="Plus qu’un clic" intro="Cliquez pour ouvrir votre session sur cet appareil.">
      <form action={confirmLogin} className={styles.formulaire}>
        <input type="hidden" name="jeton" value={jeton} />
        <button type="submit" className="primary">
          Se connecter
        </button>
      </form>
    </AuthShell>
  );
}
