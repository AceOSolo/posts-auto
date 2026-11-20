/** Brouillons conservés le temps d'une relecture (stockage des médias). */

/** ONB-04 : proposition de ligne éditoriale par l'IA, avant correction et validation. */
export function editorialProposalKey(workspaceId: string, proposalId: string): string {
  return `${workspaceId}/brouillons/ligne-${proposalId}.json`;
}

/** ONB-05 : charte proposée à partir du site web, avant correction et enregistrement. */
export function brandProposalKey(workspaceId: string, proposalId: string): string {
  return `${workspaceId}/brouillons/charte-${proposalId}.json`;
}
