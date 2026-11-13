/**
 * Modèle simulé (AI_MODE=fake) : pour les tests et pour faire tourner l'application sans
 * clé. Les textes produits sont des gabarits clairement marqués comme tels ; ils respectent
 * les règles mesurables pour que le reste de la chaîne (vérification, dépôt, validation)
 * fonctionne comme avec le vrai modèle.
 *
 * Les tests passent leur propre `handler` pour simuler un modèle qui se trompe.
 */
import { type ModelCall, NO_USAGE, type ModelResult, type TextModel } from './model.ts';

export type FakeHandler = (request: ModelCall<unknown>, callIndex: number) => unknown;

export class FakeModel implements TextModel {
  readonly provider = 'simulation';
  readonly model = 'simulation';
  readonly calls: ModelCall<unknown>[] = [];
  readonly #handler: FakeHandler;
  #drafts = 0;

  constructor(handler?: FakeHandler) {
    this.#handler = handler ?? ((request) => this.#demo(request));
  }

  async call<T>(request: ModelCall<T>): Promise<ModelResult<T>> {
    this.calls.push(request as ModelCall<unknown>);
    const raw = this.#handler(request as ModelCall<unknown>, this.calls.length - 1);
    // Comme le vrai modèle : une réponse hors schéma est refusée.
    const value = request.schema.parse(raw);
    const size = Math.ceil((request.system.length + request.context.length + request.task.length) / 4);
    return { value, provider: this.provider, model: this.model, usage: { ...NO_USAGE, inputTokens: size, outputTokens: Math.ceil(JSON.stringify(raw).length / 4) } };
  }

  #demo(request: ModelCall<unknown>): unknown {
    if (request.purpose === 'verify') return { issues: [] };
    if (request.purpose === 'interpret') return demoInterpretation(request.task);
    if (request.purpose === 'visual' && (request.images?.length ?? 0) > 0) {
      // Contrôle d'une image (VIS-11) : le générateur simulé ne produit que des dégradés.
      return { identifiablePerson: false, visibleText: false, logoOrBrand: false, defects: false, shocking: false, description: 'Image abstraite en dégradé de couleurs (démonstration)' };
    }
    if (request.purpose === 'visual') return demoVisual(request.task);
    this.#drafts += 1;
    if (request.task.startsWith('Propose trois accroches')) {
      return { hooks: [1, 2, 3].map((n) => `Accroche de démonstration n°${n} (sans IA)`) };
    }
    return demoDraft(request.context, request.task, this.#drafts);
  }
}

/** Gabarit de démonstration : phrases courtes (jamais comparées entre posts, RÈG-17), longueur dans la plage de l'espace. */
export function demoDraft(context: string, task: string, counter: number): unknown {
  const subject = /^Sujet : (.+)$/m.exec(task)?.[1]?.trim();
  const title = subject === undefined || subject.startsWith('à toi de le choisir') ? `sujet libre n°${counter}` : subject.slice(0, 120);
  const range = /longueur entre (\d+) et (\d+) caractères/.exec(context);
  const min = Number(range?.[1] ?? 600);
  const links = [...task.matchAll(/^- (https?:\/\/\S+)$/gm)].map((m) => m[1] as string);
  const head = `Démonstration : ${title}\n\n(Texte provisoire, sans IA.)\n\n`;
  // Question courte : une phrase de 6 mots ou plus répétée d'un post à l'autre serait refusée (RÈG-17).
  const tail = `\n\nVotre avis ?${links.length > 0 ? `\n\n${links.join('\n')}` : ''}`;
  let filler = '';
  while ([...head, ...filler, ...tail].length < min) filler += 'Texte provisoire de démonstration. ';
  return {
    body: `${head}${filler.trim()}${tail}`,
    summary: title,
    sourcesUsed: [],
    missingInformation: [],
    ignoredInstructions: [],
  };
}

/**
 * Visuel de démonstration : titre tiré de la première ligne du post ; photo de la
 * médiathèque si son nom ou ses mots-clés reprennent un mot du post, sinon une scène.
 */
function demoVisual(task: string): unknown {
  const post = /<document type="post"[^>]*>\n([\s\S]*?)\n<\/document>/.exec(task)?.[1] ?? '';
  const title = (post.split('\n')[0] ?? '').replace(/^Démonstration : /, '').trim();
  const words = new Set((post.toLowerCase().match(/\p{L}{4,}/gu) ?? []).filter((w) => w !== 'démonstration'));
  const photos = [...task.matchAll(/^- ([0-9a-f-]{36}) : (.*)$/gm)].map((m) => ({ id: m[1] as string, words: (m[2] as string).toLowerCase().match(/\p{L}{4,}/gu) ?? [] }));
  const wantPhoto = task.startsWith('Une photo est demandée');
  const match = wantPhoto ? photos.find((p) => p.words.some((w) => words.has(w))) : undefined;
  return {
    title: title || 'Visuel de démonstration',
    subtitle: '',
    bullets: ['Premier point à retenir', 'Deuxième point à retenir', 'Troisième point à retenir'],
    libraryPhotoId: match?.id ?? '',
    imageSubject: wantPhoto && match === undefined ? 'Bureau lumineux, dossiers et casque de chantier posés sur une table, lumière du matin' : '',
    altText: `Visuel : ${title || 'démonstration'}`,
    ignoredInstructions: [],
  };
}

function demoInterpretation(task: string): unknown {
  const text = /<document type="demande"[^>]*>\n([\s\S]*?)\n<\/document>/.exec(task)?.[1] ?? '';
  return {
    accountIds: [],
    title: text.split(/[.\n]/)[0]?.trim().slice(0, 80) ?? '',
    details: text.trim(),
    links: [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]),
    wishedDate: '',
    wishedTime: '',
    toSpecify: [],
    ignoredInstructions: [],
  };
}
