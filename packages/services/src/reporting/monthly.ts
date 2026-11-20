/**
 * Bilan mensuel d'un espace : statistiques LinkedIn (SUI-03), enseignements du mois (SUI-04)
 * et rapport PDF (SUI-05).
 *
 * Les enseignements sont calculés, pas rédigés par l'IA : ils comparent des groupes de posts
 * réels (avec ou sans visuel, courts ou longs, selon l'origine) et comptent les motifs de
 * refus. Un constat n'est fait qu'avec assez de posts de part et d'autre ; il n'invente donc
 * rien. Les trois premiers sont réinjectés dans la rédaction du mois suivant.
 */
import { REFUSAL_REASONS } from '@posts-auto/core';
import { type Database, type Tx, asSystem, asUser } from '@posts-auto/db';
import { sql } from 'kysely';
import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { canManageContent, workspaceRole } from '../access.ts';
import { ForbiddenError, NotFoundError } from '../errors.ts';

export interface Insight {
  readonly title: string;
  readonly detail: string;
  /** Consigne donnée à la rédaction. */
  readonly guidance: string;
}

export interface MonthlyPostRow {
  readonly accountName: string;
  readonly publishedAt: Date;
  readonly excerpt: string;
  readonly length: number;
  readonly withImage: boolean;
  readonly origin: string;
  readonly impressions: number | null;
  readonly reactions: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
}

export interface MonthlyReportData {
  readonly workspaceName: string;
  readonly orgName: string;
  readonly monthStart: Date;
  readonly monthEnd: Date;
  readonly published: number;
  readonly byAccount: readonly { readonly name: string; readonly published: number }[];
  readonly posts: readonly MonthlyPostRow[];
  readonly totals: { readonly impressions: number; readonly reactions: number; readonly comments: number; readonly shares: number; readonly withStats: number };
  readonly followers: readonly { readonly name: string; readonly start: number; readonly end: number }[];
  readonly refusals: readonly { readonly reason: string; readonly count: number }[];
  readonly validated: number;
  readonly refused: number;
  readonly insights: readonly Insight[];
}

const ORIGINS: Record<string, string> = {
  planning: 'le planning',
  event: 'les événements',
  team_idea: 'les idées de l’équipe',
  ai_idea: 'les idées de l’IA',
  ai_reserve: 'la réserve de sujets',
  request: 'les demandes de post',
  external_source: 'la veille',
};

/** Premier jour du mois (heure de Paris) contenant `at`, et premier jour du mois suivant. */
export function parisMonth(at: Date): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).formatToParts(at);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const startOf = (y: number, m: number) => {
    // Minuit à Paris : UTC+1 ou UTC+2 selon la saison.
    const guess = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
    const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'shortOffset' }).formatToParts(guess).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+1';
    const hours = Number(offset.replace('GMT', '') || '0');
    return new Date(guess.getTime() - hours * 3_600_000);
  };
  return { start: startOf(year, month), end: month === 12 ? startOf(year + 1, 1) : startOf(year, month + 1) };
}

const engagement = (p: MonthlyPostRow) => (p.reactions ?? 0) + 2 * (p.comments ?? 0) + 3 * (p.shares ?? 0);
const average = (rows: readonly MonthlyPostRow[]) => rows.reduce((sum, r) => sum + engagement(r), 0) / Math.max(1, rows.length);
const MIN_GROUP = 2;

