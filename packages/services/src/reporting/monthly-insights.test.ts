/** SUI-04 et SUI-05 sur des données construites : chaque enseignement, et le rapport complet. */
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { type MonthlyPostRow, type MonthlyReportData, computeInsights, renderMonthlyReportPdf } from './monthly.ts';

const OCT = new Date('2026-10-15T10:00:00Z');
const post = (over: Partial<MonthlyPostRow>): MonthlyPostRow => ({
  accountName: 'Marie',
  publishedAt: OCT,
  excerpt: 'Un texte de post',
  length: 600,
  withImage: false,
  origin: 'planning',
  impressions: 1000,
  reactions: 10,
  comments: 1,
  shares: 0,
  ...over,
});

describe('enseignements du mois (SUI-04)', () => {
  it('longueur : les posts courts ou les plus longs', () => {
    const short = [post({ length: 300, reactions: 40 }), post({ length: 320, reactions: 50 })];
    const long = [post({ length: 1500, reactions: 5 }), post({ length: 1600, reactions: 6 })];
    expect(computeInsights({ posts: [...short, ...long], refusals: [] }).map((i) => i.title)).toContain('Longueur : les posts courts marchent mieux');
    const reverse = [post({ length: 300, reactions: 2 }), post({ length: 320, reactions: 3 }), post({ length: 1500, reactions: 40 }), post({ length: 1600, reactions: 45 })];
    expect(computeInsights({ posts: reverse, refusals: [] }).some((i) => /plus longs/.test(i.title))).toBe(true);
  });

  it('origine des sujets ; sans les visuels quand ils ont fait moins bien', () => {
    const posts = [
      post({ origin: 'event', reactions: 60, withImage: false }),
      post({ origin: 'event', reactions: 50, withImage: false }),
      post({ origin: 'ai_idea', reactions: 4, withImage: true }),
      post({ origin: 'ai_idea', reactions: 3, withImage: true }),
    ];
    const titles = computeInsights({ posts, refusals: [] }).map((i) => i.title);
    expect(titles).toContain('Sujets : ceux tirés des événements marchent le mieux');
    expect(titles).toContain('Visuels : les posts sans visuel marchent mieux');
  });

  it('pas de constat sans écart net, ni sans statistiques, ni pour un refus isolé', () => {
    const even = [post({ withImage: true }), post({ withImage: true }), post({}), post({})];
    expect(computeInsights({ posts: even, refusals: [{ reason: 'Ton', count: 1 }] })).toEqual([]);
    const unmeasured = [post({ reactions: null, comments: null }), post({ reactions: null, comments: null })];
    expect(computeInsights({ posts: unmeasured, refusals: [] })).toEqual([]);
    const zero = [post({ withImage: true, reactions: 0, comments: 0 }), post({ withImage: true, reactions: 0, comments: 0 }), post({ reactions: 0, comments: 0 }), post({ reactions: 0, comments: 0 })];
    expect(computeInsights({ posts: zero, refusals: [] })).toEqual([]);
  });
});

describe('rapport mensuel PDF (SUI-05)', () => {
  const data = (over: Partial<MonthlyReportData>): MonthlyReportData => ({
    workspaceName: 'Acme',
    orgName: 'Acme SAS',
    monthStart: new Date('2026-09-30T22:00:00Z'),
    monthEnd: new Date('2026-10-31T23:00:00Z'),
    published: 0,
    byAccount: [],
    posts: [],
    totals: { impressions: 0, reactions: 0, comments: 0, shares: 0, withStats: 0 },
    followers: [],
    refusals: [],
    validated: 0,
    refused: 0,
    insights: [],
    ...over,
  });

  it('mois vide : rapport d’une page, sans statistiques', async () => {
    const pdf = await PDFDocument.load(await renderMonthlyReportPdf(data({})));
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toMatch(/octobre 2026/);
  });

  it('mois chargé : chiffres, comptes, posts les plus engageants, abonnés, enseignements, refus ; texte long sur plusieurs pages', async () => {
    const posts = Array.from({ length: 40 }, (_, i) => post({ excerpt: `Post numéro ${i} — avec des caractères ‘spéciaux’ 🚀 et une phrase assez longue pour devoir passer à la ligne dans le rapport`, reactions: i, length: 200 }));
    const bytes = await renderMonthlyReportPdf(
      data({
        published: 40,
        byAccount: Array.from({ length: 30 }, (_, i) => ({ name: `Compte ${i}`, published: i + 1 })),
        posts,
        totals: { impressions: 12_345, reactions: 780, comments: 40, shares: 12, withStats: 40 },
        followers: [
          { name: 'Page Acme', start: 1000, end: 1100 },
          { name: 'Page Filiale', start: 500, end: 480 },
        ],
        refusals: [{ reason: 'Ton ou style inadapté', count: 3 }],
        validated: 40,
        refused: 3,
        insights: [{ title: 'Visuels : les posts avec visuel marchent mieux', detail: 'Engagement moyen 40 contre 5.', guidance: '…' }],
      }),
    );
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });
});
