/**
 * Chiffrement des jetons LinkedIn au repos (SEC-02) : AES-256-GCM, clé maître hors base,
 * rotation possible.
 *
 * Format d'un jeton chiffré : version (1 octet) | longueur de l'identifiant de clé (1) |
 * identifiant de clé | vecteur d'initialisation (12) | étiquette d'authentification (16) |
 * texte chiffré.
 *
 * Le chiffré est lié à son compte (données authentifiées additionnelles) : un jeton copié
 * d'un compte vers un autre devient indéchiffrable.
 *
 * Rotation : ajouter la nouvelle clé, la désigner comme courante ; les anciens jetons
 * restent lisibles tant que leur clé est présente, et sont rechiffrés à leur prochain
 * renouvellement.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export class TokenCipher {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly #currentKeyId: string;

  constructor(keys: ReadonlyMap<string, Buffer>, currentKeyId: string) {
    for (const [id, key] of keys) {
      if (!/^[\w-]{1,32}$/.test(id)) throw new Error(`Identifiant de clé invalide : « ${id} »`);
      if (key.length !== KEY_LENGTH) throw new Error(`La clé « ${id} » doit faire ${KEY_LENGTH} octets`);
    }
    if (!keys.has(currentKeyId)) throw new Error(`Clé courante « ${currentKeyId} » absente`);
    this.#keys = keys;
    this.#currentKeyId = currentKeyId;
  }

  /**
   * Lit TOKEN_ENCRYPTION_KEYS (« id1:base64,id2:base64 ») et TOKEN_ENCRYPTION_KEY_ID.
   * Une clé se génère avec : node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  static fromEnv(env: Record<string, string | undefined> = process.env): TokenCipher {
    const raw = env['TOKEN_ENCRYPTION_KEYS'];
    const current = env['TOKEN_ENCRYPTION_KEY_ID'];
    if (!raw || !current) throw new Error('TOKEN_ENCRYPTION_KEYS et TOKEN_ENCRYPTION_KEY_ID sont obligatoires');
    const keys = new Map<string, Buffer>();
    for (const entry of raw.split(',')) {
      const [id, base64] = entry.trim().split(':');
      if (!id || !base64) throw new Error('TOKEN_ENCRYPTION_KEYS : format attendu « id:base64,id:base64 »');
      keys.set(id, Buffer.from(base64, 'base64'));
    }
    return new TokenCipher(keys, current);
  }

  get currentKeyId(): string {
    return this.#currentKeyId;
  }

  encrypt(plaintext: string, boundTo: string): Buffer {
    const keyId = Buffer.from(this.#currentKeyId, 'utf8');
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.#keys.get(this.#currentKeyId) as Buffer, iv);
    cipher.setAAD(Buffer.from(boundTo, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION, keyId.length]), keyId, iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload: Uint8Array, boundTo: string): string {
    const data = Buffer.from(payload);
    if (data[0] !== VERSION) throw new Error('Jeton chiffré : version inconnue');
    const keyIdLength = data[1] ?? 0;
    const keyId = data.subarray(2, 2 + keyIdLength).toString('utf8');
    const key = this.#keys.get(keyId);
    if (key === undefined) throw new Error(`Jeton chiffré avec une clé absente (« ${keyId} »)`);
    let offset = 2 + keyIdLength;
    const iv = data.subarray(offset, (offset += IV_LENGTH));
    const tag = data.subarray(offset, (offset += TAG_LENGTH));
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(boundTo, 'utf8'));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(data.subarray(offset)), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Jeton chiffré illisible : altéré, ou rattaché à un autre compte');
    }
  }

  /** Le jeton a-t-il été chiffré avec une autre clé que la courante (à rechiffrer) ? */
  needsReencryption(payload: Uint8Array): boolean {
    const data = Buffer.from(payload);
    return data.subarray(2, 2 + (data[1] ?? 0)).toString('utf8') !== this.#currentKeyId;
  }
}
