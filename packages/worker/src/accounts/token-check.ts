/**
 * Surveillance quotidienne des connexions LinkedIn (LNK-04 ; recette technique LinkedIn
 * CM-002 à CM-006).
 *
 * Pour chaque compte :
 * 1. renouvellement automatique du jeton d'accès à 7 jours de son échéance, si LinkedIn a
 *    fourni un jeton de renouvellement (partenaires approuvés, section 8.2) ;
 * 2. vérification que le jeton fonctionne encore (au plus une fois par 20 heures) ;
 * 3. alertes au titulaire et aux administrateurs à J-14, J-3 et à l'expiration de ce qui ne
 *    peut pas être renouvelé automatiquement, une seule fois par échéance ;
 * 4. rechiffrement avec la clé courante après une rotation des clés (SEC-02).
 *
 * Les appels à LinkedIn se font hors transaction ; chaque compte est traité séparément.
 */
import { type DB, type Database, asSystem } from '@posts-auto/db';
import { LinkedInError, type LinkedInOAuth } from '@posts-auto/linkedin';
import type { Updateable } from 'kysely';
import { alertRecipients, notify } from '../notifications/recipients.ts';
import type { TokenCipher } from '../secrets/token-cipher.ts';

const DAY = 86_400_000;
export const REFRESH_AHEAD_DAYS = 7;
export const HEARTBEAT_EVERY_HOURS = 20;

export interface TokenCheckDeps {
  readonly db: Database;
  /** Null si l'application LinkedIn n'est pas configurée : ni renouvellement, ni vérification. */
  readonly oauth: LinkedInOAuth | null;
  readonly cipher: TokenCipher;
  readonly clock?: () => Date;
}

export interface TokenCheckReport {
  readonly refreshed: string[];
  readonly expiring: string[];
  readonly expired: string[];
  readonly alerts: string[];
  readonly reencrypted: string[];
}

type Alert = 'j14' | 'j3' | 'j0';
type AccountStatus = 'connected' | 'expiring' | 'expired';

interface Row {
  readonly account_id: string;
  readonly workspace_id: string;
  readonly kind: string;
  readonly display_name: string | null;
  readonly avatar_url: string | null;
  readonly status: string;
  readonly oauth_client_id: string;
  readonly access_token_enc: Buffer;
  readonly refresh_token_enc: Buffer | null;
  readonly expires_at: Date;
  readonly refresh_expires_at: Date | null;
  readonly last_checked_at: Date | null;
  readonly expiry_alerts_sent: string[];
}

export async function runTokenCheck(deps: TokenCheckDeps): Promise<TokenCheckReport> {
  const clock = deps.clock ?? (() => new Date());
  const report: TokenCheckReport = { refreshed: [], expiring: [], expired: [], alerts: [], reencrypted: [] };
  const rows: Row[] = await asSystem(deps.db, (trx) =>
    trx
      .selectFrom('social_tokens as t')
      .innerJoin('social_accounts as a', 'a.id', 't.account_id')
      .select([
        't.account_id',
        't.workspace_id',
        'a.kind',
        'a.display_name',
        'a.avatar_url',
        'a.status',
        't.oauth_client_id',
        't.access_token_enc',
        't.refresh_token_enc',
        't.expires_at',
        't.refresh_expires_at',
        't.last_checked_at',
        't.expiry_alerts_sent',
      ])
      .where('a.status', 'in', ['connected', 'expiring', 'expired'])
      .execute(),
  );
  for (const row of rows) await checkAccount(deps, row, clock(), report);
  return report;
}

/** L'alerte due compte tenu de celles déjà envoyées ; une alerte plus urgente vaut les précédentes. */
function dueAlert(daysLeft: number, revoked: boolean, sent: ReadonlySet<string>): { status: AccountStatus; alert: Alert | null; covers: Alert[] } {
  if (revoked || daysLeft <= 0) return { status: 'expired', alert: sent.has('j0') ? null : 'j0', covers: ['j14', 'j3', 'j0'] };
  if (daysLeft <= 3) return { status: 'expiring', alert: sent.has('j3') ? null : 'j3', covers: ['j14', 'j3'] };
  if (daysLeft <= 14) return { status: 'expiring', alert: sent.has('j14') ? null : 'j14', covers: ['j14'] };
  return { status: 'connected', alert: null, covers: [] };
}

