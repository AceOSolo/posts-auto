import { type BillingMode, NotFoundError, type Quota, billingOverview } from '@posts-auto/services';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { billing, database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { overageAction, packAction, portalAction, subscribeAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Abonnement' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' });
const euros = (cents: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);

const MODE_LABELS: Record<BillingMode, string> = {
  pilot: 'Client pilote : pas de limite de rédaction.',
  trial: 'Essai gratuit en cours.',
  trial_over: 'Pas d’abonnement en cours : la rédaction est arrêtée, les posts déjà validés partent toujours.',
  subscribed: 'Abonnement en cours.',
  suspended: 'Abonnement suspendu pour impayé : ni rédaction ni publication jusqu’au règlement.',
};
const STATUS_LABELS: Record<string, string> = { active: 'actif', past_due: 'paiement en échec', unpaid: 'impayé', canceled: 'résilié', incomplete: 'paiement non abouti' };
const FEATURE_LABELS: Record<string, string> = {
  canva: 'Visuels avec Canva',
  sources: 'Veille de sources (flux RSS)',
  statistiques: 'Statistiques LinkedIn',
  espaces_illimites: 'Espaces clients illimités',
  rapports: 'Rapport mensuel par client',
};

function QuotaCell({ quota }: { quota: Quota }) {
  if (quota.limit === null) return <>{quota.used} (sans plafond)</>;
  const full = quota.remaining === 0;
  return (
    <>
      {quota.used} sur {quota.limit} <meter min={0} max={Math.max(1, quota.limit)} value={Math.min(quota.used, quota.limit)} high={quota.limit * 0.8} optimum={0} aria-hidden="true" />
      {full && <strong> · plafond atteint</strong>}
    </>
  );
}

