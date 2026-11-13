/**
 * Exécution périodique des tâches de fond (section 8.4).
 *
 * - Jamais deux passes simultanées d'une même tâche : si la précédente n'est pas finie,
 *   le tour est sauté (la suivante rattrapera, toutes les tâches étant idempotentes).
 * - Une erreur est journalisée et n'arrête pas la boucle.
 * - Arrêt propre : `stop()` attend la fin des passes en cours.
 */

export interface PeriodicTask {
  readonly name: string;
  readonly intervalMs: number;
  run(): Promise<unknown>;
}

export interface SchedulerLogger {
  info(event: string, details: Record<string, unknown>): void;
  error(event: string, details: Record<string, unknown>): void;
}

export interface Scheduler {
  stop(): Promise<void>;
}

export function startScheduler(tasks: readonly PeriodicTask[], logger: SchedulerLogger): Scheduler {
  const running = new Map<string, Promise<void>>();
  const timers: ReturnType<typeof setInterval>[] = [];
  let stopping = false;

  const tick = (task: PeriodicTask) => {
    if (stopping) return;
    if (running.has(task.name)) {
      logger.info('tache.sautee', { tache: task.name, raison: 'passe précédente en cours' });
      return;
    }
    const started = Date.now();
    const pass = task
      .run()
      .then((result) => {
        if (hasContent(result)) logger.info('tache.terminee', { tache: task.name, dureeMs: Date.now() - started, resultat: result });
      })
      .catch((error: unknown) => {
        logger.error('tache.erreur', { tache: task.name, erreur: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => running.delete(task.name));
    running.set(task.name, pass);
  };

  for (const task of tasks) {
    tick(task); // première passe au démarrage
    timers.push(setInterval(() => tick(task), task.intervalMs));
  }

  return {
    async stop() {
      stopping = true;
      for (const timer of timers) clearInterval(timer);
      await Promise.all(running.values());
    },
  };
}

/** Un rapport ne vaut d'être journalisé que s'il contient quelque chose (évite le bruit). */
function hasContent(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return result !== undefined;
  return Object.values(result).some((value) => (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null));
}
