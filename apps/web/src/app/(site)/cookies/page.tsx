import type { Metadata } from 'next';
import { LegalPage } from '../legal.tsx';

export const metadata: Metadata = { title: 'Cookies', robots: { index: true, follow: true } };

/**
 * SIT-04, SIT-05 : le site et le service ne déposent que des cookies strictement nécessaires,
 * exemptés de consentement (CNIL, lignes directrices du 17 septembre 2020) : pas de bandeau.
 */
export default function CookiesPage() {
  return (
    <LegalPage title="Cookies" updated="20 novembre 2026">
      <p>
        Le site vitrine ne dépose aucun cookie. Le service ne dépose que des cookies strictement nécessaires à son fonctionnement, exemptés de consentement : aucun bandeau ne vous est donc
        présenté, et aucun cookie publicitaire ou de mesure d’audience n’est utilisé.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Cookie</th>
            <th scope="col">Rôle</th>
            <th scope="col">Durée</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">__Host-session</th>
            <td>Garder la personne connectée</td>
            <td>30 jours, prolongés à chaque visite</td>
          </tr>
          <tr>
            <th scope="row">li_oauth, sso</th>
            <td>Protéger une connexion à LinkedIn, Google ou Microsoft en cours</td>
            <td>10 minutes</td>
          </tr>
          <tr>
            <th scope="row">codes-secours</th>
            <td>Afficher une seule fois les codes de secours de la double authentification</td>
            <td>10 minutes</td>
          </tr>
        </tbody>
      </table>
    </LegalPage>
  );
}
