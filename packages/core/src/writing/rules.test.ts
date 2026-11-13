import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EDITORIAL_RULES,
  type EditorialRules,
  characterCount,
  checkPostText,
  findRepeatedSentences,
  normalizeForComparison,
  parseEditorialRules,
} from './rules.ts';

const filler = (n: number) => 'Une phrase de remplissage sans rien de particulier. '.repeat(n).trim();
const rules: EditorialRules = { ...DEFAULT_EDITORIAL_RULES, minLength: 0 };
const codes = (text: string, r: EditorialRules = rules, bannedPhrases?: string[]) =>
  checkPostText(text, r, bannedPhrases ? { bannedPhrases } : {}).map((i) => i.code);

describe('règles mesurables (EDI-02, RÈG-15)', () => {
  it('un texte conforme ne déclenche rien', () => {
    const text = `Accroche courte.\n\n${filler(8)}\n\nEt vous, comment faites-vous ?\n\nInscription : https://exemple.fr/webinaire`;
    expect(checkPostText(text, { ...DEFAULT_EDITORIAL_RULES, minLength: 300 })).toEqual([]);
  });

  it('refuse les hashtags, mais pas « C# », les ancres d’URL ni « n°1 »', () => {
    expect(codes('Vive la #prévention ?')).toEqual(['hashtag']);
    expect(codes('Je code en C# depuis 10 ans ?')).toEqual([]);
    expect(codes('Lisez ceci ?\nhttps://exemple.fr/page#section')).toEqual([]);
    expect(codes('Un hashtag autorisé #sécurité ?', { ...rules, maxHashtags: 1 })).toEqual([]);
  });

  it('refuse les mentions @, pas les adresses e-mail', () => {
    expect(codes('Merci @JeanDupont pour ce moment ?')).toEqual(['mention']);
    expect(codes('Écrivez à contact@secutop.fr ?')).toEqual([]);
  });

  it('les liens vont en fin de texte', () => {
    expect(codes('Lisez https://exemple.fr puis revenez ici.\nQu’en pensez-vous ?')).toEqual(['link_not_at_end']);
    expect(codes('Qu’en pensez-vous ?\n\nLe guide : https://exemple.fr\nLe webinaire : www.exemple.fr/w')).toEqual([]);
  });

  it('longueur comptée en caractères, comme LinkedIn (un emoji = 1)', () => {
    expect(characterCount('é👍')).toBe(2);
    const r = { ...rules, minLength: 20, maxLength: 40 };
    expect(codes('Trop court ?', r)).toEqual(['too_short']);
    expect(codes(`${'x'.repeat(50)} ?`, r)).toEqual(['too_long']);
    expect(codes(`${'x'.repeat(3001)} ?`, { ...r, maxLength: 3000 })).toEqual(['linkedin_limit', 'hook_too_long']);
  });

  it('emojis : aucun, rares (2 au plus) ou libres', () => {
    expect(codes('Bravo 👏 ?', { ...rules, emojis: 'none' })).toEqual(['emoji']);
    expect(codes('Bravo 👏🎉 ?')).toEqual([]);
    expect(codes('Bravo 👏🎉🚀 ?')).toEqual(['emoji']);
    expect(codes('Bravo 👏🎉🚀 ?', { ...rules, emojis: 'free' })).toEqual([]);
  });

  it('formules interdites, sans tenir compte de la casse ni des accents', () => {
    expect(codes('Nous sommes LEADER du marché ?', rules, ['leader du marche'])).toEqual(['banned_phrase']);
    expect(codes('Nous sommes leaders ?', rules, ['leader'])).toEqual([]);
  });

  it('question au lecteur et accroche courte : simples avertissements', () => {
    const issues = checkPostText(`${'Une accroche beaucoup trop longue '.repeat(8)}\n${filler(2)}`, rules);
    expect(issues.map((i) => [i.code, i.severity])).toEqual([
      ['no_question', 'warning'],
      ['hook_too_long', 'warning'],
    ]);
    // Une question dans une ligne de lien ne compte pas.
    expect(codes('Rien à demander.\nhttps://exemple.fr/?q=1')).toEqual(['no_question']);
  });

  it('lit les règles enregistrées en remplaçant les valeurs invalides par défaut', () => {
    expect(parseEditorialRules(null)).toEqual(DEFAULT_EDITORIAL_RULES);
    expect(parseEditorialRules({ maxHashtags: -1, emojis: 'beaucoup', minLength: 2000, maxLength: 800, askQuestion: false })).toEqual({
      ...DEFAULT_EDITORIAL_RULES,
      minLength: 800,
      maxLength: 2000,
      askQuestion: false,
    });
  });
});

describe('phrases répétées sur 8 semaines (RÈG-17)', () => {
  const previous = [
    { postId: 'p1', text: 'La sécurité commence par vous.\nNos équipes interviennent partout en France depuis vingt ans.' },
    { postId: 'p2', text: 'Un autre texte. Et vous ?' },
  ];

  it('repère une phrase reprise, malgré la casse, les accents et la ponctuation', () => {
    const text = 'Nouvelle accroche.\nNOS EQUIPES interviennent, partout en France, depuis vingt ans !';
    expect(findRepeatedSentences(text, previous)).toEqual([
      { sentence: 'NOS EQUIPES interviennent, partout en France, depuis vingt ans !', postId: 'p1' },
    ]);
  });

  it('compare les accroches entre elles dès 4 mots, et ignore les phrases courtes', () => {
    expect(findRepeatedSentences('La sécurité commence par vous !\nSuite.', previous)).toEqual([
      { sentence: 'La sécurité commence par vous !', postId: 'p1' },
    ]);
    expect(findRepeatedSentences('Bonjour.\nEt vous ?', previous)).toEqual([]);
    // Une phrase courte reprise ailleurs que dans l'accroche ne compte pas.
    expect(findRepeatedSentences('Accroche.\nLa sécurité commence par vous.', previous)).toEqual([]);
  });

  it('normalise apostrophes et accents', () => {
    expect(normalizeForComparison('L’Été, déjà !')).toBe('l ete deja');
  });
});
