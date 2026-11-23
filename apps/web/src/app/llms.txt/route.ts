/** SIT-06 : présentation du service pour les moteurs de réponse par IA (format llms.txt). */
import { publicPlans } from '@posts-auto/services';
import { appUrl, database } from '../../server/context.ts';

export const dynamic = 'force-dynamic';

export async function GET() {
  const base = appUrl();
  const plans = await publicPlans(database());
  const price = (cents: number | null) => (cents === null ? 'prix sur demande' : `${(cents / 100).toFixed(2).replace('.', ',')} € HT par compte et par mois`);
  const text = [
    '# Rostra',
    '',
    '> Service en ligne (SaaS) français qui rédige par IA les posts LinkedIn des dirigeants, des experts et des pages d’entreprise, les fait valider par chaque titulaire, puis les publie automatiquement. Pour les PME, ETI et agences. Édité par SimplX ; données hébergées dans l’Union européenne.',
    '',
    '## Fonctionnement',
    '- Planning éditorial par compte et par semaine, import depuis un tableur ou Google Sheets.',
    '- Rédaction dans le ton de chaque compte ; aucun fait inventé : les informations manquantes sont signalées par des marqueurs qui bloquent la publication.',
    '- Validation par le titulaire en un clic (téléphone, e-mail) ; rien ne part sans validation.',
    '- Publication automatique sur LinkedIn au créneau prévu, visuels aux couleurs de la marque, statistiques et rapport mensuel.',
    '',
    '## Formules',
    ...plans.map((p) => `- ${p.name} : ${price(p.priceMonthlyCents)}, ${p.postsPerAccount} posts rédigés par compte et par mois${p.maxWorkspaces === null ? ', espaces clients illimités' : ''}.`),
    '- Essai gratuit de 14 jours, sans carte bancaire (3 comptes, 10 posts).',
    '',
    '## Liens',
    `- [Site](${base}/)`,
    `- [Tarifs](${base}/tarifs)`,
    `- [Pour les PME et ETI](${base}/pme-eti)`,
    `- [Pour les agences](${base}/agences)`,
    `- [Sécurité et RGPD](${base}/confiance)`,
    `- [Créer un compte](${base}/inscription)`,
    `- [Comment fonctionne la rédaction](${base}/comment-fonctionne-la-redaction)`,
    `- [Confidentialité](${base}/confidentialite)`,
    '',
  ].join('\n');
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