/** SUI-04 : au plus 3 constats, chacun fondé sur des posts réels. */
export function computeInsights(data: Pick<MonthlyReportData, 'posts' | 'refusals'>): Insight[] {
  const insights: (Insight & { weight: number })[] = [];
  const measured = data.posts.filter((p) => p.reactions !== null || p.comments !== null);

  const compare = (label: string, a: MonthlyPostRow[], b: MonthlyPostRow[], aLabel: string, bLabel: string, guidanceA: string, guidanceB: string) => {
    if (a.length < MIN_GROUP || b.length < MIN_GROUP) return;
    const [ea, eb] = [average(a), average(b)];
    if (Math.max(ea, eb) === 0) return;
    const ratio = Math.max(ea, eb) / Math.max(0.5, Math.min(ea, eb));
    if (ratio < 1.3) return;
    const aWins = ea > eb;
    insights.push({
      title: `${label} : ${aWins ? aLabel : bLabel} marchent mieux`,
      detail: `Engagement moyen ${Math.round(aWins ? ea : eb)} contre ${Math.round(aWins ? eb : ea)} (${a.length} et ${b.length} posts mesurés).`,
      guidance: aWins ? guidanceA : guidanceB,
      weight: ratio,
    });
  };

  compare(
    'Visuels',
    measured.filter((p) => p.withImage),
    measured.filter((p) => !p.withImage),
    'les posts avec visuel',
    'les posts sans visuel',
    'Les posts avec un visuel ont mieux marché le mois dernier : proposer des sujets qui s’illustrent bien.',
    'Les posts sans visuel ont mieux marché le mois dernier : soigner l’accroche et le texte avant tout.',
  );
  const median = [...measured].map((p) => p.length).sort((x, y) => x - y)[Math.floor(measured.length / 2)] ?? 0;
  compare(
    'Longueur',
    measured.filter((p) => p.length <= Math.min(median, 900)),
    measured.filter((p) => p.length > Math.min(median, 900)),
    'les posts courts',
    'les posts plus longs',
    'Les posts courts ont mieux marché le mois dernier : aller à l’essentiel.',
    'Les posts plus développés ont mieux marché le mois dernier : ne pas hésiter à détailler un exemple concret.',
  );
  const byOrigin = new Map<string, MonthlyPostRow[]>();
  for (const p of measured) byOrigin.set(p.origin, [...(byOrigin.get(p.origin) ?? []), p]);
  const origins = [...byOrigin.entries()].filter(([, rows]) => rows.length >= MIN_GROUP).sort((x, y) => average(y[1]) - average(x[1]));
  if (origins.length >= 2) {
    const [best, worst] = [origins[0], origins[origins.length - 1]] as [[string, MonthlyPostRow[]], [string, MonthlyPostRow[]]];
    if (average(best[1]) >= 1.3 * Math.max(0.5, average(worst[1]))) {
      insights.push({
        title: `Sujets : ceux tirés de ${ORIGINS[best[0]] ?? best[0]} marchent le mieux`,
        detail: `Engagement moyen ${Math.round(average(best[1]))} contre ${Math.round(average(worst[1]))} pour ${ORIGINS[worst[0]] ?? worst[0]}.`,
        guidance: `Les sujets tirés de ${ORIGINS[best[0]] ?? best[0]} ont le mieux marché le mois dernier : leur donner la priorité quand le choix est possible.`,
        weight: average(best[1]) / Math.max(0.5, average(worst[1])),
      });
    }
  }
  const topRefusal = data.refusals[0];
  if (topRefusal !== undefined && topRefusal.count >= 2) {
    insights.push({
      title: `Refus : « ${topRefusal.reason} » revient ${topRefusal.count} fois`,
      detail: 'C’est le motif de refus le plus fréquent du mois.',
      guidance: `Motif de refus le plus fréquent le mois dernier : « ${topRefusal.reason} ». En tenir compte dans le choix des sujets et le ton.`,
      weight: 10 + topRefusal.count,
    });
  }
  return insights
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map(({ weight: _weight, ...rest }) => rest);
}

