import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, checkImage } from './image-check.ts';

const bytes = (...values: number[]) => new Uint8Array(values);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Buffer.from(type, 'ascii'), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)) >>> 0);
  return out;
}
const PNG_SIGNATURE = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
function png(...chunks: Uint8Array[]): Uint8Array {
  return Buffer.concat([PNG_SIGNATURE, ...chunks]);
}
const IHDR = pngChunk('IHDR', bytes(0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0));
const IDAT = pngChunk('IDAT', bytes(1, 2, 3));
const IEND = pngChunk('IEND', bytes());
const GPS = pngChunk('tEXt', new Uint8Array(Buffer.from('GPS\u000048.8566,2.3522')));

/** JPEG minimal : SOI, APP0 (JFIF), APP1 (EXIF avec « GPS »), SOS + données, EOI. */
const jpeg = () =>
  Buffer.concat([
    bytes(0xff, 0xd8),
    bytes(0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46),
    bytes(0xff, 0xe1, 0x00, 0x07, 0x47, 0x50, 0x53, 0x21, 0x21),
    bytes(0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9),
  ]);

describe('contrôle des images reçues (SEC-07)', () => {
  it('reconnaît un PNG et retire ses métadonnées textuelles (ex. coordonnées GPS)', () => {
    const result = checkImage(png(IHDR, GPS, IDAT, IEND), 'image/png');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mime).toBe('image/png');
    expect(Buffer.from(result.bytes).includes(Buffer.from('GPS'))).toBe(false);
    expect(Buffer.from(result.bytes)).toEqual(Buffer.from(png(IHDR, IDAT, IEND)));
  });

  it('reconnaît un JPEG et retire le segment EXIF, en gardant l’image', () => {
    const result = checkImage(jpeg(), 'image/jpeg');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.bytes).includes(Buffer.from('GPS'))).toBe(false);
    expect(Buffer.from(result.bytes).includes(Buffer.from('JFIF'))).toBe(true);
    expect(Buffer.from(result.bytes).subarray(-4)).toEqual(Buffer.from(bytes(0x11, 0x22, 0xff, 0xd9)));
  });

  it('accepte un GIF tel quel', () => {
    expect(checkImage(new Uint8Array(Buffer.from('GIF89a....')))).toMatchObject({ ok: true, mime: 'image/gif' });
  });

  it('refuse un fichier dont le contenu ne correspond pas au type annoncé', () => {
    expect(checkImage(jpeg(), 'image/png')).toEqual({ ok: false, code: 'image_type_mismatch' });
  });

  it('refuse ce qui n’est pas une image (ex. un script renommé en .png)', () => {
    expect(checkImage(new Uint8Array(Buffer.from('<script>alert(1)</script>')), 'image/png')).toEqual({ ok: false, code: 'image_unsupported' });
  });

  it('refuse une image tronquée', () => {
    expect(checkImage(png(IHDR, IDAT))).toEqual({ ok: false, code: 'image_corrupted' });
    expect(checkImage(jpeg().subarray(0, 9))).toEqual({ ok: false, code: 'image_corrupted' });
  });

  it('refuse une image de plus de 10 Mo', () => {
    expect(checkImage(new Uint8Array(MAX_IMAGE_BYTES + 1))).toEqual({ ok: false, code: 'image_too_large' });
  });
});
