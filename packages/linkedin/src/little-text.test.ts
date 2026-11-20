import { describe, expect, it } from 'vitest';
import { escapeLittleText, toLittleText } from './little-text.ts';

describe('format little (champ commentary)', () => {
  it('échappe chaque caractère réservé', () => {
    expect(escapeLittleText('| { } @ [ ] ( ) < > # \\ * _ ~')).toBe(
      '\\| \\{ \\} \\@ \\[ \\] \\( \\) \\< \\> \\# \\\\ \\* \\_ \\~',
    );
  });

  it('protège les listes à puces et les parenthèses d’un post ordinaire', () => {
    const post = 'Trois réflexes (à garder) :\n* aérer\n* trier\n* former_tous';
    expect(escapeLittleText(post)).toBe('Trois réflexes \\(à garder\\) :\n\\* aérer\n\\* trier\n\\* former\\_tous');
  });

  it('laisse intacts les accents, les émojis et les sauts de ligne', () => {
    expect(escapeLittleText('Été 2026 ✅\nÀ bientôt !')).toBe('Été 2026 ✅\nÀ bientôt !');
  });

  it('publie les hashtags comme du texte par défaut (RÈG-15)', () => {
    expect(toLittleText('Bravo #prévention')).toBe('Bravo \\#prévention');
  });

  it('les rend cliquables si l’espace les autorise, en échappant le reste', () => {
    expect(toLittleText('#DUERP : (enfin) prêt ! #prévention_2026', { linkHashtags: true })).toBe(
      '{hashtag|\\#|DUERP} : \\(enfin\\) prêt ! {hashtag|\\#|prévention\\_2026}',
    );
  });

  it('ne prend pas pour un hashtag un « # » collé à un mot', () => {
    expect(toLittleText('C#', { linkHashtags: true })).toBe('C\\#');
  });
});

describe('mentions structurées (PUB-08)', () => {
  it('une mention préparée devient une mention LinkedIn ; un @ isolé reste du texte', async () => {
    const { toLittleText } = await import('./little-text.ts');
    expect(toLittleText('Merci @[Secutop (Lyon)](urn:li:organization:123) et @jp !')).toBe('Merci @[Secutop \\(Lyon\\)](urn:li:organization:123) et \\@jp !');
  });
});
