/**
 * ONB-01 : état d'une connexion Google ou Microsoft en cours, dans un cookie de 10 minutes
 * limité à /connexion/sso : « state » (contre la falsification) et vérificateur PKCE.
 */
export const SSO_COOKIE = 'sso';
export const SSO_COOKIE_PATH = '/connexion/sso';

export interface SsoState {
  readonly provider: 'google' | 'microsoft';
  readonly state: string;
  readonly verifier: string;
}

export function encodeSsoState(value: SsoState): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeSsoState(raw: string | undefined): SsoState | null {
  if (raw === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<SsoState>;
    if ((value.provider !== 'google' && value.provider !== 'microsoft') || typeof value.state !== 'string' || typeof value.verifier !== 'string') return null;
    return { provider: value.provider, state: value.state, verifier: value.verifier };
  } catch {
    return null;
  }
}
