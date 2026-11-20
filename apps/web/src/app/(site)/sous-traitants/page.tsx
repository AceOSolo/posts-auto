import type { Metadata } from 'next';
import { LegalPage, Todo } from '../legal.tsx';

export const metadata: Metadata = { title: 'Sous-traitants', robots: { index: true, follow: true } };

const ROWS: readonly (readonly [string, string, string])[] = [
  ['Hébergement et base de données', 'Hébergement du service et des données', 'Union européenne'],
  ['Anthropic (Claude)', 'Rédaction et relecture des textes, contrôle des images', 'États-Unis (clauses contractuelles types, sans entraînement sur les données)'],
  ['Higgsfield', 'Génération des images d’illustration, si elle est activée', 'À préciser'],
  ['Brevo', 'Envoi des e-mails (liens de connexion, rappels, rapports)', 'Union européenne'],
  ['Stripe', 'Paiement, factures, portail de facturation', 'Union européenne et États-Unis (clauses contractuelles types)'],
  ['LinkedIn', 'Publication des posts et statistiques, à la demande du titulaire', 'Irlande'],
  ['Google, Microsoft', 'Connexion facultative avec un compte Google ou Microsoft', 'Selon le fournisseur'],
];

/** SIT-04 : liste des sous-traitants. */
export default function SubprocessorsPage() {
  return (
    <LegalPage title="Sous-traitants" updated="20 novembre 2026">
      <p>
        <Todo>nom de l’hébergeur retenu, vérification de la liste et des lieux de traitement</Todo>
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Sous-traitant</th>
            <th scope="col">Service</th>
            <th scope="col">Lieu</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([name, role, place]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>{role}</td>
              <td>{place}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </LegalPage>
  );
}
