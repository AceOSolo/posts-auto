import type { PostStatus } from '@posts-auto/core';

export const STATUS_LABELS: Record<PostStatus, string> = {
  brouillon: 'En préparation',
  a_valider: 'À valider',
  modif: 'Modification demandée',
  refuse: 'Refusé',
  valide: 'Validé',
  en_publication: 'Envoi en cours',
  publie: 'Publié',
  erreur: 'Erreur',
  remplace: 'Remplacé',
  abandonne: 'Abandonné',
};

export function StatusBadge({ status }: { status: PostStatus }) {
  return <span className={`badge status-${status}`}>{STATUS_LABELS[status]}</span>;
}
