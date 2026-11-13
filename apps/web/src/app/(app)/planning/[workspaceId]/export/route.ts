/**
 * PLA-09 : export du planning du trimestre en CSV (séparateur « ; » et BOM, pour Excel en
 * français). Mêmes droits que la page du planning ; rien d'un autre client (RLS).
 */
import { NotFoundError, cellKey, planningGrid } from '@posts-auto/services';
import { database } from '../../../../../server/context.ts';
import { currentUserId } from '../../../../../server/session.ts';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE: Record<string, string> = { planned: 'prévu', drafted: 'rédigé', validated: 'validé', published: 'publié', set_aside: 'mis de côté' };

/** Cellule CSV : guillemets doublés, et neutralisation des formules (=, +, -, @) à l'ouverture dans un tableur. */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const userId = await currentUserId();
  if (userId === null || !UUID.test(workspaceId)) return new Response('Introuvable', { status: 404 });
  const from = new URL(request.url).searchParams.get('depuis') ?? undefined;
  let grid;
  try {
    grid = await planningGrid(database(), userId, workspaceId, { weeks: 13, ...(from && { from }) }, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) return new Response('Introuvable', { status: 404 });
    throw error;
  }
  const header = ['Ligne', ...grid.weeks.map((w) => `S${w.isoWeek} (${w.weekStart})`)];
  const lines = grid.rows.map((row) => [
    row.label,
    ...grid.weeks.map((w) =>
      (grid.entries[cellKey(row.row, w.weekStart)] ?? []).map((e) => `${e.content} [${STATE[e.status.state] ?? e.status.state}]`).join('\n'),
    ),
  ]);
  const csv = `﻿${[header, ...lines].map((line) => line.map(cell).join(';')).join('\r\n')}\r\n`;
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="planning-${grid.weeks[0]?.weekStart ?? 'export'}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
