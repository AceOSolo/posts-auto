/** GET /api/v1/comptes : comptes LinkedIn de l'espace de la clé. */
import { listAccounts } from '@posts-auto/services';
import { withApiKey } from '../../../../server/api.ts';
import { database } from '../../../../server/context.ts';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return withApiKey(request, async (ctx) => Response.json({ comptes: await listAccounts(database(), ctx) }));
}
