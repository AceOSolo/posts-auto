/**
 * Inscription en libre-service (ONB-01, ONB-02, ONB-06).
 *
 * 1. La personne donne son adresse, son nom, le nom de son organisation et son type
 *    (entreprise ou agence). Rien n'est créé : un lien de confirmation est envoyé.
 * 2. Le clic sur « Créer mon espace » (pas la simple ouverture du lien : les antivirus de
 *    messagerie ouvrent les liens) crée la personne, l'organisation, son premier espace et
 *    l'essai gratuit de 14 jours, puis ouvre la session.
 *
 * Une adresse qui a déjà un compte reçoit un lien de connexion : la réponse affichée est la
 * même, on ne peut pas savoir si une adresse est inscrite. Limites : 5 demandes par adresse
 * et par quart d'heure (avec les liens de connexion), 10 par adresse IP et par heure.
 */
import { addMinutes } from '@posts-auto/core';
import { type Database, asSystem } from '@posts-auto/db';
import { LOGIN_LINKS_PER_WINDOW, LOGIN_RATE_WINDOW_MINUTES, type SessionGrant, hashToken, newToken, normalizeEmail, openSession, requestLoginLink } from '../auth/auth.ts';
import { audit, cleanText } from '../audit.ts';
import { workspaceDefaults } from '../admin/platform.ts';

export const SIGNUP_LINK_TTL_MINUTES = 60;
export const SIGNUPS_PER_IP_PER_HOUR = 10;
/** ONB-06 : essai gratuit de 14 jours, sans carte bancaire. */
export const TRIAL_DAYS = 14;

export type OrgKind = 'entreprise' | 'agence';

export interface SignupInput {
  readonly email: string;
  readonly fullName: string;
  readonly orgName: string;
  readonly orgKind: string;
}

export type SignupRequest =
  /** Nouvelle adresse : lien de confirmation à envoyer. */
  | { readonly kind: 'confirm'; readonly email: string; readonly fullName: string; readonly token: string; readonly expiresAt: Date }
  /** Adresse déjà inscrite : lien de connexion à envoyer (même message affiché). */
  | { readonly kind: 'login'; readonly email: string; readonly token: string }
  | { readonly kind: 'rate_limited' }
  /** Champ manquant ou invalide. */
  | { readonly kind: 'invalid'; readonly field: 'email' | 'nom' | 'organisation' | 'type' };

export async function requestSignup(db: Database, input: SignupInput, now: Date, ip?: string): Promise<SignupRequest> {
  const email = normalizeEmail(input.email);
  if (email === null) return { kind: 'invalid', field: 'email' };
  const fullName = cleanText(input.fullName, 120);
  if (fullName === null) return { kind: 'invalid', field: 'nom' };
  const orgName = cleanText(input.orgName, 120);
  if (orgName === null) return { kind: 'invalid', field: 'organisation' };
  if (input.orgKind !== 'entreprise' && input.orgKind !== 'agence') return { kind: 'invalid', field: 'type' };

  const known = await asSystem(db, (trx) => trx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst());
  if (known !== undefined) {
    const login = await requestLoginLink(db, email, now, ip);
    return login.kind === 'send' ? { kind: 'login', email, token: login.token } : { kind: 'rate_limited' };
  }

  return asSystem(db, async (trx) => {
    const since = addMinutes(now, -LOGIN_RATE_WINDOW_MINUTES);
    const byEmail = await trx.selectFrom('signup_requests').select((eb) => eb.fn.countAll<string>().as('n')).where('email', '=', email).where('created_at', '>', since).executeTakeFirstOrThrow();
    if (Number(byEmail.n) >= LOGIN_LINKS_PER_WINDOW) return { kind: 'rate_limited' };
    if (ip !== undefined) {
      const byIp = await trx
        .selectFrom('signup_requests')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('requested_ip', '=', ip)
        .where('created_at', '>', addMinutes(now, -60))
        .executeTakeFirstOrThrow();
      if (Number(byIp.n) >= SIGNUPS_PER_IP_PER_HOUR) return { kind: 'rate_limited' };
    }
    const token = newToken();
    const expiresAt = addMinutes(now, SIGNUP_LINK_TTL_MINUTES);
    await trx
      .insertInto('signup_requests')
      .values({ token_hash: hashToken(token), email, full_name: fullName, org_name: orgName, org_kind: input.orgKind as OrgKind, expires_at: expiresAt, requested_ip: ip ?? null, created_at: now })
      .execute();
    return { kind: 'confirm', email, fullName, token, expiresAt };
  });
}

