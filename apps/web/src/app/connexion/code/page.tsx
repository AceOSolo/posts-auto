import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Flash } from '../../../components/flash.tsx';
import { currentSession } from '../../../server/session.ts';
import { logout } from '../actions.ts';
import { AuthShell } from '../auth-shell.tsx';
import styles from '../connexion.module.css';
import { verifyCodeAction } from '../../securite/actions.ts';

export const metadata: Metadata = { title: 'Code de vérification' };
export const dynamic = 'force-dynamic';

/** SEC-04 : après le lien de connexion, le code de l'application d'authentification. */
export default async function CodePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (session === null) redirect('/connexion');
  if (!session.mfaPending) redirect('/');
  const { message } = await searchParams;
  return (
    <AuthShell
      title="Code de vérification"
      intro="Saisissez le code à 6 chiffres affiché par votre application d’authentification."
      footer={
        <form action={logout}>
          <button type="submit" className="link">
            Annuler et se déconnecter
          </button>
        </form>
      }
    >
      <Flash code={message} />
      <form action={verifyCodeAction} className={`${styles.formulaire} ${styles.champCode}`}>
        <label htmlFor="code">Code</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}|[A-Za-z0-9-]{10,11}" required autoFocus />
        <button type="submit" className="primary">
          Vérifier
        </button>
      </form>
      <p className={styles.note}>Téléphone perdu ? Saisissez l’un de vos codes de secours à la place (chacun ne sert qu’une fois).</p>
    </AuthShell>
  );
}
