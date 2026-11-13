/**
 * Faux LinkedIn pour les tests et le développement local : garde en mémoire les posts
 * « publiés » et permet d'injecter des pannes, y compris la pire : le post est créé
 * mais la réponse se perd (issue incertaine).
 */
import { type PublishRequest, type PublishedPost, type LinkedInPublisher, postUrl } from './client.js';
import { LinkedInError } from './errors.js';

export interface FakePublishedPost extends PublishedPost {
  readonly accessToken: string;
  readonly request: PublishRequest;
}

export type FakeFailure =
  /** La requête échoue avant toute création (connexion refusée, 503…). */
  | { readonly type: 'error'; readonly error: LinkedInError }
  /** Le post est créé chez LinkedIn, mais la réponse n'arrive jamais. */
  | { readonly type: 'created_then_lost' };

export class FakeLinkedIn implements LinkedInPublisher {
  readonly published: FakePublishedPost[] = [];
  readonly #failures: FakeFailure[] = [];
  #sequence = 7_300_000_000_000_000_000n;

  /** Les prochains appels échoueront dans l'ordre donné, puis tout refonctionne. */
  failNext(...failures: FakeFailure[]): this {
    this.#failures.push(...failures);
    return this;
  }

  async publish(accessToken: string, request: PublishRequest): Promise<PublishedPost> {
    const failure = this.#failures.shift();
    if (failure?.type === 'error') throw failure.error;

    this.#sequence += 1n;
    const postUrn = `urn:li:share:${this.#sequence}`;
    const post = { postUrn, url: postUrl(postUrn), accessToken, request };
    this.published.push(post);

    if (failure?.type === 'created_then_lost') {
      throw new LinkedInError({
        kind: 'network',
        phase: 'post_create',
        outcome: 'unknown',
        message: 'Délai de réponse de LinkedIn dépassé',
      });
    }
    return { postUrn, url: post.url };
  }
}

/** Raccourcis pour les pannes courantes. */
export const linkedInFailures = {
  connectionRefused: (): FakeFailure => ({
    type: 'error',
    error: new LinkedInError({ kind: 'network', phase: 'post_create', outcome: 'not_created', code: 'ECONNREFUSED', message: 'Erreur réseau (ECONNREFUSED)' }),
  }),
  serviceUnavailable: (): FakeFailure => ({
    type: 'error',
    error: new LinkedInError({ kind: 'server', phase: 'post_create', outcome: 'not_created', status: 503, message: 'SERVICE_UNAVAILABLE' }),
  }),
  tokenRevoked: (): FakeFailure => ({
    type: 'error',
    error: new LinkedInError({ kind: 'auth', phase: 'image_upload', outcome: 'not_created', status: 401, message: 'EMPTY_ACCESS_TOKEN' }),
  }),
  createdThenLost: (): FakeFailure => ({ type: 'created_then_lost' }),
};
