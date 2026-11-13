import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SchedulerLogger, startScheduler } from './scheduler.ts';

function recordingLogger() {
  const events: { level: 'info' | 'error'; event: string; details: Record<string, unknown> }[] = [];
  const logger: SchedulerLogger = {
    info: (event, details) => events.push({ level: 'info', event, details }),
    error: (event, details) => events.push({ level: 'error', event, details }),
  };
  return { events, logger };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('exécution périodique des tâches', () => {
  it('lance une passe au démarrage puis à chaque intervalle', async () => {
    const run = vi.fn(async () => ({ published: [] }));
    const { logger } = recordingLogger();
    const scheduler = startScheduler([{ name: 'publication', intervalMs: 60_000, run }], logger);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(run).toHaveBeenCalledTimes(4);
    await scheduler.stop();
  });

  it('saute un tour si la passe précédente n’est pas finie', async () => {
    let release: () => void = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { events, logger } = recordingLogger();
    const scheduler = startScheduler([{ name: 'lente', intervalMs: 1_000, run }], logger);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.event === 'tache.sautee')).toHaveLength(3);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await scheduler.stop();
  });

  it('journalise une erreur sans arrêter la boucle', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('base indisponible')).mockResolvedValue({ moved: ['p1'] });
    const { events, logger } = recordingLogger();
    const scheduler = startScheduler([{ name: 'replanification', intervalMs: 1_000, run }], logger);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual([
      { level: 'error', event: 'tache.erreur', details: { tache: 'replanification', erreur: 'base indisponible' } },
      { level: 'info', event: 'tache.terminee', details: expect.objectContaining({ tache: 'replanification', resultat: { moved: ['p1'] } }) },
    ]);
    await scheduler.stop();
  });

  it('ne journalise pas les passes sans résultat', async () => {
    const { events, logger } = recordingLogger();
    const scheduler = startScheduler([{ name: 'calme', intervalMs: 1_000, run: async () => ({ published: [], failed: [] }) }], logger);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events).toEqual([]);
    await scheduler.stop();
  });

  it('à l’arrêt, attend la fin de la passe en cours et n’en lance plus', async () => {
    let finished = false;
    const run = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      finished = true;
    });
    const scheduler = startScheduler([{ name: 'publication', intervalMs: 1_000, run }], recordingLogger().logger);
    const stopped = scheduler.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopped;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
