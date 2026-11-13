/**
 * État affiché d'un sujet du planning (PLA-02), calculé à partir des posts qui en sont
 * issus : il n'est jamais stocké, pour ne pas pouvoir contredire les posts.
 */
import type { PostStatus } from '../posts/status.ts';

export type CellState = 'planned' | 'drafted' | 'validated' | 'published' | 'set_aside';

export interface CellStatus {
  readonly state: CellState;
  /**
   * La case demande une action : son post a été abandonné (RÈG-10, plus de créneau ou
   * trop de replanifications) ou attend une reprise manuelle.
   */
  readonly needsAttention: boolean;
}

const DRAFTED: ReadonlySet<PostStatus> = new Set<PostStatus>(['brouillon', 'a_valider', 'modif', 'refuse', 'erreur']);

export function cellStatus(setAside: boolean, postStatuses: readonly PostStatus[]): CellStatus {
  if (setAside) return { state: 'set_aside', needsAttention: false };
  const live = postStatuses.filter((s) => s !== 'remplace');
  if (live.includes('publie')) return { state: 'published', needsAttention: false };
  if (live.includes('valide') || live.includes('en_publication')) return { state: 'validated', needsAttention: false };
  if (live.some((s) => DRAFTED.has(s))) return { state: 'drafted', needsAttention: live.includes('erreur') };
  return { state: 'planned', needsAttention: live.includes('abandonne') };
}
