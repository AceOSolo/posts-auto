import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileMediaStore, MemoryMediaStore, assertStorageKey } from './media-store.ts';

describe('clés de stockage', () => {
  it.each(['ws-1/posts/p1/1.png', 'a', 'ws_1/x-y.z.jpeg'])('accepte %s', (key) => {
    expect(() => assertStorageKey(key)).not.toThrow();
  });

  it.each(['../secrets', 'ws/../../etc/passwd', '/absolu', 'ws\\x', 'ws//x', ''])('refuse %j', (key) => {
    expect(() => assertStorageKey(key)).toThrow(/invalide/);
  });
});

describe('stockage en mémoire', () => {
  it('relit ce qui a été écrit et signale un média absent', async () => {
    const store = new MemoryMediaStore();
    await store.write('ws/a.png', new Uint8Array([1, 2]));
    expect(await store.read('ws/a.png')).toEqual(new Uint8Array([1, 2]));
    await expect(store.read('ws/b.png')).rejects.toThrow(/introuvable/);
  });
});

describe('stockage sur disque', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it('écrit dans des sous-dossiers et relit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'posts-auto-media-'));
    dirs.push(root);
    const store = new FileMediaStore(root);
    await store.write('ws-1/posts/p1/1.png', new Uint8Array([9]));
    expect(new Uint8Array(await store.read('ws-1/posts/p1/1.png'))).toEqual(new Uint8Array([9]));
  });
});
