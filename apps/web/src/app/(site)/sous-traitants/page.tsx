import type { Metadata } from 'next';
import { LegalPage, Todo } from '../legal.tsx';

export const metadata: Metadata = { title: 'Sous-traitants', robots: { index: true, follow: true } };

const ROWS: readonly (readonly [string, string, string])[] = [
  ['Hébergement et base de données', 'Hébergement du service et des données', 'Union européenne'],
  ['Anthropic (Claude)', 'Rédaction et relecture des textes, contrôle des images', 'États-Unis (clauses contractuelles types, sans entraînement sur les données)'],
  ['Higgsfield', 'Génération des images d’illustration, si elle est activée', 'À préciser'],
  ['Brevo', 'Envoi des e-mails (liens de connexion, rappels, rapports) et réception des idées envoyées par e-mail', 'Union européenne'],
  ['Stripe', 'Paiement, factures, portail de facturation', 'Union européenne et États-Unis (clauses contractuelles types)'],
  ['LinkedIn', 'Publication des posts et statistiques, à la demande du titulaire', 'Irlande'],
  ['Google, Microsoft', 'Connexion facultative avec un compte Google ou Microsoft', 'Selon le fournisseur'],
  ['Canva', 'Création des visuels depuis vos modèles, si vous connectez Canva', 'À préciser'],
  ['Slack, Microsoft Teams', 'Annonces dans le canal de l’équipe, si vous les connectez', 'Selon le fournisseur'],
  ['Make, Zapier, n8n ou outil équivalent', 'Publication par webhook, si vous choisissez ce mode', 'Selon l’outil choisi'],
  ['Reconnaissance vocale du navigateur', 'Dictée, si vous l’utilisez (service de Google sous Chrome)', 'Selon le navigateur'],
  ['Outil de suivi commercial de SimplX', 'Suivi des demandes de démonstration', 'À préciser'],
  ['Stockage de sauvegarde', 'Copie des sauvegardes hors du serveur principal', 'À préciser'],
];

/** SIT-04 : liste des sous-traitants. */
export default function SubprocessorsPage() {
  return (
    <LegalPage title="Sous-traitants" updated="23 novembre 2026">
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
