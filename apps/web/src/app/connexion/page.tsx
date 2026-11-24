import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Flash } from '../../components/flash.tsx';
import { ssoProviders } from '../../server/context.ts';
import { currentUserId } from '../../server/session.ts';
import { requestLink } from './actions.ts';
import { AuthShell, SsoIcon } from './auth-shell.tsx';
import styles from './connexion.module.css';

export const metadata: Metadata = { title: 'Connexion' };
// Les fournisseurs de connexion proposés dépendent de la configuration du serveur.
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if ((await currentUserId()) !== null) redirect('/');
  const { message } = await searchParams;

  // Lien demandé : un seul message à lire, sans le formulaire. Le texte ne dit pas si l'adresse existe.
  if (message === 'envoye') {
    return (
      <AuthShell title="Regardez votre boîte mail">
        <Flash code={message} />
        <p className={styles.note}>Rien reçu ? Pensez à vérifier vos indésirables.</p>
        <Link href="/connexion" className={`button ${styles.actionSecondaire}`}>
          Utiliser une autre adresse
        </Link>
      </AuthShell>
    );
  }

  const providers = ssoProviders();
  return (
    <AuthShell
      title="Connexion"
      intro="Recevez un lien par e-mail, sans mot de passe."
      footer={
        <p>
          Pas encore de compte ? <Link href="/inscription">Essayer gratuitement</Link>
        </p>
      }
    >
      <Flash code={message} />
      <form action={requestLink} className={styles.formulaire}>
        <label htmlFor="email">Adresse e-mail professionnelle</label>
        <input id="email" name="email" type="email" autoComplete="email" inputMode="email" placeholder="vous@entreprise.fr" required />
        <button type="submit" className="primary">
          Recevoir mon lien
        </button>
      </form>
      {/* ONB-01 : connexion avec Google ou Microsoft, pour un compte existant. */}
      {providers.length > 0 && (
        <>
          <p className={styles.separateur}>ou continuer avec</p>
          <div className={styles.sso}>
            {providers.map((p) => (
              <a key={p.key} href={`/connexion/sso/${p.key}`} className="button" aria-label={`Se connecter avec ${p.label}`}>
                <SsoIcon provider={p.key} />
                {p.label}
              </a>
            ))}
          </div>
          <p className={styles.note}>Première connexion ? Passez par le lien e-mail ou par votre invitation.</p>
        </>
      )}
    </AuthShell>
  );
}
