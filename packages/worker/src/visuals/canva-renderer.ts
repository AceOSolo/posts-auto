/**
 * VIS-07 : rendu d'un modèle de marque Canva pour un post : jeton de l'espace (renouvelé au
 * besoin), photo envoyée dans les fichiers Canva du client, copie remplie, export PNG.
 */
import { type Database, asSystem } from '@posts-auto/db';
import { canvaAccessToken } from '@posts-auto/services';
import { type CanvaApi, type CanvaAutofillData, CanvaError } from '@posts-auto/visuals';
import type { TokenCipher } from '../secrets/token-cipher.ts';
import type { CanvaRenderer } from './prepare.ts';

export function canvaRenderer(db: Database, api: CanvaApi, cipher: TokenCipher, clock: () => Date = () => new Date()): CanvaRenderer {
  return async ({ workspaceId, brandTemplateId, fields, title, content }) => {
    const token = await asSystem(db, (trx) => canvaAccessToken(trx, api, cipher, workspaceId, clock()));
    if (token === null) throw new CanvaError('Canva n’est plus connecté à cet espace.', false);
    const data: Record<string, CanvaAutofillData[string]> = {};
    if (fields.title) data[fields.title] = { type: 'text', text: content.title };
    if (fields.subtitle && content.subtitle) data[fields.subtitle] = { type: 'text', text: content.subtitle };
    if (fields.bullets && content.bullets.length > 0) data[fields.bullets] = { type: 'text', text: content.bullets.join('\n') };
    if (fields.signature) data[fields.signature] = { type: 'text', text: content.signature };
    if (fields.photo && content.photo) data[fields.photo] = { type: 'image', assetId: await api.uploadImage(token, `photo-${Date.now()}.png`, content.photo) };
    return (await api.renderPng(token, brandTemplateId, title, data)).png;
  };
}
