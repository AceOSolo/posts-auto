import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError } from '../errors.ts';
import { type MeasuredPost, MIN_MEASURED, advisePostingTimes, bandOf, localSlot, postingTimesAdvice } from './posting-times.ts';

const PARIS = 'Europe/Paris';
// Mardi 6 octobre 2026, 10:00 UTC = 12:00 Ã  Paris (heure d'Ã©tÃ©).
const TUESDAY_NOON = new Date('2026-10-06T10:00:00Z');
const at = (days: number, hours = 0) => new Date(TUESDAY_NOON.getTime() + days * 86_400_000 + hours * 3_600_000);
const post = (publishedAt: Date, reactions: number, impressions: number | null = 1000): MeasuredPost => ({ publishedAt, impressions, reactions, comments: 0, shares: 0 });

describe('moments de la semaine', () => {
  it('jour et heure locale, arrondie Ã  5 minutes, heure dâ€™Ã©tÃ© et dâ€™hiver', () => {
    expect(localSlot(TUESDAY_NOON, PARIS)).toEqual({ weekday: 2, hour: 12, time: '12:00' });
    expect(localSlot(new Date('2026-12-06T08:33:00Z'), PARIS)).toEqual({ weekday: 7, hour: 9, time: '09:30' });
    expect(localSlot(new Date('2026-10-05T22:30:00Z'), PARIS)).toMatchObject({ weekday: 2, hour: 0 });
  });

  it('tranches horaires', () => {
    expect([6, 7, 10, 11, 13, 14, 17, 19, 20, 23].map(bandOf)).toEqual(['soir', 'matin', 'matin', 'midi', 'midi', 'apres-midi', 'fin-de-journee', 'fin-de-journee', 'soir', 'soir']);
  });
});

describe('conseil (meilleurs moments pour publier)', () => {
  it('pas de conseil sans assez de posts mesurÃ©s', () => {
    const advice = advisePostingTimes([post(at(0), 30), post(at(7), 30)], PARIS, []);
    expect(advice).toMatchObject({ measured: 2, needed: MIN_MEASURED, best: null, groups: [] });
    expect(advisePostingTimes([{ publishedAt: at(0), impressions: null, reactions: null, comments: null, shares: null }], PARIS, []).measured).toBe(0);
  });

  it('propose le moment qui se dÃ©tache, au taux pour 1 000 impressions, avec lâ€™heure la plus frÃ©quente', () => {
    const posts = [
      // Mardi midi : 40 interactions pour 1 000 impressions.
      post(at(0), 40),
      post(at(7), 40),
      post(at(14, 0.5), 40),
      // Jeudi matin (9:30 Ã  Paris) : 10 pour 1 000.
      post(at(2, -2.5), 10),
      post(at(9, -2.5), 10),
      post(at(16, -2.5), 10),
    ];
    const advice = advisePostingTimes(posts, PARIS, [{ weekday: 4, time: '09:30' }]);
    expect(advice.metric).toBe('taux');
    expect(advice.groups.map((g) => `${g.weekday}-${g.band}`)).toEqual(['2-midi', '4-matin']);
    expect(advice.best).toMatchObject({ weekday: 2, band: 'midi', posts: 3, score: 40, averageImpressions: 1000, suggestedTime: '12:00' });
    expect(advice.gainPercent).toBe(60);
    expect(advice.alreadyUsed).toBe(false);
    expect(advisePostingTimes(posts, PARIS, [{ weekday: 2, time: '12:30' }]).alreadyUsed).toBe(true);
  });

  it('sans impressions : interactions moyennes ; pas de conseil quand aucun moment ne se dÃ©tache', () => {
    const flat = [0, 7, 14].flatMap((d) => [post(at(d), 20, null), post(at(d + 2, -2.5), 19, null)]);
    const advice = advisePostingTimes(flat, PARIS, []);
    expect(advice.metric).toBe('interactions');
    expect(advice.groups).toHaveLength(2);
    expect(advice.best).toBeNull();
  });

  it('un seul moment mesurÃ© ne se compare Ã  rien ; les moments Ã  un seul post ne sont pas classÃ©s', () => {
    const same = [0, 7, 14, 21, 28, 35].map((d) => post(at(d), 30));
    expect(advisePostingTimes(same, PARIS, []).best).toBeNull();
    const advice = advisePostingTimes([...same, post(at(3), 500)], PARIS, []);
    expect(advice.groups.map((g) => g.weekday)).toEqual([2]);
    expect(advice.best).toBeNull();
  });

  it('aucune interaction : pas de conseil', () => {
    const zero = [0, 7, 14].flatMap((d) => [post(at(d), 0), post(at(d + 2), 0)]);
    expect(advisePostingTimes(zero, PARIS, []).best).toBeNull();
  });
});

describe('conseil dâ€™un compte, lu dans la base', () => {
  let db: Database;
  let workspaceId: string;
  let accountId: string;
  let member: string;
  let outsider: string;

  beforeAll(async () => {
    db = await openTestDatabase();
    const org = await createOrganization(db);
    workspaceId = org.workspaceIds[0] as string;
    member = await createUser(db, 'membre-moments');
    outsider = await createUser(db, 'etranger-moments');
    await addMember(db, workspaceId, member, 'viewer');
    accountId = await createAccount(db, workspaceId);
    const plan: [Date, number][] = [
      [at(0), 40],
      [at(7), 40],
      [at(14), 40],
      [at(2, -2.5), 10],
      [at(9, -2.5), 10],
      [at(16, -2.5), 10],
    ];
    for (const [i, [when, reactions]] of plan.entries()) {
      const id = await createPost(db, workspaceId, accountId, { status: 'publie', scheduled_at: when, published_at: when, external_post_urn: `urn:li:share:moment-${i}` });
      await asSystem(db, (trx) =>
        trx
          .insertInto('post_stats')
          .values([
            { post_id: id, workspace_id: workspaceId, day_offset: 1, impressions: 100, reactions: 1, comments: 0, shares: 0 },
            { post_id: id, workspace_id: workspaceId, day_offset: 7, impressions: 1000, reactions, comments: 0, shares: 0 },
          ])
          .execute(),
      );
    }
    // PubliÃ©, sans statistiques : ignorÃ©.
    await createPost(db, workspaceId, accountId, { status: 'publie', scheduled_at: at(21), published_at: at(21), external_post_urn: 'urn:li:share:moment-sans' });
  });
  afterAll(() => closeTestDatabase(db));

  it('statistiques Ã  J+7 des posts publiÃ©s du compte', async () => {
    const advice = await postingTimesAdvice(db, member, accountId, new Date('2026-11-20T10:00:00Z'), []);
    expect(advice.measured).toBe(6);
    expect(advice.best).toMatchObject({ weekday: 2, band: 'midi', score: 40, suggestedTime: '12:00' });
  });

  it('au-delÃ  de six mois, plus rien ; hors de lâ€™espace, compte introuvable', async () => {
    expect((await postingTimesAdvice(db, member, accountId, new Date('2027-06-01T10:00:00Z'), [])).measured).toBe(0);
    await expect(postingTimesAdvice(db, outsider, accountId, new Date('2026-11-20T10:00:00Z'), [])).rejects.toBeInstanceOf(NotFoundError);
  });
});
