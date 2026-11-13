/**
 * Journal d'audit (SEC-08) : une entrée par modification faite par une personne,
 * dans la même transaction que la modification.
 */
import type { Tx } from '@posts-auto/db';

export interface AuditEntry {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly details: Record<string, unknown>;
  readonly at: Date;
}

export async function audit(trx: Tx, entry: AuditEntry): Promise<void> {
  const workspace = await trx.selectFrom('workspaces').select('org_id').where('id', '=', entry.workspaceId).executeTakeFirstOrThrow();
  await trx
    .insertInto('audit_log')
    .values({
      org_id: workspace.org_id,
      workspace_id: entry.workspaceId,
      actor_user_id: entry.actorUserId,
      actor_kind: 'user',
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId,
      details: JSON.stringify(entry.details),
      at: entry.at,
    })
    .execute();
}

/** Texte saisi : espaces retirés, chaîne vide → null, longueur bornée. */
export function cleanText(value: string | null | undefined, max: number): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Liste saisie une ligne par entrée : lignes vides et doublons retirés. */
export function cleanLines(value: string | readonly string[] | null | undefined, maxItems: number, maxLength: number): string[] {
  const lines = typeof value === 'string' ? value.split(/\r?\n/) : [...(value ?? [])];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const item = line.trim().slice(0, maxLength);
    const key = item.toLocaleLowerCase('fr');
    if (item === '' || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
}
