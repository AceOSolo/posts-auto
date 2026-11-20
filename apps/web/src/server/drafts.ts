/** Brouillons conservés le temps d'une relecture (stockage des médias). */

/** ONB-04 : proposition de ligne éditoriale par l'IA, avant correction et validation. */
export function editorialProposalKey(workspaceId: string, proposalId: string): string {
  return `${workspaceId}/brouillons/ligne-${proposalId}.json`;
}
