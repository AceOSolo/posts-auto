/**
 * Données de démonstration pour le développement local : npm run seed -w @posts-auto/web
 *
 * Recrée à chaque exécution l'organisation « Démo Secutop » : un espace, trois comptes
 * LinkedIn, quatre personnes et des posts dans tous les états. Les adresses e-mail sont
 * fictives (domaine réservé example.test) : le lien de connexion s'affiche dans la
 * console du serveur de développement.
 */
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { DEFAULT_WORKSPACE_CALENDAR, atLocal, isoWeekBounds, localDate } from '@posts-auto/core';
import { DEFAULT_DATABASE_URL, asSystem, createDatabase } from '@posts-auto/db';
import { FileMediaStore } from '@posts-auto/worker';

const ORG_NAME = 'Démo Secutop';
const db = createDatabase(process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL, { maxConnections: 2 });
const media = new FileMediaStore(process.env['MEDIA_ROOT'] ?? path.resolve(import.meta.dirname, '../../../.media'));

/** Image PNG unie (couleur RVB), sans dépendance. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RVB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).fill(Buffer.from([r, g, b]))]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const calendar = DEFAULT_WORKSPACE_CALENDAR;
const now = new Date();
const monday = localDate(isoWeekBounds(now, calendar).start, calendar);
/** Créneau « jour J de la semaine courante + décalage, à HH:mm », heure de Paris. */
function slot(daysFromToday: number, time: string): Date {
  const day = new Date(now.getTime() + daysFromToday * 86_400_000);
  const at = atLocal(localDate(day, calendar), time, calendar);
  if (at === null) throw new Error('créneau inexistant');
  return at;
}
const weekStartOf = (at: Date) => localDate(isoWeekBounds(at, calendar).start, calendar);

