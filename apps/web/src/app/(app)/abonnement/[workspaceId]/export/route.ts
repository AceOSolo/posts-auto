/**
 * FAC-07 : usage par espace et par mois (posts, images, coût de l'IA), pour qu'une agence
 * refacture ses clients. Réservé au propriétaire de l'organisation.
 */
import { ForbiddenError, NotFoundError, usageExport } from '@posts-auto/services';
import { database, usdToEur } from '../../../../../server/context.ts';
import { csvResponse, toCsv } from '../../../../../server/csv.ts';
import { currentUserId } from '../../../../../server/session.ts';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const userId = await currentUserId();
  if (userId === null || !UUID.test(workspaceId)) return new Response('Introuvable', { status: 404 });
  let data;
  try {
    data = await usageExport(database(), userId, workspaceId, new Date(), usdToEur());
  } catch (error) {
    if (error instanceof NotFoundError) return new Response('Introuvable', { status: 404 });
    if (error instanceof ForbiddenError) return new Response('Réservé au propriétaire de l’organisation', { status: 403 });
    throw error;
  }
  const header = ['Espace', 'Mois', 'Posts rédigés (quota)', 'Images générées', 'Coût IA estimé (EUR HT)'];
  const lines = data.rows.map((r) => [r.workspaceName, r.month, r.posts, r.images, r.aiCostEur.toFixed(2).replace('.', ',')]);
  return csvResponse(toCsv([header, ...lines]), `usage-${data.orgName}.csv`);
}
