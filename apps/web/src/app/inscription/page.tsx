import { TRIAL_DAYS } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Flash } from '../../components/flash.tsx';
import { currentUserId } from '../../server/session.ts';
import { requestSignupAction } from './actions.ts';

export const metadata: Metadata = { title: 'Créer un compte' };

/** ONB-01, ONB-02, ONB-06 : inscription en libre-service, essai gratuit sans carte bancaire. */
export default async function SignupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if ((await currentUserId()) !== null) redirect('/');
  const { message } = await searchParams;
  return (
    <main className="narrow">
      <h1>Créer un compte</h1>
      <p className="muted">
        Essai gratuit de {TRIAL_DAYS} jours, sans carte bancaire : jusqu’à 3 comptes LinkedIn et 10 posts rédigés par l’IA, publiés pour de vrai après votre validation.
      </p>
      <Flash code={message} />
      <form action={requestSignupAction} className="stack">
        <label htmlFor="email">Adresse e-mail professionnelle</label>
        <input id="email" name="email" type="email" autoComplete="email" inputMode="email" required />
        <label htmlFor="nom">Votre nom</label>
        <input id="nom" name="nom" autoComplete="name" maxLength={120} required />
        <label htmlFor="organisation">Nom de votre entreprise ou de votre agence</label>
        <input id="organisation" name="organisation" autoComplete="organization" maxLength={120} required />
        <fieldset className="choices">
          <legend>Vous êtes</legend>
          <label>
            <input type="radio" name="type" value="entreprise" defaultChecked /> Une entreprise : les posts de vos dirigeants, collaborateurs et pages
          </label>
          <label>
            <input type="radio" name="type" value="agence" /> Une agence : les posts de plusieurs clients, chacun dans son espace
          </label>
        </fieldset>
        <button type="submit" className="primary">
          Recevoir mon lien de confirmation
        </button>
      </form>
      <p className="hint">
        Pas de mot de passe : vous vous connectez avec un lien reçu par e-mail. Déjà un compte ? <Link href="/connexion">Se connecter</Link>
      </p>
    </main>
  );
}