await asSystem(db, async (trx) => {
  await trx.deleteFrom('organizations').where('name', '=', ORG_NAME).execute();
  // Personnes ajoutées par les tests de fumée lors d'un passage précédent.
  await trx.deleteFrom('users').where('email', '=', 'nouvelle.recrue@demo.example.test').execute();
  // Remet à zéro la limite de 5 liens de connexion par quart d'heure (SEC-06) des comptes de démonstration.
  await trx.deleteFrom('login_tokens').where('email', 'like', '%@demo.example.test').execute();

  const users: Record<string, string> = {};
  for (const [key, fullName] of [
    ['jp', 'Jean-Pierre (dirigeant)'],
    ['alexis', 'Alexis (communication)'],
    ['claire', 'Claire (formatrice)'],
    ['direction', 'Direction (lecture)'],
  ] as const) {
    const row = await trx
      .insertInto('users')
      .values({ email: `${key}@demo.example.test`, full_name: fullName })
      .onConflict((oc) => oc.column('email').doUpdateSet({ full_name: fullName }))
      .returning('id')
      .executeTakeFirstOrThrow();
    users[key] = row.id;
  }

  const org = await trx.insertInto('organizations').values({ name: ORG_NAME, kind: 'entreprise' }).returning('id').executeTakeFirstOrThrow();
  await trx.insertInto('org_members').values({ org_id: org.id, user_id: users['jp'] as string, role: 'owner' }).execute();
  const ws = await trx.insertInto('workspaces').values({ org_id: org.id, name: 'Secutop' }).returning('id').executeTakeFirstOrThrow();
  await trx
    .insertInto('workspace_members')
    .values([
      { workspace_id: ws.id, user_id: users['alexis'] as string, role: 'admin' },
      { workspace_id: ws.id, user_id: users['claire'] as string, role: 'contributor' },
      { workspace_id: ws.id, user_id: users['direction'] as string, role: 'viewer' },
    ])
    .execute();

  const account = async (name: string, kind: 'profile' | 'page', holder: string) =>
    (
      await trx
        .insertInto('social_accounts')
        .values({ workspace_id: ws.id, kind, display_name: name, holder_user_id: holder, external_urn: `urn:li:${kind === 'page' ? 'organization' : 'person'}:demo-${name.replace(/\W/g, '')}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const jpProfile = await account('Jean-Pierre Martin', 'profile', users['jp'] as string);
  const pageSecutop = await account('Secutop', 'page', users['jp'] as string);
  const claireProfile = await account('Claire Durand', 'profile', users['claire'] as string);
  // ROL-01 : la com' valide la page à la place du dirigeant.
  await trx.insertInto('account_delegates').values({ account_id: pageSecutop, workspace_id: ws.id, user_id: users['alexis'] as string }).execute();

  const post = async (
    accountId: string,
    at: Date,
    body: string,
    extra: { status?: 'a_valider' | 'valide' | 'publie' | 'erreur'; photos?: [number, number, number][]; reschedule?: Date; error?: string } = {},
  ) => {
    const status = extra.status ?? 'a_valider';
    const row = await trx
      .insertInto('posts')
      .values({
        workspace_id: ws.id,
        account_id: accountId,
        scheduled_at: at,
        week_start: weekStartOf(at),
        status,
        origin: 'planning',
        ...(extra.reschedule ? { original_scheduled_at: extra.reschedule, reschedule_count: 1 } : {}),
        ...(status === 'publie' ? { published_at: at, external_post_urn: 'urn:li:share:demo', external_post_url: 'https://www.linkedin.com/feed/' } : {}),
        ...(extra.error ? { last_error: extra.error } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const version = await trx
      .insertInto('post_versions')
      .values({ workspace_id: ws.id, post_id: row.id, revision: 1, body, author_kind: 'ai' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.updateTable('posts').set({ current_version_id: version.id }).where('id', '=', row.id).execute();
    for (const [index, color] of (extra.photos ?? []).entries()) {
      const key = `${ws.id}/${row.id}/photo-${index + 1}.png`;
      await media.write(key, solidPng(600, 600, color));
      const asset = await trx
        .insertInto('media_assets')
        .values({ workspace_id: ws.id, kind: 'upload', storage_key: key, mime: 'image/png', width: 600, height: 600 })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('post_media')
        .values({ workspace_id: ws.id, post_id: row.id, asset_id: asset.id, position: index + 1, alt_text: `Photo ${index + 1} de la formation` })
        .execute();
    }
    return row.id;
  };

  await post(
    jpProfile,
    slot(1, '12:00'),
    'Le document unique, ce n’est pas un classeur qui dort dans un tiroir.\n\nCette semaine, trois clients m’ont posé la même question : « à quelle fréquence faut-il le mettre à jour ? » La réponse courte : au moins une fois par an, et à chaque changement important (nouvel équipement, nouveau poste, accident).\n\nEt vous, quand avez-vous relu le vôtre pour la dernière fois ?',
  );
  await post(
    pageSecutop,
    slot(2, '09:30'),
    'Webinaire gratuit le [À COMPLÉTER : date] : « Prévenir les TMS dans les métiers de service ».\n\nAu programme : les gestes à risque, les aménagements simples, et les aides financières disponibles.\n\nInscription en commentaire.',
  );
  await post(claireProfile, slot(3, '17:30'), 'Retour sur la formation SST de la semaine dernière à Lyon : 12 stagiaires, deux jours intenses et beaucoup de mises en situation.\n\nMerci à toute l’équipe pour l’accueil !', {
    photos: [
      [15, 91, 140],
      [240, 165, 0],
      [30, 120, 80],
    ],
  });
  await post(jpProfile, slot(4, '12:00'), 'Prévention : ce que la nouvelle réglementation change pour les PME (version validée).', { status: 'valide' });
  await post(pageSecutop, slot(-1, '12:00'), 'Bienvenue à nos deux nouveaux formateurs ! (post déjà publié)', { status: 'publie' });
  await post(claireProfile, slot(0, '08:30'), 'Trois réflexes pour bien démarrer la semaine en sécurité.', {
    status: 'erreur',
    error: 'LinkedIn est momentanément indisponible : nouvel essai plus tard.',
  });
  await post(pageSecutop, slot(1, '15:00'), 'Nos prochaines sessions de formation incendie sont ouvertes. (post replanifié faute de validation)', {
    reschedule: slot(-1, '15:00'),
  });
});

await db.destroy();
console.log(`Démo prête (semaine du ${monday}). Comptes : jp@, alexis@, claire@, direction@demo.example.test`);
console.log('Connexion : http://localhost:3000/connexion — le lien s’affiche dans la console du serveur.');
