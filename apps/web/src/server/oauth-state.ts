/**
 * État de la connexion LinkedIn en cours, conservé dans un cookie de 10 minutes : la valeur
 * « state » protège contre la falsification de requête (elle doit revenir à l'identique),
 * l'espace visé et le choix de consentement à l'apprentissage.
 * L'identité de la personne n'y figure pas : au retour, elle vient de sa session.
 */
export const OAUTH_COOKIE = 'li_oauth';

export interface OAuthState {
  readonly state: string;
  readonly workspaceId: string;
  readonly aiLearning: boolean;
}

export function encodeOAuthState(value: OAuthState): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeOAuthState(raw: string | undefined): OAuthState | null {
  if (raw === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<OAuthState>;
    if (typeof value.state !== 'string' || typeof value.workspaceId !== 'string' || typeof value.aiLearning !== 'boolean') return null;
    return { state: value.state, workspaceId: value.workspaceId, aiLearning: value.aiLearning };
  } catch {
    return null;
  }
}