/** Données du bilan, lues sous l'identité système (l'appelant a vérifié les droits). */
export async function monthlyReportData(trx: Tx, workspaceId: string, monthStart: Date, monthEnd: Date): Promise<MonthlyReportData> {
  const ws = await trx.selectFrom('workspaces as w').innerJoin('organizations as o', 'o.id', 'w.org_id').select(['w.name', 'o.name as org']).where('w.id', '=', workspaceId).executeTakeFirst();
  if (ws === undefined) throw new NotFoundError('Espace');
  const rows = await trx
    .selectFrom('posts as p')
    .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
    .leftJoin('post_versions as v', 'v.id', 'p.current_version_id')
    .select([
      'p.id',
      'p.published_at',
      'p.origin',
      'a.display_name',
      'v.body',
      sql<boolean>`exists (select 1 from post_media m where m.post_id = p.id)`.as('with_image'),
      sql<Record<string, number | null> | null>`(select to_jsonb(s) from post_stats s where s.post_id = p.id and s.available order by s.day_offset desc limit 1)`.as('stats'),
    ])
    .where('p.workspace_id', '=', workspaceId)
    .where('p.status', '=', 'publie')
    .where('p.published_at', '>=', monthStart)
    .where('p.published_at', '<', monthEnd)
    .orderBy('p.published_at')
    .execute();
  const posts: MonthlyPostRow[] = rows.map((r) => ({
    accountName: r.display_name ?? 'Compte',
    publishedAt: r.published_at as Date,
    excerpt: (r.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
    length: (r.body ?? '').length,
    withImage: r.with_image,
    origin: r.origin,
    impressions: r.stats?.['impressions'] ?? null,
    reactions: r.stats?.['reactions'] ?? null,
    comments: r.stats?.['comments'] ?? null,
    shares: r.stats?.['shares'] ?? null,
  }));
  const byAccount = new Map<string, number>();
  for (const p of posts) byAccount.set(p.accountName, (byAccount.get(p.accountName) ?? 0) + 1);
  const withStats = posts.filter((p) => p.reactions !== null || p.impressions !== null);
  const sum = (key: 'impressions' | 'reactions' | 'comments' | 'shares') => withStats.reduce((total, p) => total + (p[key] ?? 0), 0);

  const followers = await trx
    .selectFrom('account_followers as f')
    .innerJoin('social_accounts as a', 'a.id', 'f.account_id')
    .select([
      'a.display_name',
      sql<number>`(array_agg(f.followers order by f.captured_on asc))[1]`.as('start'),
      sql<number>`(array_agg(f.followers order by f.captured_on desc))[1]`.as('end'),
    ])
    .where('f.workspace_id', '=', workspaceId)
    .where('f.captured_on', '>=', sql<string>`(${monthStart}::timestamptz at time zone 'Europe/Paris')::date`)
    .where('f.captured_on', '<', sql<string>`(${monthEnd}::timestamptz at time zone 'Europe/Paris')::date`)
    .groupBy(['a.id', 'a.display_name'])
    .execute();

  const decisions = await trx
    .selectFrom('post_status_history')
    .select(['to_status', 'reason'])
    .where('workspace_id', '=', workspaceId)
    .where('to_status', 'in', ['valide', 'refuse'])
    .where('actor_kind', '=', 'user')
    .where('at', '>=', monthStart)
    .where('at', '<', monthEnd)
    .execute();
  const refusalCounts = new Map<string, number>();
  for (const d of decisions.filter((x) => x.to_status === 'refuse')) {
    const key = (d.reason ?? 'autre').split(' : ')[0] as keyof typeof REFUSAL_REASONS;
    const label = REFUSAL_REASONS[key] ?? 'Autre';
    refusalCounts.set(label, (refusalCounts.get(label) ?? 0) + 1);
  }
  const refusals = [...refusalCounts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  const base = { posts, refusals };
  return {
    workspaceName: ws.name,
    orgName: ws.org,
    monthStart,
    monthEnd,
    published: posts.length,
    byAccount: [...byAccount.entries()].map(([name, published]) => ({ name, published })).sort((a, b) => b.published - a.published),
    posts,
    totals: { impressions: sum('impressions'), reactions: sum('reactions'), comments: sum('comments'), shares: sum('shares'), withStats: withStats.length },
    followers: followers.map((f) => ({ name: f.display_name ?? 'Page', start: f.start, end: f.end })),
    refusals,
    validated: decisions.filter((d) => d.to_status === 'valide').length,
    refused: decisions.filter((d) => d.to_status === 'refuse').length,
    insights: computeInsights(base),
  };
}

// ---------------------------------------------------------------------------
// Rapport PDF (SUI-05)
// ---------------------------------------------------------------------------

/** Les polices standard du PDF couvrent le jeu WinAnsi : le reste est remplacé. */
function winAnsi(text: string): string {
  const extra = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
  return text
    .replace(/[   ]/g, ' ')
    .replace(/[‘’]/g, '’')
    .split('')
    .map((c) => {
      const code = c.charCodeAt(0);
      return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || extra.includes(c) ? c : code === 10 ? c : '';
    })
    .join('');
}

class Writer {
  page: PDFPage;
  y: number;
  constructor(
    readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.page = doc.addPage([595.28, 841.89]);
    this.y = 790;
  }
  ensure(height: number) {
    if (this.y - height < 50) {
      this.page = this.doc.addPage([595.28, 841.89]);
      this.y = 790;
    }
  }
  text(value: string, options: { size?: number; bold?: boolean; color?: [number, number, number]; indent?: number } = {}) {
    const size = options.size ?? 10.5;
    const font = options.bold ? this.bold : this.regular;
    const width = 495 - (options.indent ?? 0);
    const words = winAnsi(value).split(/\s+/);
    let line = '';
    const lines: string[] = [];
    for (const word of words) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) > width && line !== '') {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line !== '') lines.push(line);
    for (const l of lines) {
      this.ensure(size * 1.45);
      this.page.drawText(l, { x: 50 + (options.indent ?? 0), y: this.y, size, font, color: rgb(...(options.color ?? [0.09, 0.13, 0.17])) });
      this.y -= size * 1.45;
    }
  }
  gap(h = 8) {
    this.y -= h;
  }
}

const nf = (n: number) => new Intl.NumberFormat('fr-FR').format(n).replace(/ /g, ' ');