/** FAC-01 à FAC-07 : formule, usage du mois par espace, paiement et factures. */
export default async function SubscriptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { message } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let overview;
  try {
    overview = await billingOverview(database(), userId, workspaceId, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const here = overview.usage.find((u) => u.workspaceId === workspaceId) ?? overview.usage[0];
  const mode = here?.allowance.mode ?? 'pilot';
  const sub = overview.subscription;
  const subscribed = sub !== null && sub.status !== 'canceled' && sub.status !== 'incomplete';
  const paymentReady = billing() !== null;
  const window = here?.allowance.mode === 'subscribed' ? here.allowance : null;

  return (
    <>
      <h1>Abonnement · {overview.orgName}</h1>
      <Flash code={message} />
      <p>{MODE_LABELS[mode]}</p>
      {mode === 'trial' && overview.trialEndsAt !== null && <p>L’essai se termine le {day.format(overview.trialEndsAt)}. Souscrivez quand vous voulez : l’abonnement prend le relais aussitôt.</p>}
      {here?.allowance.reason && <p className="hint">{here.allowance.reason}</p>}

      {sub !== null && (
        <section aria-labelledby="formule">
          <h2 id="formule">Votre formule</h2>
          <ul>
            <li>
              Formule <strong>{sub.planName}</strong>, {sub.interval === 'year' ? 'paiement annuel' : 'paiement mensuel'} · {STATUS_LABELS[sub.status] ?? sub.status}
            </li>
            <li>
              {sub.quantity} compte{sub.quantity > 1 ? 's' : ''} LinkedIn facturé{sub.quantity > 1 ? 's' : ''} ({overview.billableAccounts} actif{overview.billableAccounts > 1 ? 's' : ''} aujourd’hui : un ajout est facturé au prorata, un retrait compte à la
              période suivante)
            </li>
            <li>
              {sub.cancelAtPeriodEnd ? 'Résiliation programmée : l’abonnement s’arrête le ' : 'Prochaine échéance : '}
              {day.format(sub.periodEnd)}
            </li>
            {sub.pastDueSince !== null && <li>Paiement en échec depuis le {day.format(sub.pastDueSince)} : mettez à jour votre moyen de paiement pour éviter la suspension.</li>}
          </ul>
          {overview.canManage && paymentReady && (
            <form action={portalAction.bind(null, workspaceId)}>
              <button type="submit">Moyen de paiement, factures et résiliation</button>
            </form>
          )}
        </section>
      )}

      <section aria-labelledby="usage">
        <h2 id="usage">Usage du mois</h2>
        {window?.periodStart && window.periodEnd ? (
          <p className="hint">
            Mois de quota du {day.format(window.periodStart)} au {day.format(window.periodEnd)}. Le quota est remis à zéro chaque mois à la date anniversaire ; seules les premières rédactions comptent, pas les reprises.
          </p>
        ) : (
          <p className="hint">Seules les premières rédactions comptent, pas les reprises.</p>
        )}
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Tableau, défilable horizontalement">
          <table>
            <thead>
              <tr>
                <th scope="col">Espace</th>
                <th scope="col">Comptes actifs</th>
                <th scope="col">Posts rédigés</th>
                <th scope="col">Images générées</th>
              </tr>
            </thead>
            <tbody>
              {overview.usage.map((u) => (
                <tr key={u.workspaceId}>
                  <th scope="row">{u.workspaceName}</th>
                  <td>{u.accounts}</td>
                  <td>
                    <QuotaCell quota={u.allowance.posts} />
                  </td>
                  <td>
                    <QuotaCell quota={u.allowance.images} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* FAC-07 : export pour la refacturation des agences à leurs clients. */}
        {overview.canManage && (
          <p>
            <a href={`/abonnement/${workspaceId}/export`}>Exporter l’usage par espace et par mois (CSV)</a>
          </p>
        )}
      </section>

      {subscribed && overview.canManage && (
        <section aria-labelledby="plafond">
          <h2 id="plafond">Au plafond du quota</h2>
          <form action={overageAction.bind(null, workspaceId)} className="stack">
            <fieldset>
              <legend>Quand le quota du mois est atteint :</legend>
              <label>
                <input type="radio" name="depassement" value="suspend" defaultChecked={sub.overagePolicy === 'suspend'} /> la rédaction s’arrête jusqu’au mois suivant
              </label>
              <label>
                <input type="radio" name="depassement" value="packs" defaultChecked={sub.overagePolicy === 'packs'} /> je peux acheter des packs supplémentaires
              </label>
            </fieldset>
            <button type="submit">Enregistrer</button>
          </form>
          {sub.overagePolicy === 'packs' && paymentReady && (
            <>
              <h3>Packs pour {here?.workspaceName}</h3>
              <ul>
                {overview.packs.map((pack) => (
                  <li key={pack.key}>
                    {pack.name}
                    {pack.priceCents !== null && <> · {euros(pack.priceCents)} HT</>}{' '}
                    {pack.available ? (
                      <form action={packAction.bind(null, workspaceId)} className="inline-fields">
                        <input type="hidden" name="pack" value={pack.key} />
                        <button type="submit">Acheter</button>
                      </form>
                    ) : (
                      <span className="muted">(bientôt disponible)</span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="hint">Un pack vaut pour cet espace, jusqu’à la fin du mois de quota en cours.</p>
            </>
          )}
        </section>
      )}

      {!subscribed && mode !== 'pilot' && (
        <section aria-labelledby="formules">
          <h2 id="formules">Choisir une formule</h2>
          <p className="hint">Prix par compte LinkedIn actif. Paiement par carte ou prélèvement SEPA ; TVA calculée au paiement, numéro de TVA intracommunautaire accepté. Codes promo saisis à l’étape de paiement.</p>
          {!overview.canManage && <p>Seul le propriétaire de l’organisation peut souscrire.</p>}
          {overview.canManage && !paymentReady && <p className="muted">Le paiement n’est pas encore configuré sur ce serveur.</p>}
          <ul className="cards">
            {overview.plans.map((plan) => (
              <li key={plan.key} className="card">
                <h3>{plan.name}</h3>
                <p>
                  {plan.priceMonthlyCents !== null ? <strong>{euros(plan.priceMonthlyCents)} HT par compte et par mois</strong> : <span className="muted">Prix communiqué prochainement</span>}
                  {plan.priceYearlyCents !== null && <> · ou {euros(plan.priceYearlyCents)} HT par compte et par an</>}
                </p>
                <ul>
                  <li>{plan.postsPerAccount} posts rédigés par compte et par mois, mutualisés dans l’espace</li>
                  <li>{plan.maxWorkspaces === null ? 'Espaces clients illimités' : plan.maxWorkspaces === 1 ? 'Un espace' : `${plan.maxWorkspaces} espaces`}</li>
                  {plan.features.filter((f) => f !== 'espaces_illimites').map((f) => (
                    <li key={f}>{FEATURE_LABELS[f] ?? f}</li>
                  ))}
                </ul>
                {overview.canManage && paymentReady && (plan.monthly || plan.yearly) ? (
                  <form action={subscribeAction.bind(null, workspaceId)} className="stack">
                    <input type="hidden" name="formule" value={plan.key} />
                    <fieldset>
                      <legend>Paiement</legend>
                      {plan.monthly && (
                        <label>
                          <input type="radio" name="periodicite" value="month" defaultChecked /> mensuel
                        </label>
                      )}
                      {plan.yearly && (
                        <label>
                          <input type="radio" name="periodicite" value="year" defaultChecked={!plan.monthly} /> annuel
                        </label>
                      )}
                    </fieldset>
                    <button type="submit">{`Souscrire à ${plan.name}`}</button>
                  </form>
                ) : (
                  !(plan.monthly || plan.yearly) && <p className="muted">Bientôt disponible</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
