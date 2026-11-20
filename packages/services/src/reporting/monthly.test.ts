import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createAccount, createOrganization, createPost, createUser, addMember, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MonthlyPostRow, closeMonth, computeInsights, latestInsightsGuidance, monthlyOverview, monthlyReportPdf, parisMonth, setMonthlyReportEmail } from './monthly.ts';

let db: Database;
let workspaceId: string;
let accountId: string;
let admin: string;
const OCT = new Date('2026-10-15T10:00:00Z');

const row = (over: Partial<MonthlyPostRow>): MonthlyPostRow => ({
  accountName: 'Compte',
  publishedAt: OCT,
  excerpt: 'Texte',
  length: 500,
  withImage: false,
  origin: 'planning',
  impressions: 1000,
  reactions: 10,
  comments: 1,
  shares: 0,
  ...over,
});

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db);
  workspaceId = org.workspaceIds[0] as string;
  admin = await createUser(db, 'admin-rapport');
  await addMember(db, workspaceId, admin, 'admin');
  accountId = await createAccount(db, workspaceId);
  await asSystem(db, (trx) => trx.updateTable('workspaces').set({ created_at: new Date('2026-09-01T00:00:00Z') }).where('id', '=', workspaceId).execute());
});
afterAll(() => closeTestDatabase(db));

describe('mois de Paris', () => {
  it('bornes du mois en heure de Paris (heure d’hiver et d’été)', () => {
    expect(parisMonth(new Date('2026-11-20T10:00:00Z'))).toEqual({ start: new Date('2026-10-31T23:00:00Z'), end: new Date('2026-11-30T23:00:00Z') });
    expect(parisMonth(new Date('2026-07-01T00:30:00Z')).start).toEqual(new Date('2026-06-30T22:00:00Z'));
  });
});

describe('enseignements (SUI-04)', () => {
  it('compare des groupes réels, ne conclut pas sans assez de posts', () => {
    expect(computeInsights({ posts: [row({ withImage: true })], refusals: [] })).toEqual([]);
    const insights = computeInsights({
      posts: [row({ withImage: true, reactions: 40 }), row({ withImage: true, reactions: 50 }), row({ reactions: 5 }), row({ reactions: 8 })],
      refusals: [{ reason: 'Ton ou style inadapté', count: 3 }],
    });
    expect(insights.length).toBeLessThanOrEqual(3);
    expect(insights.map((i) => i.title)).toEqual(expect.arrayContaining([expect.stringContaining('avec visuel'), expect.stringContaining('Ton ou style inadapté')]));
    expect(insights.every((i) => i.guidance.length > 10)).toBe(true);
  });
});

describe('bilan mensuel (SUI-03, SUI-05)', () => {
  it('statistiques du mois, rapport PDF, enseignements enregistrés une fois et réinjectés', async () => {
    const posts: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const id = await createPost(db, workspaceId, accountId, { status: 'publie', scheduled_at: new Date(OCT.getTime() + i * 86_400_000), published_at: new Date(OCT.getTime() + i * 86_400_000), external_post_urn: `urn:li:share:${i}` });
      posts.push(id);
      await asSystem(db, (trx) =>
        trx.insertInto('post_stats').values({ post_id: id, workspace_id: workspaceId, day_offset: 7, impressions: 1000 + i, reactions: i < 2 ? 50 : 4, comments: 2, shares: 1 }).execute(),
      );
    }
    const overview = await monthlyOverview(db, admin, workspaceId, OCT);
    expect(overview.totals).toMatchObject({ withStats: 4, reactions: 108, comments: 8, shares: 4 });
    expect(overview.published).toBe(4);

    const report = await monthlyReportPdf(db, admin, workspaceId, OCT);
    expect(Buffer.from(report.pdf.slice(0, 5)).toString()).toBe('%PDF-');
    expect(report.fileName).toMatch(/2026-10\.pdf$/);

    await setMonthlyReportEmail(db, admin, workspaceId, true);
    const first = await closeMonth(db, new Date('2026-11-02T08:00:00Z'));
    expect(first.reports).toEqual([expect.objectContaining({ workspaceId, recipientIds: expect.arrayContaining([admin]) })]);
    const again = await closeMonth(db, new Date('2026-11-03T08:00:00Z'));
    expect(again.reports).toEqual([]);
    const stored = await asSystem(db, (trx) => trx.selectFrom('monthly_insights').select('month').where('workspace_id', '=', workspaceId).execute());
    expect(stored.map((s) => s.month)).toEqual(['2026-10-01']);
    expect(typeof (await asSystem(db, (trx) => latestInsightsGuidance(trx, workspaceId)))).toBe('string');
  });
});
