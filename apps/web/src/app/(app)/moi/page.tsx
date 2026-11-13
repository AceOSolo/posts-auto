import { revokeAllSessions } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Flash } from '../../../components/flash.tsx';
import { database } from '../../../server/context.ts';
import { clearSessionCookie, requireUserId } from '../../../server/session.ts';

export const metadata: Metadata = { title: 'Mon compte' };

async function signOutEverywhere(): Promise<void> {
  'use server';
  const userId = await requireUserId();
  await revokeAllSessions(database(), userId, new Date());
  await clearSessionCookie();
  redirect('/connexion');
}

/** Mes données (RGPD, section 10.2) et mes sessions (SEC-03). */
export default async function MePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUserId();
  const { message } = await searchParams;
  return (
    <>
      <h1>Mon compte</h1>
      <Flash code={message} />
      <section className="card">
        <h2>Mes données</h2>
        <p>
          Téléchargez une archive de toutes les données vous concernant : profil, espaces, comptes LinkedIn, posts et leurs images, décisions,
          consentements, notifications, sessions et journal de vos actions.
        </p>
        <p>
          <a href="/moi/export" className="button" download>
            Télécharger mes données
          </a>
        </p>
        <p className="hint">Pour faire supprimer votre compte, adressez-vous à l’administrateur de votre espace.</p>
      </section>
      <section className="card">
        <h2>Sécurité</h2>
        <p>Vous avez perdu un téléphone, ou vous vous êtes connecté sur un ordinateur partagé ?</p>
        <form action={signOutEverywhere}>
          <button type="submit">Déconnecter tous mes appareils</button>
        </form>
      </section>
      <p>
        <Link href="/notifications">Régler mes notifications</Link>
      </p>
    </>
  );
}