/** Demande en attente, pour la page de confirmation (rien n'est consommé). */
export async function pendingSignup(db: Database, token: string, now: Date): Promise<{ email: string; orgName: string; orgKind: OrgKind } | null> {
  const row = await asSystem(db, (trx) =>
    trx
      .selectFrom('signup_requests')
      .select(['email', 'org_name', 'org_kind'])
      .where('token_hash', '=', hashToken(token))
      .where('used_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst(),
  );
  return row === undefined ? null : { email: row.email, orgName: row.org_name, orgKind: row.org_kind as OrgKind };
}

export type SignupOutcome = { readonly ok: true; readonly session: SessionGrant; readonly workspaceId: string; readonly created: boolean } | { readonly ok: false };

/**
 * Consomme le lien et crée l'organisation, son premier espace et l'essai. Si l'adresse a été
 * inscrite entre-temps (deuxième demande confirmée), la personne est simplement connectée.
 */
export async function confirmSignup(db: Database, token: string, now: Date, meta: { ip?: string; userAgent?: string } = {}): Promise<SignupOutcome> {
  return asSystem(db, async (trx) => {
    const request = await trx
      .updateTable('signup_requests')
      .set({ used_at: now })
      .where('token_hash', '=', hashToken(token))
      .where('used_at', 'is', null)
      .where('expires_at', '>', now)
      .returning(['email', 'full_name', 'org_name', 'org_kind'])
      .executeTakeFirst();
    if (request === undefined) return { ok: false };

    const existing = await trx.selectFrom('users').select('id').where('email', '=', request.email).executeTakeFirst();
    if (existing !== undefined) {
      const workspace = await trx
        .selectFrom('workspaces as w')
        .leftJoin('workspace_members as m', 'm.workspace_id', 'w.id')
        .leftJoin('org_members as o', 'o.org_id', 'w.org_id')
        .select('w.id')
        .where((eb) => eb.or([eb('m.user_id', '=', existing.id), eb.and([eb('o.user_id', '=', existing.id), eb('o.role', '=', 'owner')])]))
        .orderBy('w.created_at')
        .limit(1)
        .executeTakeFirst();
      if (workspace === undefined) return { ok: false };
      return { ok: true, session: await openSession(trx, existing.id, now, meta), workspaceId: workspace.id, created: false };
    }

    const user = await trx.insertInto('users').values({ email: request.email, full_name: request.full_name, created_at: now }).returning('id').executeTakeFirstOrThrow();
    const org = await trx
      .insertInto('organizations')
      .values({ name: request.org_name, kind: request.org_kind, trial_ends_at: addMinutes(now, TRIAL_DAYS * 24 * 60), created_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('org_members').values({ org_id: org.id, user_id: user.id, role: 'owner', created_at: now }).execute();
    // ONB-02 : le premier espace ; pour une agence, celui de son premier client, à renommer.
    const workspace = await trx
      .insertInto('workspaces')
      .values({ org_id: org.id, name: request.org_kind === 'agence' ? 'Premier client' : request.org_name, created_at: now, ...(await workspaceDefaults(trx)) })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('workspace_members').values({ workspace_id: workspace.id, user_id: user.id, role: 'admin', created_at: now }).execute();
    const session = await openSession(trx, user.id, now, meta);
    await audit(trx, { workspaceId: workspace.id, actorUserId: user.id, action: 'inscription', entity: 'organization', entityId: org.id, details: { kind: request.org_kind }, at: now });
    return { ok: true, session, workspaceId: workspace.id, created: true };
  });
}
