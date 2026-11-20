/** Textes de chaque notification : dans l'application et par e-mail (NOT-01, FAC-04, FAC-06, PUB-09, SUI-05). */
import { describe, expect, it } from 'vitest';
import { notificationMail } from '../mail/templates.ts';
import { describeNotification } from './notification-center.ts';

const ctx = { appUrl: 'https://app.test', recipientName: 'Claire', timeZone: 'Europe/Paris' };
const base = { postId: 'p1', accountName: 'Marie Dupont', workspaceId: 'w1', scheduledAt: '2026-11-24T11:00:00Z' };

const CASES: readonly [string, Record<string, unknown>, RegExp, RegExp | null][] = [
  ['rappel_validation', { ...base, hours: 2 }, /Marie Dupont/, /Dernier rappel/],
  ['rappel_validation', { ...base, hours: 24, approvalUrl: 'https://app.test/valider/x' }, /attend/, /Valider maintenant/],
  ['recap_hebdo', { count: 1 }, /à valider/, /1 post/],
  ['recap_hebdo', { count: 3 }, /3 post/, /3 posts/],
  ['post_replanifie', { ...base, movedToAnotherWeek: true }, /semaine prochaine/, null],
  ['post_replanifie', { ...base }, /replanifié faute/, null],
  ['post_abandonne', base, /sorti du circuit/, null],
  ['publication_erreur', { ...base, uncertain: true, message: 'Délai dépassé' }, /incertaine/, /vérification/],
  ['publication_erreur', { ...base, message: 'Refusé' }, /pas pu être publié/, /Refusé/],
  ['post_publie', base, /publié/, null],
  ['connexion_expire_bientot', { ...base, daysLeft: 3 }, /3 jour/, /expire dans 3 jours/],
  ['connexion_expiree', base, /a expiré/, /Reconnecter/],
  ['posts_prets', { count: 4 }, /4 nouveau/, null],
  ['nouvelle_version', { ...base, refused: true }, /Nouvelle version/, /autre sujet/],
  ['nouvelle_version', base, /Nouvelle version/, /modification a été appliquée/],
  ['demande_traitee', { workspaceId: 'w1', impossible: true }, /pas pu être traitée/, null],
  ['demande_traitee', { workspaceId: 'w1' }, /est rédigée/, null],
  ['generation_terminee', { workspaceId: 'w1', runId: 'r1', created: 5, withMarkers: 2, unplaced: 1, suspicious: 1, errors: 1 }, /5 post/, /marqueur/],
  ['reprise_manuelle', base, /repris à la main/, /3 fois/],
  ['publication_manuelle', { ...base, body: 'Premier paragraphe.\n\nSecond.', images: 2 }, /publication manuelle/, /2 images jointes/],
  ['publication_manuelle', { ...base, body: 'Texte', images: 0 }, /publication manuelle/, /Copiez le texte/],
  ['rapport_mensuel', { workspaceId: 'w1', month: '2026-10-15T00:00:00Z' }, /Notification/, /octobre 2026/],
  ['impaye', { workspaceId: 'w1', step: 'j3' }, /moyen de paiement/, /11 jours/],
  ['impaye', { workspaceId: 'w1', step: 'j7' }, /moyen de paiement/, /7 jours/],
  ['impaye', { workspaceId: 'w1', step: 'j14' }, /suspendues/, /90 jours/],
  ['quota_alerte', { workspaceId: 'w1', workspaceName: 'Acme', kind: 'posts_80', used: 26, limit: 32 }, /80 %/, /26 posts sur 32/],
  ['quota_alerte', { workspaceId: 'w1', workspaceName: 'Acme', kind: 'images_100', used: 20, limit: 20, packs: true }, /atteint \(images\)/, /Ajoutez un pack/],
  ['quota_alerte', { workspaceId: 'w1', kind: 'posts_100', used: 32, limit: 32 }, /atteint \(posts\)/, /mois de quota suivant/],
];

describe('textes des notifications', () => {
  it.each(CASES)('%s', (kind, payload, inApp, mail) => {
    const described = describeNotification(kind, payload);
    expect(described.title).toMatch(inApp);
    const rendered = notificationMail(kind, payload, ctx);
    if (mail === null) {
      expect(rendered).toBeNull();
      return;
    }
    expect(rendered).not.toBeNull();
    expect(`${rendered?.subject}\n${rendered?.text}`).toMatch(mail);
    expect(rendered?.html).toContain('Bonjour Claire');
    expect(rendered?.html).not.toMatch(/<script/i);
  });

  it('type inconnu : titre générique, pas d’e-mail', () => {
    expect(describeNotification('inconnu', {})).toEqual({ title: 'Notification', href: null });
    expect(notificationMail('inconnu', {}, ctx)).toBeNull();
  });

  it('liens vers l’abonnement, le planning ou rien selon ce que porte la notification', () => {
    expect(describeNotification('impaye', { workspaceId: 'w1' }).href).toBe('/abonnement/w1');
    expect(describeNotification('impaye', {}).href).toBeNull();
    expect(describeNotification('generation_terminee', { workspaceId: 'w1' }).href).toBeNull();
    expect(describeNotification('quota_alerte', { kind: 'posts_80' }).href).toBeNull();
    expect(describeNotification('demande_traitee', {}).href).toBeNull();
    expect(describeNotification('publication_manuelle', {}).href).toBeNull();
  });
});
