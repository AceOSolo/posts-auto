import { listDemoRequests, siteTestimonial } from '@posts-auto/services';
import type { Metadata } from 'next';
import { Flash } from '../../../../components/flash.tsx';
import { requireAdmin } from '../../../../server/admin.ts';
import { database } from '../../../../server/context.ts';
import { saveTestimonialAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Site vitrine' };
export const dynamic = 'force-dynamic';

const date = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** SIT-02 : demandes de démonstration ; SIT-08 : témoignage client affiché sur le site. */
export default async function SiteAdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const adminId = await requireAdmin();
  const { message } = await searchParams;
  const requests = await listDemoRequests(database(), adminId);
  const testimonial = await siteTestimonial(database());
  return (
    <>
      <h1>Site vitrine</h1>
      <Flash code={message} />
      <section aria-labelledby="demos">
        <h2 id="demos">Demandes de démonstration</h2>
        {requests.length === 0 ? (
          <p className="muted">Aucune demande.</p>
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Tableau, défilable horizontalement">
            <table>
              <thead>
                <tr>
                  <th scope="col">Reçue</th>
                  <th scope="col">Entreprise</th>
                  <th scope="col">Contact</th>
                  <th scope="col">Comptes</th>
                  <th scope="col">Message</th>
                  <th scope="col">Transmise</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td>{date.format(r.createdAt)}</td>
                    <th scope="row">{r.company}</th>
                    <td>
                      {r.fullName} · {r.email}
                      {r.phone && ` · ${r.phone}`}
                    </td>
                    <td>{r.accounts ?? '—'}</td>
                    <td>{r.message ?? '—'}</td>
                    <td>{r.forwardedAt ? 'oui' : r.forwardError ? `échec : ${r.forwardError}` : 'non'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="temoignage">
        <h2 id="temoignage">Témoignage client</h2>
        <p className="hint">Affiché sur le site seulement avec l’accord écrit du client (SIT-08), dont la date est conservée. Un texte vide retire le témoignage.</p>
        <form action={saveTestimonialAction} className="stack">
          <label>
            Citation
            <textarea name="citation" rows={3} maxLength={600} defaultValue={testimonial?.quote ?? ''} />
          </label>
          <label>
            Auteur
            <input name="auteur" maxLength={120} defaultValue={testimonial?.author ?? ''} />
          </label>
          <label>
            Fonction
            <input name="fonction" maxLength={120} defaultValue={testimonial?.role ?? ''} />
          </label>
          <label>
            Entreprise
            <input name="entreprise" maxLength={120} defaultValue={testimonial?.company ?? ''} />
          </label>
          <label>
            Date de l’accord écrit du client
            <input name="accord" type="date" defaultValue={testimonial?.consentOn ?? ''} />
          </label>
          <button type="submit">Enregistrer le témoignage</button>
        </form>
      </section>
    </>
  );
}
