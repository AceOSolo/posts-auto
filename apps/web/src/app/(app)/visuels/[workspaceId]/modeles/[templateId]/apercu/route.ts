/**
 * Aperçu d'un modèle (VIS-02), avec des textes d'exemple et le logo de la charte :
 * - GET : le modèle enregistré (bibliothèque, éditeur sans JavaScript) ;
 * - POST : le brouillon du formulaire de l'éditeur (aperçu en direct), sans rien enregistrer.
 * Réservé aux membres de l'espace du modèle. Les problèmes de lisibilité relevés au rendu
 * sont renvoyés dans l'en-tête X-Problemes (JSON encodé).
 */
import { NotFoundError, findMediaForUser, getTemplate } from '@posts-auto/services';
import { type TemplateDefinition, TemplateError, parseTemplate, renderTemplate, sampleContent } from '@posts-auto/visuals';
import { database, mediaStore } from '../../../../../../../server/context.ts';
import { currentUserId } from '../../../../../../../server/session.ts';
import { definitionFromForm } from '../../../../../../../server/template-form.ts';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Response('Introuvable', { status: 404 });

async function preview(params: Promise<{ workspaceId: string; templateId: string }>, draft: FormData | null): Promise<Response> {
  const { workspaceId, templateId } = await params;
  const userId = await currentUserId();
  if (userId === null || !UUID.test(workspaceId) || !UUID.test(templateId)) return notFound();
  let template;
  try {
    template = await getTemplate(database(), userId, templateId);
  } catch (error) {
    if (error instanceof NotFoundError) return notFound();
    throw error;
  }
  if (template.workspaceId !== workspaceId) return notFound();

  let definition: TemplateDefinition = template.definition;
  if (draft !== null) {
    try {
      definition = parseTemplate(definitionFromForm(draft));
    } catch (error) {
      if (error instanceof TemplateError) return new Response(error.message, { status: 422, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      throw error;
    }
  }
  const logoAsset = template.branding.logoAssetId === null ? null : await findMediaForUser(database(), userId, template.branding.logoAssetId);
  const logo = logoAsset === null ? null : await mediaStore().read(logoAsset.storageKey).catch(() => null);
  const result = await renderTemplate(definition, await sampleContent({ logo }));
  return new Response(new Uint8Array(result.png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'",
      'X-Problemes': encodeURIComponent(JSON.stringify(result.issues.map((i) => i.message))),
    },
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ workspaceId: string; templateId: string }> }) {
  return preview(params, null);
}

export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; templateId: string }> }) {
  return preview(params, await request.formData());
}
