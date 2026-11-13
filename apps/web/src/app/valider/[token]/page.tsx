import { confirmApprovalLink, previewApprovalLink } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PostPreview } from '../../../components/post-preview.tsx';
import { database } from '../../../server/context.ts';

export const metadata: Metadata = { title: 'Valider un post' };
export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;

const RESULTS: Record<string, string> = {
  valide: 'Post validé. Il partira à son créneau.',
  'valide-maintenant': 'Post validé : il part dans les minutes qui viennent.',
  lien_invalide: 'Ce lien n’est plus valable : il a déjà servi ou a expiré.',
  deja_traite: 'Ce post a déjà été traité : rien n’a été modifié.',
  a_completer: 'Ce post contient un passage à compléter : ouvrez-le pour le terminer avant de valider.',
  plus_autorise: 'Vous ne pouvez plus valider ce post (droits modifiés entre-temps).',
  refuse: 'La validation n’a pas pu être enregistrée. Ouvrez le post pour en savoir plus.',
};

async function confirm(token: string): Promise<void> {
  'use server';
  if (!TOKEN.test(token)) redirect('/valider/resultat?r=lien_invalide');
  const outcome = await confirmApprovalLink(database(), token, new Date());
  redirect(`/valider/resultat?r=${outcome.ok ? (outcome.departsNow ? 'valide-maintenant' : 'valide') : outcome.reason}`);
}

/**
 * VAL-06 : page ouverte depuis l'e-mail, sans connexion. Elle montre le post et ne valide
 * qu'au clic sur « Confirmer » : un antivirus qui ouvre le lien ne valide rien (REC-14).
 */
export default async function ApprovalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const { r } = await searchParams;
  if (token === 'resultat') {
    const text = typeof r === 'string' ? RESULTS[r] : undefined;
    return (
      <main className="narrow">
        <h1>Validation</h1>
        <p className={`flash ${r === 'valide' || r === 'valide-maintenant' ? 'success' : 'error'}`} role="status">
          {text ?? RESULTS['lien_invalide']}
        </p>
        <p>
          <Link href="/">Ouvrir mes posts</Link>
        </p>
      </main>
    );
  }

  const preview = TOKEN.test(token) ? await previewApprovalLink(database(), token, new Date()) : null;
  if (preview === null) {
    return (
      <main className="narrow">
        <h1>Lien expiré</h1>
        <p>{RESULTS['lien_invalide']}</p>
        <p>
          <Link href="/">Ouvrir mes posts</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Valider ce post ?</h1>
      <p className="departure">{preview.departure}</p>
      <PostPreview accountName={preview.accountName} accountKind="profile" body={preview.body} media={[]} expanded />
      <p className="ai-note">Texte préparé avec l’aide de l’IA : vérifiez les faits, chiffres et noms avant de valider.</p>
      {!preview.pending ? (
        <p className="flash error">{RESULTS['deja_traite']}</p>
      ) : preview.hasBlockingMarkers ? (
        <p className="flash error">{RESULTS['a_completer']}</p>
      ) : (
        <form action={confirm.bind(null, token)}>
          <button type="submit" className="primary">
            Confirmer la validation
          </button>
        </form>
      )}
      <p>
        <Link href={`/posts/${preview.postId}`}>Voir, corriger ou refuser dans l’application</Link>
      </p>
    </main>
  );
}
