import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../../components/flash.tsx';
import { requireUserId } from '../../../../../server/session.ts';
import { startConnection } from '../../actions.ts';

export const metadata: Metadata = { title: 'Connecter mon profil LinkedIn' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Consentement avant la connexion (LNK-09) : publication en son nom et conservation du
 * profil (nécessaires), apprentissage (facultatif). Adhésion volontaire (section 10.2) et
 * transparence sur l'IA (GEN-12, politique IA de LinkedIn).
 */
export default async function ConnectPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { message } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  await requireUserId();

  return (
    <>
      <p>
        <Link href={`/comptes/${workspaceId}`}>← Comptes LinkedIn</Link>
      </p>
      <h1>Connecter mon profil LinkedIn</h1>
      <Flash code={message} />
      <section className="card">
        <h2>Ce que vous acceptez</h2>
        <ul>
          <li>
            <strong>Publication en votre nom.</strong> Des posts préparés avec l’aide de l’IA vous sont proposés. Ils ne partent sur votre profil
            qu’après validation, par vous ou par une personne que l’administrateur de l’espace a désignée, au créneau indiqué. Vous pouvez toujours les
            corriger, les refuser ou retirer une validation avant le départ.
          </li>
          <li>
            <strong>Conservation de votre profil.</strong> Seuls votre identifiant LinkedIn, votre nom et votre photo sont conservés, pour afficher
            vos posts. Aucune autre donnée de votre profil n’est lue.
          </li>
          <li>
            <strong>Adhésion volontaire.</strong> Connecter votre profil n’est pas une obligation, et refuser n’a aucune conséquence. Vous pouvez
            déconnecter votre profil à tout moment depuis la page des comptes.
          </li>
        </ul>
      </section>
      <form action={startConnection.bind(null, workspaceId)} className="stack">
        <label className="check">
          <input type="checkbox" name="accord" value="oui" required /> J’accepte la publication en mon nom et la conservation de mon profil, comme
          décrit ci-dessus.
        </label>
        <label className="check">
          <input type="checkbox" name="apprentissage" value="oui" /> Facultatif : j’accepte que mes corrections et les statistiques de mes posts servent
          à améliorer les textes qui me sont proposés.
        </label>
        <button type="submit" className="primary">
          Continuer vers LinkedIn
        </button>
      </form>
    </>
  );
}
