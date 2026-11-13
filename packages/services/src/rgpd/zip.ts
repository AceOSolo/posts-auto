/**
 * Archive ZIP minimale, sans compression (« stored »), pour l'export des données
 * personnelles. Noms de fichiers en UTF-8. Suffit à des archives de quelques dizaines de
 * mégaoctets, lisibles par tous les systèmes (Windows, macOS, Linux).
 */
import { crc32 } from 'node:zlib';

export interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const UTF8_FLAG = 0x0800;

/** Date et heure au format MS-DOS (résolution de 2 secondes). */
function dosDateTime(date: Date): { time: number; day: number } {
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    day: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export function createZip(entries: readonly ZipEntry[], date: Date): Uint8Array {
  const { time, day } = dosDateTime(date);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (entry.path.startsWith('/') || entry.path.includes('..')) throw new Error(`Chemin d'archive invalide : ${entry.path}`);
    const name = Buffer.from(entry.path, 'utf8');
    const data = Buffer.from(entry.bytes);
    const checksum = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version nécessaire
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8); // sans compression
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // créé par
    central.writeUInt16LE(20, 6); // version nécessaire
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Lecture d'une archive produite par createZip (sert aux tests et aux vérifications). */
export function readZip(archive: Uint8Array): ZipEntry[] {
  const buffer = Buffer.from(archive);
  const end = buffer.length - 22;
  if (buffer.readUInt32LE(end) !== 0x06054b50) throw new Error('Archive ZIP invalide');
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const path = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLength;
    const bytes = buffer.subarray(dataStart, dataStart + size);
    if ((crc32(bytes) >>> 0) !== checksum) throw new Error(`Somme de contrôle invalide : ${path}`);
    entries.push({ path, bytes });
    cursor += 46 + nameLength;
  }
  return entries;
}
