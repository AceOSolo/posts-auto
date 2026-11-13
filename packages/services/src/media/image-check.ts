/**
 * Contrôle des images reçues (SEC-07) : type réel vérifié sur la signature du fichier
 * (pas sur le type annoncé), taille maximale, et suppression des métadonnées EXIF et
 * textuelles (localisation GPS, appareil, auteur) avant stockage.
 */

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif';
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageCheck =
  | { readonly ok: true; readonly mime: ImageMime; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: 'image_too_large' | 'image_type_mismatch' | 'image_unsupported' | 'image_corrupted' };

function detect(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  return null;
}

/** JPEG : retire les segments APP1 à APP15 (EXIF, XMP…) et les commentaires, garde le reste. */
function stripJpeg(bytes: Uint8Array): Uint8Array | null {
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] as number;
    // Début des données d'image : tout le reste est conservé tel quel.
    if (marker === 0xda) {
      kept.push(bytes.subarray(offset));
      return concat(kept);
    }
    const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    const segment = bytes.subarray(offset, offset + 2 + length);
    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) kept.push(segment);
    offset += 2 + length;
  }
  return null;
}

/** PNG : retire les blocs de métadonnées (eXIf, tEXt, iTXt, zTXt, tIME). */
const PNG_METADATA = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
function stripPng(bytes: Uint8Array): Uint8Array | null {
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    if (!PNG_METADATA.has(type)) kept.push(bytes.subarray(offset, end));
    offset = end;
    if (type === 'IEND') return concat(kept);
  }
  return null;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function checkImage(bytes: Uint8Array, declaredMime?: string): ImageCheck {
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, code: 'image_too_large' };
  const mime = detect(bytes);
  if (mime === null) return { ok: false, code: 'image_unsupported' };
  if (declaredMime !== undefined && declaredMime !== mime) return { ok: false, code: 'image_type_mismatch' };
  const cleaned = mime === 'image/jpeg' ? stripJpeg(bytes) : mime === 'image/png' ? stripPng(bytes) : bytes;
  if (cleaned === null) return { ok: false, code: 'image_corrupted' };
  return { ok: true, mime, bytes: cleaned };
}
