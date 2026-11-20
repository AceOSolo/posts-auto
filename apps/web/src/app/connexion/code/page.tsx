import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Flash } from '../../../components/flash.tsx';
import { currentSession } from '../../../server/session.ts';
import { logout } from '../actions.ts';
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
    <main className="narrow">
      <h1>Code de vérification</h1>
      <Flash code={message} />
      <p>Saisissez le code à 6 chiffres affiché par votre application d’authentification.</p>
      <form action={verifyCodeAction} className="stack">
        <label htmlFor="code">Code</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}|[A-Za-z0-9-]{10,11}" required autoFocus />
        <button type="submit" className="primary">
          Vérifier
        </button>
      </form>
      <p className="hint">Téléphone perdu ? Saisissez l’un de vos codes de secours à la place (chacun ne sert qu’une fois).</p>
      <form action={logout}>
        <button type="submit" className="link">
          Annuler et se déconnecter
        </button>
      </form>
    </main>
  );
}
