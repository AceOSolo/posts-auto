/**
 * Journal des accès refusés (REC-01 : « tentative inscrite au journal »).
 *
 * Écrit dans le journal applicatif (une ligne JSON, collectée par la supervision, NF-07),
 * et non dans le journal d'audit d'un espace : ce dernier est rattaché à une organisation,
 * et l'y inscrire révélerait à qui appartient la ressource visée.
 */
export function logDeniedAccess(details: { userId: string | null; resource: string; id: string }): void {
  console.warn(JSON.stringify({ at: new Date().toISOString(), level: 'warn', event: 'acces_refuse', ...details }));
}
