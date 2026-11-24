import { mfaStatus, revokeAllSessions } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Flash } from '../../../components/flash.tsx';
import { PageHeader } from '../../../components/page-header.tsx';
import { database } from '../../../server/context.ts';
import { clearSessionCookie, requireUserId } from '../../../server/session.ts';
import styles from './moi.module.css';

export const metadata: Metadata = { title: 'Mon compte' };

async function signOutEverywhere(): Promise<void> {
  'use server';
  const userId = await requireUserId();
  await revokeAllSessions(database(), userId, new Date());
  await clearSessionCookie();
  redirect('/connexion');
}

/** Sécurité (SEC-03, SEC-04) et mes données (RGPD, section 10.2). */
export default async function MePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const userId = await requireUserId();
  const { message } = await searchParams;
  const mfa = await mfaStatus(database(), userId, new Date());
  return (
    <>
      <PageHeader title="Mon compte" />
      <Flash code={message} />
      <ul className={styles.list}>
        <li className={styles.row}>
          <div className={styles.text}>
            <h2>Double authentification</h2>
            <p>{mfa.enabled ? 'Activée : un code vous est demandé à chaque connexion.' : 'Non activée : ajoutez un code sur votre téléphone pour protéger votre compte.'}</p>
          </div>
          <Link href="/securite" className={mfa.enabled ? 'button' : 'button primary'}>
            {mfa.enabled ? 'Gérer' : 'Activer'}
          </Link>
        </li>
        <li className={styles.row}>
          <div className={styles.text}>
            <h2>Mes appareils</h2>
            <p>Un téléphone perdu ou un ordinateur partagé ? Fermez toutes vos sessions.</p>
          </div>
          <form action={signOutEverywhere}>
            <button type="submit">Déconnecter tous mes appareils</button>
          </form>
        </li>
        <li className={styles.row}>
          <div className={styles.text}>
            <h2>Mes données</h2>
            <p>Une archive de tout ce qui vous concerne : profil, posts, images, décisions et consentements.</p>
          </div>
          <a href="/moi/export" className="button" download>
            Télécharger mes données
          </a>
        </li>
      </ul>
      <p className="hint">Pour faire supprimer votre compte, adressez-vous à l’administrateur de votre espace.</p>
    </>
  );
}
