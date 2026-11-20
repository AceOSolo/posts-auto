import { listGalleryEntries } from '@posts-auto/services';
import type { Metadata } from 'next';
import { Flash } from '../../../../components/flash.tsx';
import { requireAdmin } from '../../../../server/admin.ts';
import { database } from '../../../../server/context.ts';
import { saveGalleryAction, toggleGalleryAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Galerie de départ' };
export const dynamic = 'force-dynamic';

/** ADM-05 : modèles de visuels proposés à tous les clients. */
export default async function GalleryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const adminId = await requireAdmin();
  const { message, modele } = await searchParams;
  const entries = await listGalleryEntries(database(), adminId);
  const editing = entries.find((e) => !e.builtin && e.key === modele);
  return (
    <>
      <h1>Galerie de départ</h1>
      <Flash code={message} />
      <p className="hint">
        Chaque nouvel espace reçoit une copie de ces modèles, aux couleurs de sa charte, à la première visite de la page « Visuels ». Les espaces qui ont déjà leurs modèles ne
        changent pas. Aperçus avec la charte par défaut.
      </p>
      <ul className="template-grid">
        {entries.map((e) => (
          <li key={e.key} className="card">
            <img src={`/admin/galerie/apercu?modele=${encodeURIComponent(e.key)}`} alt={`Aperçu du modèle ${e.name}`} width={216} height={216} loading="lazy" />
            <h2>{e.name}</h2>
            <p className="muted">
              {e.key} · {e.builtin ? 'intégré' : 'ajouté'} · {e.withPhoto ? 'avec photo' : 'visuel texte'} · {e.active ? 'proposé' : 'retiré'}
            </p>
            <form action={toggleGalleryAction.bind(null, e.key, !e.active)} className="inline-fields">
              <button type="submit">{e.active ? 'Retirer de la galerie' : 'Proposer de nouveau'}</button>
            </form>
            {!e.builtin && <a href={`/admin/galerie?modele=${encodeURIComponent(e.key)}#modele`}>Modifier</a>}
          </li>
        ))}
      </ul>

      <section aria-labelledby="modele" id="modele">
        <h2>{editing ? `Modifier « ${editing.name} »` : 'Ajouter un modèle'}</h2>
        <p className="hint">
          Définition au format des modèles (même structure que l’éditeur des clients). Couleurs « brand.primary », « brand.secondary », « brand.light », « brand.dark » et police
          « brand.font » : remplacées par la charte de chaque espace. Pour un nouveau modèle, le champ part de la définition du premier modèle intégré.
        </p>
        <form action={saveGalleryAction} className="stack">
          <label>
            Identifiant (lettres minuscules, chiffres, tirets)
            <input name="cle" required pattern="[a-z][a-z0-9-]{1,40}" defaultValue={editing?.key ?? ''} readOnly={editing !== undefined} />
          </label>
          <label>
            Nom
            <input name="nom" required maxLength={80} defaultValue={editing?.name ?? ''} />
          </label>
          <label>
            <input type="checkbox" name="photo" defaultChecked={editing?.withPhoto ?? false} /> Modèle avec photo
          </label>
          <label>
            Définition (JSON)
            <textarea name="definition" rows={16} required defaultValue={editing?.definitionJson ?? entries.find((e) => e.builtin)?.definitionJson ?? ''} spellCheck={false} />
          </label>
          <button type="submit">Enregistrer le modèle</button>
        </form>
      </section>
    </>
  );
}
