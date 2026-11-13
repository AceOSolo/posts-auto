/**
 * Clés de l'API d'échange (PUB-10) : une par espace, secrètes, révocables, droits limités.
 * Format : « pa_<préfixe>_<secret> ». Seule l'empreinte est stockée ; le préfixe permet de
 * reconnaître une clé dans l'interface sans la révéler.
 */
import { randomBytes } from 'node:crypto';
import { type Database, asSystem } from '@posts-auto/db';
import { hashToken } from '../auth/auth.ts';

export const API_SCOPES = ['posts:read', 'posts:write', 'inputs:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKeyContext {
  readonly keyId: string;
  readonly workspaceId: string;
  readonly orgId: string;
  readonly scopes: ReadonlySet<ApiScope>;
}

const KEY_PATTERN = /^pa_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export async function createApiKey(
  db: Database,
  input: { workspaceId: string; name: string; scopes: readonly ApiScope[]; createdBy?: string },
): Promise<{ id: string; key: string }> {
  const prefix = randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 8);
  const key = `pa_${prefix}_${randomBytes(32).toString('base64url')}`;
  const row = await asSystem(db, (trx) =>
    trx
      .insertInto('api_keys')
      .values({
        workspace_id: input.workspaceId,
        name: input.name,
        key_hash: hashToken(key),
        key_prefix: prefix,
        scopes: [...input.scopes],
        created_by: input.createdBy ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  return { id: row.id, key };
}

/** Clé valide et non révoquée → contexte de l'espace ; sinon null (réponse 401). */
export async function authenticateApiKey(db: Database, presented: string, now: Date): Promise<ApiKeyContext | null> {
  if (!KEY_PATTERN.test(presented)) return null;
  return asSystem(db, async (trx) => {
    const row = await trx
      .selectFrom('api_keys as k')
      .innerJoin('workspaces as w', 'w.id', 'k.workspace_id')
      .innerJoin('organizations as o', 'o.id', 'w.org_id')
      .select(['k.id', 'k.workspace_id', 'w.org_id', 'k.scopes', 'w.status as workspace_status', 'o.status as org_status'])
      .where('k.key_hash', '=', hashToken(presented))
      .where('k.revoked_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined || row.workspace_status !== 'active' || row.org_status === 'closed') return null;
    await trx.updateTable('api_keys').set({ last_used_at: now }).where('id', '=', row.id).execute();
    return {
      keyId: row.id,
      workspaceId: row.workspace_id,
      orgId: row.org_id,
      scopes: new Set(row.scopes.filter((scope): scope is ApiScope => (API_SCOPES as readonly string[]).includes(scope))),
    };
  });
}

export async function revokeApiKey(db: Database, keyId: string, now: Date): Promise<void> {
  await asSystem(db, (trx) => trx.updateTable('api_keys').set({ revoked_at: now }).where('id', '=', keyId).execute());
}
