/** GET /api/v1/posts/{reference} : un post et la décision de son titulaire. */
import { getPostByReference } from '@posts-auto/services';
import { withApiKey } from '../../../../../server/api.ts';
import { database } from '../../../../../server/context.ts';

export const dynamic = 'force-dynamic';

export function GET(request: Request, { params }: { params: Promise<{ reference: string }> }) {
  return withApiKey(request, async (ctx) => {
    const { reference } = await params;
    return Response.json({ post: await getPostByReference(database(), ctx, decodeURIComponent(reference)) });
  });
}