async function checkAccount(deps: TokenCheckDeps, row: Row, now: Date, report: TokenCheckReport): Promise<void> {
  const { cipher } = deps;
  const oauth = deps.oauth !== null && deps.oauth.clientId === row.oauth_client_id ? deps.oauth : null;
  const update: Updateable<DB['social_tokens']> = {};
  let accessExpires = row.expires_at;
  let refreshExpires = row.refresh_expires_at;
  let revoked = false;
  let refreshed = false;
  let freshPicture: string | null = null;

  // 1. Renouvellement automatique.
  const refreshToken = row.refresh_token_enc;
  const canRefresh = oauth !== null && refreshToken !== null && refreshExpires !== null && refreshExpires.getTime() > now.getTime();
  if (canRefresh && oauth !== null && refreshToken !== null && accessExpires.getTime() - now.getTime() < REFRESH_AHEAD_DAYS * DAY) {
    try {
      const tokens = await oauth.refresh(cipher.decrypt(refreshToken, row.account_id), now);
      accessExpires = tokens.expiresAt;
      if (tokens.refreshExpiresAt !== null) refreshExpires = tokens.refreshExpiresAt;
      update.access_token_enc = cipher.encrypt(tokens.accessToken, row.account_id);
      if (tokens.refreshToken !== null) update.refresh_token_enc = cipher.encrypt(tokens.refreshToken, row.account_id);
      update.expires_at = accessExpires;
      update.refresh_expires_at = refreshExpires;
      update.last_checked_at = now;
      refreshed = true;
      report.refreshed.push(row.account_id);
    } catch (error) {
      if (!(error instanceof LinkedInError) || error.kind !== 'auth') throw error;
      revoked = true; // jeton de renouvellement refusé : il faut reconnecter le compte
    }
  }

  // 2. Le jeton fonctionne-t-il encore ? (profils ; les pages arriveront avec la Community Management API)
  const heartbeatDue = row.last_checked_at === null || now.getTime() - row.last_checked_at.getTime() >= HEARTBEAT_EVERY_HOURS * 3_600_000;
  if (oauth !== null && !refreshed && !revoked && row.kind === 'profile' && accessExpires.getTime() > now.getTime() && heartbeatDue) {
    try {
      const profile = await oauth.memberProfile(cipher.decrypt(row.access_token_enc, row.account_id));
      update.last_checked_at = now;
      // Les liens de photo de LinkedIn expirent : on garde le plus récent.
      if (profile.pictureUrl !== null && profile.pictureUrl !== row.avatar_url) freshPicture = profile.pictureUrl;
    } catch (error) {
      if (error instanceof LinkedInError && error.kind === 'auth' && error.status === 401) revoked = true;
      // Toute autre erreur (réseau, LinkedIn indisponible) : on réessaiera au prochain passage.
    }
  }

  // 3. Échéance de ce qui ne se renouvelle pas tout seul : le jeton de renouvellement s'il existe.
  const connectionExpires = canRefresh && !revoked && refreshExpires !== null ? refreshExpires : accessExpires;
  const daysLeft = (connectionExpires.getTime() - now.getTime()) / DAY;
  const sent = new Set(row.expiry_alerts_sent);
  const { status, alert, covers } = dueAlert(daysLeft, revoked, sent);
  if (alert !== null) update.expiry_alerts_sent = [...new Set([...sent, ...covers])];

  // 4. Rechiffrement après rotation des clés.
  if (update.access_token_enc === undefined && cipher.needsReencryption(row.access_token_enc)) {
    update.access_token_enc = cipher.encrypt(cipher.decrypt(row.access_token_enc, row.account_id), row.account_id);
    if (refreshToken !== null) update.refresh_token_enc = cipher.encrypt(cipher.decrypt(refreshToken, row.account_id), row.account_id);
    report.reencrypted.push(row.account_id);
  }

  await asSystem(deps.db, async (trx) => {
    if (Object.keys(update).length > 0) await trx.updateTable('social_tokens').set(update).where('account_id', '=', row.account_id).execute();
    if (status !== row.status || freshPicture !== null) {
      await trx
        .updateTable('social_accounts')
        .set({ status, ...(freshPicture !== null ? { avatar_url: freshPicture } : {}) })
        .where('id', '=', row.account_id)
        .execute();
    }
    if (alert !== null) {
      const recipients = await alertRecipients(trx, row.workspace_id, row.account_id);
      await notify(
        trx,
        recipients,
        row.workspace_id,
        alert === 'j0' ? 'connexion_expiree' : 'connexion_expire_bientot',
        { accountId: row.account_id, accountName: row.display_name, expiresAt: connectionExpires.toISOString(), daysLeft: Math.max(0, Math.ceil(daysLeft)), revoked },
        ['email', 'in_app'],
      );
      report.alerts.push(`${row.account_id}:${alert}`);
    }
  });
  if (status === 'expiring') report.expiring.push(row.account_id);
  if (status === 'expired') report.expired.push(row.account_id);
}
