/**
 * Export des données d'une personne (RGPD, section 10.2 ; REC-12) : archive JSON + images,
 * complète et limitée à cette personne.
 *
 * Limitée à la personne : quand une autre personne a agi sur ses posts (décision d'un
 * délégué, correction d'un éditeur), son identité n'apparaît pas — seulement « une autre
 * personne de l'espace ». Les données d'autrui ne sortent pas par l'export d'un tiers.
 *
 * Lu en contexte système (les sessions et le journal ne sont pas visibles par l'application
 * web), mais toujours filtré par l'identifiant de la personne.
 */
import { type Database, asSystem } from '@posts-auto/db';
import { createZip, type ZipEntry } from './zip.ts';

export interface MediaReader {
  read(storageKey: string): Promise<Uint8Array>;
}

const OTHER_PERSON = 'une autre personne de l’espace';
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

export async function exportUserData(db: Database, media: MediaReader, userId: string, now: Date): Promise<{ archive: Uint8Array; fileName: string }> {
  const data = await asSystem(db, async (trx) => {
    const user = await trx.selectFrom('users').select(['email', 'full_name', 'locale', 'created_at', 'last_login_at']).where('id', '=', userId).executeTakeFirstOrThrow();
    const memberships = await trx
      .selectFrom('workspace_members as m')
      .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
      .select(['w.name as espace', 'm.role as role', 'm.created_at as depuis'])
      .where('m.user_id', '=', userId)
      .execute();
    const organizations = await trx
      .selectFrom('org_members as o')
      .innerJoin('organizations as org', 'org.id', 'o.org_id')
      .select(['org.name as organisation', 'o.role as role'])
      .where('o.user_id', '=', userId)
      .execute();
    const accounts = await trx
      .selectFrom('social_accounts')
      .select(['id', 'kind', 'display_name', 'external_urn', 'profile_url', 'status', 'created_at'])
      .where('holder_user_id', '=', userId)
      .execute();
    const accountIds = accounts.map((a) => a.id);
    const consents = await trx
      .selectFrom('account_consents')
      .select(['account_id', 'kind', 'text_version', 'granted_at', 'revoked_at', 'ip'])
      .where('user_id', '=', userId)
      .execute();
    const posts =
      accountIds.length === 0
        ? []
        : await trx
            .selectFrom('posts as p')
            .leftJoin('post_versions as v', 'v.id', 'p.current_version_id')
            .select(['p.id', 'p.account_id', 'p.status', 'p.scheduled_at', 'p.published_at', 'p.external_post_url', 'p.decided_by', 'p.decided_at', 'p.decision_note', 'v.body'])
            .where('p.account_id', 'in', accountIds)
            .orderBy('p.scheduled_at')
            .execute();
    const postMedia =
      posts.length === 0
        ? []
        : await trx
            .selectFrom('post_media as pm')
            .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
            .select(['pm.post_id', 'pm.position', 'pm.alt_text', 'm.storage_key', 'm.mime', 'm.ai_generated'])
            .where('pm.post_id', 'in', posts.map((p) => p.id))
            .orderBy('pm.position')
            .execute();
    let decisionsQuery = trx
      .selectFrom('posts as p')
      .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
      .select(['p.status', 'p.decided_at', 'p.decided_as_delegate', 'p.decision_note', 'a.display_name'])
      .where('p.decided_by', '=', userId);
    if (accountIds.length > 0) decisionsQuery = decisionsQuery.where('p.account_id', 'not in', accountIds);
    const decisionsElsewhere = await decisionsQuery.execute();
    const revisions = await trx
      .selectFrom('post_versions')
      .select(['post_id', 'revision', 'body', 'created_at'])
      .where('author_user_id', '=', userId)
      .execute();
    const notifications = await trx
      .selectFrom('notifications')
      .select(['kind', 'channel', 'payload', 'created_at', 'sent_at', 'read_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute();
    const preferences = await trx.selectFrom('notification_prefs').select(['kind', 'email', 'in_app']).where('user_id', '=', userId).execute();
    const sessions = await trx.selectFrom('sessions').select(['created_at', 'last_seen_at', 'expires_at', 'revoked_at', 'ip', 'user_agent']).where('user_id', '=', userId).execute();
    const audit = await trx.selectFrom('audit_log').select(['action', 'entity', 'at', 'ip']).where('actor_user_id', '=', userId).orderBy('at').execute();
    return { user, memberships, organizations, accounts, consents, posts, postMedia, decisionsElsewhere, revisions, notifications, preferences, sessions, audit };
  });

  const files: ZipEntry[] = [];
  const postsJson = [];
  for (const post of data.posts) {
    const images = [];
    for (const item of data.postMedia.filter((m) => m.post_id === post.id)) {
      const path = `images/${post.id}-${item.position}.${EXTENSIONS[item.mime] ?? 'bin'}`;
      try {
        files.push({ path, bytes: await media.read(item.storage_key) });
        images.push({ fichier: path, texte_alternatif: item.alt_text, generee_par_ia: item.ai_generated });
      } catch {
        images.push({ fichier: null, texte_alternatif: item.alt_text, note: 'image introuvable dans le stockage' });
      }
    }
    postsJson.push({
      compte: data.accounts.find((a) => a.id === post.account_id)?.display_name ?? null,
      statut: post.status,
      creneau: post.scheduled_at,
      publie_le: post.published_at,
      lien: post.external_post_url,
      texte: post.body,
      decision: post.decided_at
        ? { le: post.decided_at, par: post.decided_by === userId ? 'vous' : OTHER_PERSON, note: post.decided_by === userId ? post.decision_note : null }
        : null,
      images,
    });
  }

  const document = {
    genere_le: now.toISOString(),
    explication:
      'Export de vos données personnelles (RGPD, article 15). Les actions d’autres personnes sur vos posts sont signalées sans leur identité. Les images de vos posts sont dans le dossier « images ».',
    profil: data.user,
    espaces: data.memberships,
    organisations: data.organizations,
    comptes_linkedin: data.accounts.map(({ id: _id, ...account }) => account),
    consentements: data.consents.map(({ account_id, ...consent }) => ({ compte: data.accounts.find((a) => a.id === account_id)?.display_name ?? null, ...consent })),
    posts_de_vos_comptes: postsJson,
    vos_decisions_sur_d_autres_comptes: data.decisionsElsewhere,
    textes_que_vous_avez_ecrits: data.revisions.map(({ post_id: _post, ...revision }) => revision),
    notifications: data.notifications,
    reglages_de_notification: data.preferences,
    sessions: data.sessions,
    journal_de_vos_actions: data.audit,
  };
  files.unshift({ path: 'mes-donnees.json', bytes: new Uint8Array(Buffer.from(JSON.stringify(document, null, 2), 'utf8')) });

  await asSystem(db, async (trx) => {
    const orgs = await trx
      .selectFrom('workspace_members as m')
      .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
      .select(['w.org_id', 'w.id'])
      .where('m.user_id', '=', userId)
      .execute();
    for (const org of orgs) {
      await trx
        .insertInto('audit_log')
        .values({ org_id: org.org_id, workspace_id: org.id, actor_user_id: userId, actor_kind: 'user', action: 'rgpd.export', entity: 'user', entity_id: userId, at: now })
        .execute();
    }
  });

  return { archive: createZip(files, now), fileName: `mes-donnees-${now.toISOString().slice(0, 10)}.zip` };
}
