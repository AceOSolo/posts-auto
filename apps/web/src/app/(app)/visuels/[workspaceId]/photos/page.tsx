import { LIBRARY_MAX_UPLOAD, NotFoundError, listLibrary } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../../components/flash.tsx';
import { database } from '../../../../../server/context.ts';
import { requireUserId } from '../../../../../server/session.ts';
import { addLibraryAction, removeLibraryAction, updateLibraryAction } from '../../actions.ts';

export const metadata: Metadata = { title: 'Médiathèque' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** VIS-08 : photos de l'entreprise, classées par dossier et mots-clés ; l'IA peut les choisir. */
export default async function LibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const folder = typeof query['dossier'] === 'string' ? query['dossier'] : null;
  const tag = typeof query['mot'] === 'string' ? query['mot'] : null;
  const userId = await requireUserId();
  let library;
  try {
    library = await listLibrary(database(), userId, workspaceId, { folder, tag });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const base = `/visuels/${workspaceId}/photos`;
  const filtered = folder !== null || tag !== null;

  return (
    <>
      <p>
        <Link href={`/visuels/${workspaceId}`}>← Visuels</Link>
      </p>
      <h1>Médiathèque</h1>
      <Flash code={query['message']} />
      <p className="hint">
        Les photos de l’entreprise : chantiers, équipes, locaux, événements. Pour illustrer un post, l’IA choisit une de ces photos quand son nom, son dossier ou ses mots-clés
        correspondent au sujet ; sinon, elle fait générer une image. Des noms et mots-clés précis l’aident à bien choisir.
      </p>

      {library.canAdd && (
        <form action={addLibraryAction.bind(null, workspaceId)} className="stack">
          <label htmlFor="photos">Ajouter des photos (JPG, PNG ou GIF, 10 Mo au plus chacune, {LIBRARY_MAX_UPLOAD} à la fois)</label>
          <input id="photos" name="photos" type="file" accept="image/jpeg,image/png,image/gif" multiple required />
          <label htmlFor="dossier">Dossier (facultatif)</label>
          <input id="dossier" name="dossier" list="dossiers" maxLength={60} placeholder="Ex. : Chantiers" />
          <datalist id="dossiers">
            {library.folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <label htmlFor="mots-cles">Mots-clés, séparés par des virgules (facultatif)</label>
          <input id="mots-cles" name="mots-cles" maxLength={400} placeholder="Ex. : échafaudage, équipe, casque" />
          <button type="submit" className="primary">
            Ajouter à la médiathèque
          </button>
        </form>
      )}

      {(library.folders.length > 0 || library.tags.length > 0) && (
        <nav aria-label="Filtrer les photos" className="filters">
          {filtered && <Link href={base}>Toutes les photos</Link>}
          {library.folders.map((f) => (
            <Link key={`d-${f}`} href={`${base}?dossier=${encodeURIComponent(f)}`} aria-current={folder === f ? 'page' : undefined}>
              📁 {f}
            </Link>
          ))}
          {library.tags.map((t) => (
            <Link key={`m-${t}`} href={`${base}?mot=${encodeURIComponent(t)}`} aria-current={tag === t ? 'page' : undefined}>
              #{t}
            </Link>
          ))}
        </nav>
      )}

      {library.photos.length === 0 ? (
        <p>{filtered ? 'Aucune photo pour ce filtre.' : 'La médiathèque est vide.'}</p>
      ) : (
        <ul className="library-grid">
          {library.photos.map((photo) => (
            <li key={photo.id} id={`photo-${photo.id}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- images privées servies par /media */}
              <img src={`/media/${photo.id}`} alt={photo.label ?? 'Photo de la médiathèque'} width={200} height={150} loading="lazy" />
              <strong>{photo.label ?? 'Sans nom'}</strong>
              <span className="hint">
                {photo.folder ?? 'Sans dossier'}
                {photo.tags.length > 0 && ` · ${photo.tags.join(', ')}`}
              </span>
              {photo.canEdit && (
                <details>
                  <summary>Classer</summary>
                  <form action={updateLibraryAction.bind(null, workspaceId, photo.id)} className="stack">
                    <label htmlFor={`nom-${photo.id}`}>Nom</label>
                    <input id={`nom-${photo.id}`} name="nom" defaultValue={photo.label ?? ''} maxLength={120} />
                    <label htmlFor={`dossier-${photo.id}`}>Dossier</label>
                    <input id={`dossier-${photo.id}`} name="dossier" list="dossiers" defaultValue={photo.folder ?? ''} maxLength={60} />
                    <label htmlFor={`mots-${photo.id}`}>Mots-clés</label>
                    <input id={`mots-${photo.id}`} name="mots-cles" defaultValue={photo.tags.join(', ')} maxLength={400} />
                    <button type="submit">Enregistrer</button>
                  </form>
                  <form action={removeLibraryAction.bind(null, workspaceId, photo.id)}>
                    <button type="submit">Retirer de la médiathèque</button>
                  </form>
                  <p className="hint">Une photo retirée reste sur les posts qui l’utilisent déjà.</p>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
