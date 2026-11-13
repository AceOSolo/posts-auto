import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenCipher } from './token-cipher.ts';

const key = () => randomBytes(32);

describe('chiffrement des jetons LinkedIn (SEC-02)', () => {
  const k1 = key();
  const cipher = new TokenCipher(new Map([['k1', k1]]), 'k1');

  it('chiffre puis déchiffre ; deux chiffrements du même jeton diffèrent', () => {
    const a = cipher.encrypt('AQX-secret', 'compte-1');
    const b = cipher.encrypt('AQX-secret', 'compte-1');
    expect(cipher.decrypt(a, 'compte-1')).toBe('AQX-secret');
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from('AQX-secret'))).toBe(false);
  });

  it('refuse un jeton copié sur un autre compte', () => {
    const payload = cipher.encrypt('AQX-secret', 'compte-1');
    expect(() => cipher.decrypt(payload, 'compte-2')).toThrow(/autre compte/);
  });

  it('refuse un jeton altéré', () => {
    const payload = cipher.encrypt('AQX-secret', 'compte-1');
    payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt(payload, 'compte-1')).toThrow(/illisible/);
  });

  it('rotation : les anciens jetons restent lisibles et sont signalés à rechiffrer', () => {
    const old = cipher.encrypt('ancien', 'compte-1');
    const rotated = new TokenCipher(new Map([['k1', k1], ['k2', key()]]), 'k2');
    expect(rotated.decrypt(old, 'compte-1')).toBe('ancien');
    expect(rotated.needsReencryption(old)).toBe(true);
    expect(rotated.needsReencryption(rotated.encrypt('nouveau', 'compte-1'))).toBe(false);
  });

  it('refuse de déchiffrer si la clé a été retirée', () => {
    const old = cipher.encrypt('ancien', 'compte-1');
    const withoutK1 = new TokenCipher(new Map([['k2', key()]]), 'k2');
    expect(() => withoutK1.decrypt(old, 'compte-1')).toThrow(/clé absente/);
  });

  it('lit la configuration depuis l’environnement et rejette une configuration invalide', () => {
    const env = { TOKEN_ENCRYPTION_KEYS: `k1:${k1.toString('base64')}`, TOKEN_ENCRYPTION_KEY_ID: 'k1' };
    const fromEnv = TokenCipher.fromEnv(env);
    expect(fromEnv.decrypt(cipher.encrypt('x', 'c'), 'c')).toBe('x');
    expect(() => TokenCipher.fromEnv({})).toThrow(/obligatoires/);
    expect(() => TokenCipher.fromEnv({ ...env, TOKEN_ENCRYPTION_KEY_ID: 'k9' })).toThrow(/absente/);
    expect(() => TokenCipher.fromEnv({ ...env, TOKEN_ENCRYPTION_KEYS: 'k1:AAAA' })).toThrow(/32 octets/);
    expect(() => TokenCipher.fromEnv({ ...env, TOKEN_ENCRYPTION_KEYS: 'nimportequoi' })).toThrow(/format/);
  });
});
