/**
 * Valeurs fournies aux tests par la mise en place globale (global-setup.ts).
 * Importé par @posts-auto/db/testing pour que tout paquet de test en profite.
 */
declare module 'vitest' {
  export interface ProvidedContext {
    /**
     * Base modèle migrée, propre à l'exécution des tests. Ne pas s'y connecter
     * directement : utiliser openTestDatabase(), qui en fait une copie par fichier.
     */
    databaseUrl: string;
  }
}

export {};
