/** SUI-05 : rapport mensuel PDF de l'espace (mois en cours, ou ?mois=precedent), pour ses membres. */
import { NotFoundError, monthlyReportPdf } from '@posts-auto/services';
import { database } from '../../../../../server/context.ts';
import { currentUserId } from '../../../../../server/session.ts';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const userId = await currentUserId();
  if (userId === null || !UUID.test(workspaceId)) return new Response('Introuvable', { status: 404 });
  const previous = new URL(request.url).searchParams.get('mois') === 'precedent';
  const now = new Date();
  const month = previous ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)) : now;
  let report;
  try {
    report = await monthlyReportPdf(database(), userId, workspaceId, month);
  } catch (error) {
    if (error instanceof NotFoundError) return new Response('Introuvable', { status: 404 });
    throw error;
  }
  return new Response(new Uint8Array(report.pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${report.fileName.replace(/[^\w.-]/g, '_')}"`,
      'Cache-Control': 'no-store',
    },
  });
}
