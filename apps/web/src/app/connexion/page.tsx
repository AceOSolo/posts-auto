import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Flash } from '../../components/flash.tsx';
import { currentUserId } from '../../server/session.ts';
import { requestLink } from './actions.ts';

export const metadata: Metadata = { title: 'Connexion' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if ((await currentUserId()) !== null) redirect('/');
  const { message } = await searchParams;
  return (
    <main className="narrow">
      <h1>Connexion</h1>
      <p className="muted">Recevez un lien de connexion par e-mail : pas de mot de passe à retenir.</p>
      <Flash code={message} />
      <form action={requestLink} className="stack">
        <label htmlFor="email">Adresse e-mail professionnelle</label>
        <input id="email" name="email" type="email" autoComplete="email" inputMode="email" required />
        <button type="submit" className="primary">
          Recevoir mon lien
        </button>
      </form>
    </main>
  );
}
