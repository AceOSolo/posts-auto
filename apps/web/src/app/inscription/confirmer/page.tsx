import { pendingSignup } from '@posts-auto/services';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { database } from '../../../server/context.ts';
import { confirmSignupAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Créer mon espace' };
export const dynamic = 'force-dynamic';

/**
 * Page ouverte depuis l'e-mail de confirmation. Elle ne crée rien : les antivirus de
 * messagerie ouvrent les liens. Seul le clic sur « Créer mon espace » crée l'organisation.
 */
export default async function ConfirmSignupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { jeton } = await searchParams;
  if (typeof jeton !== 'string' || jeton.length < 20) redirect('/inscription?message=inscription_lien');
  const pending = await pendingSignup(database(), jeton, new Date());
  if (pending === null) redirect('/inscription?message=inscription_lien');
  return (
    <main className="narrow">
      <h1>Créer mon espace</h1>
      <p>
        {pending.orgKind === 'agence' ? 'Agence' : 'Entreprise'} <strong>{pending.orgName}</strong>, compte de {pending.email}.
      </p>
      <form action={confirmSignupAction}>
        <input type="hidden" name="jeton" value={jeton} />
        <button type="submit" className="primary">
          Créer mon espace
        </button>
      </form>
    </main>
  );
}
