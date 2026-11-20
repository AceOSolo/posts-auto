/**
 * SUI-06 : export CSV de tous les posts de l'espace. Mêmes droits que le tableau de bord ;
 * rien d'un autre client (RLS). Seules des données produites par l'outil (L7).
 */
import { NotFoundError, exportPosts } from '@posts-auto/services';
import { STATUS_LABELS } from '../../../../../components/status-badge.tsx';
import { database } from '../../../../../server/context.ts';
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
    data = await exportPosts(database(), userId, workspaceId);
  } catch (error) {
    if (error instanceof NotFoundError) return new Response('Introuvable', { status: 404 });
    throw error;
  }
  const format = new Intl.DateTimeFormat('fr-FR', { timeZone: data.timeZone, dateStyle: 'short', timeStyle: 'short' });
  const date = (value: Date | null) => (value === null ? '' : format.format(value));
  const header = ['Créneau', 'Compte', 'Type', 'Statut', 'Origine', 'Sujet', 'Texte', 'Images', 'Image générée par IA', 'Version', 'Décidé le', 'Décidé par', 'Publié le', 'Lien LinkedIn'];
  const lines = data.rows.map((r) => [
    date(r.scheduledAt),
    r.accountName,
    r.accountKind === 'page' ? 'Page' : 'Profil',
    STATUS_LABELS[r.status] ?? r.status,
    r.origin,
    r.subject,
    r.body,
    r.images,
    r.aiImage ? 'oui' : 'non',
    r.versionNo,
    date(r.decidedAt),
    r.decidedBy,
    date(r.publishedAt),
    r.url,
  ]);
  return csvResponse(toCsv([header, ...lines]), `posts-${data.workspaceName}.csv`);
}
