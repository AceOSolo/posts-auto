/**
 * PUB-08 : mention d'une page d'entreprise, saisie avec l'aide de l'éditeur. La personne
 * colle l'adresse de la page (linkedin.com/company/<nom>) ; la page est recherchée avec la
 * connexion du compte du post, et la mention est donnée au format de l'API :
 * « @[Nom de la page](urn:li:organization:123) », à placer dans le texte.
 *
 * Les personnes ne peuvent pas être recherchées par l'API de LinkedIn : un « @ » saisi à la
 * main reste interdit et signalé (RÈG-15) ; seules les mentions ainsi produites passent.
 */
import { type Database, asSystem, asUser } from '@posts-auto/db';
import type { LinkedInPages } from '@posts-auto/linkedin';
import { canEditPost, loadAccess } from '../access.ts';
import type { TokenCrypto } from '../accounts/pages.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';

const PAGE_URL = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|showcase)\/([A-Za-z0-9-_%]{2,100})\/?(?:[?#].*)?$/;

export async function resolvePageMention(
  db: Database,
  deps: { readonly pages: LinkedInPages; readonly cipher: TokenCrypto },
  userId: string,
  postId: string,
  pageUrl: string,
): Promise<{ readonly name: string; readonly urn: string; readonly mention: string }> {
  const vanity = PAGE_URL.exec(pageUrl.trim())?.[1];
  if (vanity === undefined) throw new RefusedError('page_mention_invalide', 'Collez l’adresse d’une page d’entreprise LinkedIn (linkedin.com/company/…).');
  const post = await asUser(db, userId, async (trx) => {
    const row = await trx.selectFrom('posts').select(['workspace_id', 'account_id']).where('id', '=', postId).executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Post');
    if (!canEditPost(await loadAccess(trx, userId, row.workspace_id, row.account_id))) throw new ForbiddenError('mention');
    return row;
  });
  const token = await asSystem(db, (trx) => trx.selectFrom('social_tokens').select('access_token_enc').where('account_id', '=', post.account_id).executeTakeFirst());
  if (token === undefined || deps.pages.lookupOrganization === undefined) throw new RefusedError('mention_indisponible', 'La recherche de pages n’est pas possible pour ce compte (connexion LinkedIn absente).');
  let accessToken: string;
  try {
    accessToken = deps.cipher.decrypt(token.access_token_enc, post.account_id);
  } catch {
    throw new RefusedError('mention_indisponible', 'Connexion LinkedIn illisible : reconnectez le compte.');
  }
  const found = await deps.pages.lookupOrganization(accessToken, decodeURIComponent(vanity));
  if (found === null) throw new RefusedError('page_introuvable', 'Page introuvable sur LinkedIn.');
  const name = found.name.replace(/[[\]\n]/g, ' ').trim();
  return { name, urn: found.urn, mention: `@[${name}](${found.urn})` };
}
