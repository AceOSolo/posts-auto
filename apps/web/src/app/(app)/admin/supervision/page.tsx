import { supervision } from '@posts-auto/services';
import type { Metadata } from 'next';
import { requireAdmin } from '../../../../server/admin.ts';
import { database } from '../../../../server/context.ts';

export const metadata: Metadata = { title: 'Supervision' };
export const dynamic = 'force-dynamic';

const date = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const eur = (n: number) => `${n.toFixed(2).replace('.', ',')} €`;

/** ADM-03 : files de travail, erreurs LinkedIn, connexions, coûts de l'IA. */
export default async function SupervisionPage() {
  const adminId = await requireAdmin();
  const s = await supervision(database(), adminId, new Date());
  return (
    <>
      <h1>Supervision</h1>

      <section aria-labelledby="files">
        <h2 id="files">Files de travail</h2>
        <ul className="stat-tiles">
          <li>
            <strong>{s.generation.running}</strong> rédaction{s.generation.running > 1 ? 's' : ''} en cours
            {s.generation.oldestRunningAt && <> (depuis {date.format(s.generation.oldestRunningAt)})</>}
          </li>
          <li>
            <strong>{s.generation.doneLast24h}</strong> rédactions terminées (24 h)
          </li>
          <li>
            <strong>{s.generation.failedLast7d}</strong> rédactions en échec (7 jours)
          </li>
          <li>
            <strong>{s.requests.waiting}</strong> demande{s.requests.waiting > 1 ? 's' : ''} en attente
            {s.requests.oldestAt && <> (la plus ancienne : {date.format(s.requests.oldestAt)})</>}
          </li>
          <li>
            <strong>{s.visuals.waiting}</strong> visuels à refaire · <strong>{s.visuals.failed}</strong> en échec
          </li>
        </ul>
        <h3>Publication</h3>
        <ul className="stat-tiles">
          <li>
            <strong>{s.publication.late}</strong> post{s.publication.late > 1 ? 's' : ''} validé{s.publication.late > 1 ? 's' : ''} en retard (plus de 10 min)
          </li>
          <li>
            <strong>{s.publication.publishing}</strong> en cours de publication
          </li>
          <li>
            <strong>{s.publication.inError}</strong> en erreur
          </li>
          <li>
            <strong>{s.publication.publishedLast24h}</strong> publiés (24 h)
          </li>
        </ul>
      </section>

      <section aria-labelledby="erreurs">
        <h2 id="erreurs">Erreurs LinkedIn par type (7 jours)</h2>
        {s.linkedinErrors.length === 0 ? (
          <p className="muted">Aucune erreur.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Nombre</th>
                <th scope="col">Dernière</th>
              </tr>
            </thead>
            <tbody>
              {s.linkedinErrors.map((e) => (
                <tr key={e.code}>
                  <th scope="row">{e.code}</th>
                  <td>{e.count}</td>
                  <td>{date.format(e.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {s.recentFailures.length > 0 && (
          <>
            <h3>Derniers échecs de rédaction et de visuel</h3>
            <ul>
              {s.recentFailures.map((f, i) => (
                <li key={`${f.at.toISOString()}-${i}`}>
                  {date.format(f.at)} · {f.orgName} · {f.workspaceName} · {f.what} : {f.error.slice(0, 200)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="connexions">
        <h2 id="connexions">Connexions LinkedIn</h2>
        <p>
          {s.accounts.expiring} expirent bientôt · {s.accounts.expired} expirées · {s.accounts.revoked} déconnectées · {s.accounts.paused} en pause
        </p>
        {s.expiredAccounts.length > 0 && (
          <ul>
            {s.expiredAccounts.map((a, i) => (
              <li key={`${a.orgName}-${a.accountName}-${i}`}>
                {a.orgName} · {a.workspaceName} · {a.accountName} : {a.status === 'expired' ? 'expirée' : 'expire bientôt'} (depuis {date.format(a.since)})
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="couts">
        <h2 id="couts">Coûts de l’IA par fournisseur</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Fournisseur</th>
              <th scope="col">Type</th>
              <th scope="col">Appels ce mois</th>
              <th scope="col">Images ce mois</th>
              <th scope="col">Coût ce mois</th>
              <th scope="col">Coût le mois dernier</th>
            </tr>
          </thead>
          <tbody>
            {s.aiCosts.map((c) => (
              <tr key={`${c.provider}-${c.kind}`}>
                <th scope="row">{c.provider}</th>
                <td>{c.kind === 'image' ? 'images' : 'texte'}</td>
                <td>{c.calls}</td>
                <td>{c.kind === 'image' ? c.units : '—'}</td>
                <td>{eur(c.costEurThisMonth)}</td>
                <td>{eur(c.costEurLastMonth)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
