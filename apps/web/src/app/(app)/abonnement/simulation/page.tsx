import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { billingSimulated } from '../../../../server/context.ts';
import { simulateCheckoutAction, simulatePortalAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Paiement simulé' };
export const dynamic = 'force-dynamic';

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '');
const CHECKOUT_FIELDS = ['mode', 'client', 'prix', 'quantite', 'retour', 'org_id', 'plan_key', 'workspace_id', 'offer_key'] as const;

/**
 * Remplace Stripe Checkout et le portail Stripe en développement (BILLING_MODE=fake) : aucune
 * somme n'est prélevée. Introuvable dans tout autre mode.
 */
export default async function SimulationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!billingSimulated()) notFound();
  const query = await searchParams;
  const mode = one(query['mode']);

  if (mode === 'portail') {
    return (
      <>
        <h1>Portail de facturation (simulation)</h1>
        <p className="hint">En production, cette page est le portail Stripe : moyen de paiement, factures, changement de formule et résiliation. Ici, rien n’est prélevé.</p>
        <form action={simulatePortalAction} className="stack">
          <input type="hidden" name="client" value={one(query['client'])} />
          <input type="hidden" name="retour" value={one(query['retour'])} />
          <fieldset>
            <legend>Simuler</legend>
            <label>
              <input type="radio" name="action" value="resilier" defaultChecked /> une résiliation à la fin de la période
            </label>
            <label>
              <input type="radio" name="action" value="reprendre" /> l’annulation de la résiliation
            </label>
            <label>
              <input type="radio" name="action" value="echec_paiement" /> un prélèvement en échec
            </label>
            <label>
              <input type="radio" name="action" value="paiement" /> un prélèvement réussi
            </label>
            <label>
              <input type="radio" name="action" value="fin_resiliation" /> la fin de l’abonnement résilié
            </label>
          </fieldset>
          <button type="submit">Appliquer</button>
        </form>
        <p>
          <a href={one(query['retour']).startsWith('http') ? new URL(one(query['retour'])).pathname : '/'}>Revenir sans rien changer</a>
        </p>
      </>
    );
  }

  const pack = mode === 'payment';
  return (
    <>
      <h1>Paiement (simulation)</h1>
      <p className="hint">En production, cette page est Stripe Checkout (carte ou prélèvement SEPA, TVA, codes promo). Ici, rien n’est prélevé.</p>
      <p>
        {pack ? (
          <>Achat d’un pack : {one(query['offer_key'])}.</>
        ) : (
          <>
            Abonnement {one(query['plan_key'])} pour {one(query['quantite'])} compte{Number(one(query['quantite'])) > 1 ? 's' : ''} LinkedIn.
          </>
        )}
      </p>
      <form action={simulateCheckoutAction}>
        {CHECKOUT_FIELDS.map((name) => (
          <input key={name} type="hidden" name={name} value={one(query[name])} />
        ))}
        <button type="submit">Payer (simulation)</button>
      </form>
      <p>
        <a href={one(query['retour']).startsWith('http') ? new URL(one(query['retour'])).pathname : '/'}>Annuler</a>
      </p>
    </>
  );
}