export async function renderMonthlyReportPdf(data: MonthlyReportData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const month = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', month: 'long', year: 'numeric' }).format(data.monthStart);
  doc.setTitle(`Rapport LinkedIn ${month} - ${data.workspaceName}`);
  doc.setProducer('Rostra');
  doc.setCreationDate(new Date(data.monthEnd.getTime() - 1));
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  const primary: [number, number, number] = [0.06, 0.24, 0.37];

  w.text(`Rapport LinkedIn · ${month}`, { size: 20, bold: true, color: primary });
  w.text(`${data.workspaceName} (${data.orgName})`, { size: 12 });
  w.gap(14);

  w.text('En bref', { size: 14, bold: true, color: primary });
  w.text(`${data.published} post${data.published > 1 ? 's' : ''} publié${data.published > 1 ? 's' : ''} · ${data.validated} validé${data.validated > 1 ? 's' : ''} · ${data.refused} refusé${data.refused > 1 ? 's' : ''}`);
  if (data.totals.withStats > 0) {
    w.text(
      `Sur ${data.totals.withStats} post${data.totals.withStats > 1 ? 's' : ''} mesuré${data.totals.withStats > 1 ? 's' : ''} : ${nf(data.totals.impressions)} impressions, ${nf(data.totals.reactions)} réactions, ${nf(data.totals.comments)} commentaires, ${nf(data.totals.shares)} partages.`,
    );
  } else {
    w.text('Statistiques LinkedIn non disponibles pour ce mois (permission de lecture des statistiques non accordée, ou posts trop récents).');
  }
  for (const f of data.followers) w.text(`Abonnés de ${f.name} : ${nf(f.start)} → ${nf(f.end)} (${f.end - f.start >= 0 ? '+' : ''}${nf(f.end - f.start)})`);
  w.gap(10);

  if (data.byAccount.length > 0) {
    w.text('Par compte', { size: 14, bold: true, color: primary });
    for (const a of data.byAccount) w.text(`${a.name} : ${a.published} post${a.published > 1 ? 's' : ''}`, { indent: 10 });
    w.gap(10);
  }

  const top = [...data.posts].filter((p) => p.reactions !== null).sort((a, b) => engagement(b) - engagement(a)).slice(0, 3);
  if (top.length > 0) {
    w.text('Posts les plus engageants', { size: 14, bold: true, color: primary });
    for (const p of top) {
      w.text(`${p.accountName} · ${new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long' }).format(p.publishedAt)}`, { bold: true, indent: 10 });
      w.text(`« ${p.excerpt}${p.length > 140 ? '…' : ''} »`, { indent: 10 });
      w.text(`${p.impressions === null ? '' : `${nf(p.impressions)} impressions · `}${p.reactions ?? 0} réactions · ${p.comments ?? 0} commentaires · ${p.shares ?? 0} partages`, { indent: 10, size: 9.5 });
      w.gap(4);
    }
    w.gap(6);
  }

  w.text('Enseignements du mois', { size: 14, bold: true, color: primary });
  if (data.insights.length === 0) w.text('Pas encore assez de posts mesurés ou de décisions pour tirer un enseignement fiable.');
  for (const i of data.insights) {
    w.text(i.title, { bold: true, indent: 10 });
    w.text(i.detail, { indent: 10 });
    w.gap(4);
  }
  if (data.refusals.length > 0) {
    w.gap(6);
    w.text('Motifs de refus', { size: 14, bold: true, color: primary });
    for (const r of data.refusals) w.text(`${r.reason} : ${r.count}`, { indent: 10 });
  }
  w.gap(16);
  w.text('Statistiques fournies par LinkedIn quand elles sont disponibles (relevées à J+1, J+7 et J+30). Rapport produit automatiquement.', { size: 8.5, color: [0.35, 0.4, 0.45] });
  return doc.save();
}

// ---------------------------------------------------------------------------
// Accès depuis l'application
// ---------------------------------------------------------------------------

async function memberRole(db: Database, userId: string, workspaceId: string) {
  const role = await asUser(db, userId, (trx) => workspaceRole(trx, userId, workspaceId));
  if (role === null) throw new NotFoundError('Espace');
  return role;
}

/** SUI-05 : rapport PDF d'un mois (`month` : un instant du mois voulu), pour les membres de l'espace. */
export async function monthlyReportPdf(db: Database, userId: string, workspaceId: string, month: Date): Promise<{ pdf: Uint8Array; fileName: string }> {
  await memberRole(db, userId, workspaceId);
  const { start, end } = parisMonth(month);
  const data = await asSystem(db, (trx) => monthlyReportData(trx, workspaceId, start, end));
  const label = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(start);
  return { pdf: await renderMonthlyReportPdf(data), fileName: `rapport-${data.workspaceName}-${label}.pdf` };
}

