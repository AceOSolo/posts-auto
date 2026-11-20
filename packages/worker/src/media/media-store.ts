/**
 * Stockage des images (photos, visuels rendus). En production : stockage objet compatible
 * S3 hébergé dans l'UE (section 8.1) ; en développement : un dossier local ; en test : la mémoire.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface MediaStore {
  read(storageKey: string): Promise<Uint8Array>;
  write(storageKey: string, bytes: Uint8Array): Promise<void>;
  /** Supprime le fichier ; sans effet s'il n'existe pas. */
  remove(storageKey: string): Promise<void>;
}

/** Clé de stockage : segments séparés par « / », sans « .. », sans chemin absolu. */
const KEY_PATTERN = /^(?!.*\.\.)[\w-]+(?:\/[\w.-]+)*$/;

export function assertStorageKey(storageKey: string): void {
  if (!KEY_PATTERN.test(storageKey)) throw new Error(`Clé de stockage invalide : « ${storageKey} »`);
}

export class MemoryMediaStore implements MediaStore {
  readonly #files = new Map<string, Uint8Array>();

  async read(storageKey: string): Promise<Uint8Array> {
    assertStorageKey(storageKey);
    const bytes = this.#files.get(storageKey);
    if (bytes === undefined) throw new Error(`Média introuvable : ${storageKey}`);
    return bytes;
  }

  async write(storageKey: string, bytes: Uint8Array): Promise<void> {
    assertStorageKey(storageKey);
    this.#files.set(storageKey, bytes);
  }

  async remove(storageKey: string): Promise<void> {
    assertStorageKey(storageKey);
    this.#files.delete(storageKey);
  }
}

export class FileMediaStore implements MediaStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  #pathOf(storageKey: string): string {
    assertStorageKey(storageKey);
    const resolved = path.resolve(this.#root, storageKey);
    if (!resolved.startsWith(this.#root + path.sep)) throw new Error(`Clé de stockage hors du dossier : « ${storageKey} »`);
    return resolved;
  }

  async read(storageKey: string): Promise<Uint8Array> {
    return readFile(this.#pathOf(storageKey));
  }

  async write(storageKey: string, bytes: Uint8Array): Promise<void> {
    const target = this.#pathOf(storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.#pathOf(storageKey), { force: true });
  }
}