/** SUI-03, SUI-04 : statistiques et enseignements pour le tableau de bord. */
export async function monthlyOverview(db: Database, userId: string, workspaceId: string, now: Date) {
  const role = await memberRole(db, userId, workspaceId);
  const { start, end } = parisMonth(now);
  return asSystem(db, async (trx) => {
    const data = await monthlyReportData(trx, workspaceId, start, end);
    const stored = await trx.selectFrom('monthly_insights').select(['month', 'insights']).where('workspace_id', '=', workspaceId).orderBy('month', 'desc').limit(1).executeTakeFirst();
    const ws = await trx.selectFrom('workspaces').select('monthly_report_email').where('id', '=', workspaceId).executeTakeFirstOrThrow();
    return {
      totals: data.totals,
      published: data.published,
      followers: data.followers,
      lastInsights: stored === undefined ? null : { month: new Date(stored.month), insights: stored.insights as unknown as Insight[] },
      reportByEmail: ws.monthly_report_email,
      canManage: canManageContent(role),
    };
  });
}

/** SUI-05 : envoi automatique du rapport, chaque mois, aux administrateurs (facultatif). */
export async function setMonthlyReportEmail(db: Database, userId: string, workspaceId: string, enabled: boolean): Promise<void> {
  const role = await memberRole(db, userId, workspaceId);
  if (!canManageContent(role)) throw new ForbiddenError('monthlyReport');
  await asSystem(db, (trx) => trx.updateTable('workspaces').set({ monthly_report_email: enabled }).where('id', '=', workspaceId).execute());
}

/**
 * Tâche du début de mois : enregistre les enseignements du mois écoulé de chaque espace
 * (SUI-04) et renvoie les rapports à envoyer (SUI-05). Une seule fois par espace et par mois.
 */
export async function closeMonth(db: Database, now: Date): Promise<{ readonly insights: number; readonly reports: readonly { readonly workspaceId: string; readonly month: Date; readonly recipientIds: readonly string[] }[] }> {
  const current = parisMonth(now);
  const previous = parisMonth(new Date(current.start.getTime() - 86_400_000));
  const monthKey = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(previous.start);
  return asSystem(db, async (trx) => {
    const workspaces = await trx.selectFrom('workspaces').select(['id', 'org_id', 'monthly_report_email']).where('status', '=', 'active').where('created_at', '<', previous.end).execute();
    let insights = 0;
    const reports: { workspaceId: string; month: Date; recipientIds: string[] }[] = [];
    for (const w of workspaces) {
      const exists = await trx.selectFrom('monthly_insights').select('month').where('workspace_id', '=', w.id).where('month', '=', monthKey).executeTakeFirst();
      if (exists === undefined) {
        const data = await monthlyReportData(trx, w.id, previous.start, previous.end);
        await trx.insertInto('monthly_insights').values({ workspace_id: w.id, month: monthKey, insights: JSON.stringify(data.insights), created_at: now }).onConflict((oc) => oc.columns(['workspace_id', 'month']).doNothing()).execute();
        insights += 1;
      }
      if (w.monthly_report_email) {
        const sent = await trx
          .insertInto('monthly_reports_sent')
          .values({ workspace_id: w.id, month: monthKey, sent_at: now })
          .onConflict((oc) => oc.columns(['workspace_id', 'month']).doNothing())
          .returning('workspace_id')
          .executeTakeFirst();
        if (sent !== undefined) {
          const admins = await trx.selectFrom('workspace_members').select('user_id').where('workspace_id', '=', w.id).where('role', 'in', ['admin', 'editor']).execute();
          const owners = await trx.selectFrom('org_members').select('user_id').where('org_id', '=', w.org_id).where('role', '=', 'owner').execute();
          reports.push({ workspaceId: w.id, month: previous.start, recipientIds: [...new Set([...admins, ...owners].map((r) => r.user_id))] });
        }
      }
    }
    return { insights, reports };
  });
}

/** SUI-04 : consignes tirées des derniers enseignements, ajoutées au contexte de la rédaction. */
export async function latestInsightsGuidance(trx: Tx, workspaceId: string): Promise<string> {
  const row = await trx.selectFrom('monthly_insights').select('insights').where('workspace_id', '=', workspaceId).orderBy('month', 'desc').limit(1).executeTakeFirst();
  const list = (row?.insights ?? []) as unknown as Insight[];
  return list.map((i) => i.guidance).join(' ');
}
