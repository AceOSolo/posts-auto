/**
 * Canva simulé (CANVA_MODE=fake) : deux modèles de marque, des champs nommés comme dans un
 * vrai modèle, et un « export » rendu localement. Développement et tests seulement.
 */
import type { CanvaApi, CanvaAutofillData, CanvaBrandTemplate, CanvaFieldType, CanvaTokens } from './canva.ts';
import { DEFAULT_BRAND, galleryTemplates } from './gallery.ts';
import { renderTemplate } from './render.ts';

export class FakeCanvaApi implements CanvaApi {
  readonly uploads = new Map<string, Uint8Array>();
  readonly designs: { readonly brandTemplateId: string; readonly title: string; readonly data: CanvaAutofillData }[] = [];

  constructor(readonly appUrl: string) {}

  authorizeUrl(input: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams({ state: input.state, code: 'fake-canva', retour: input.redirectUri });
    return `${input.redirectUri}?${params.toString()}`;
  }

  async exchangeCode(input: { code: string }, now: Date): Promise<CanvaTokens> {
    if (input.code !== 'fake-canva') throw new Error('code Canva simulé invalide');
    return { accessToken: 'canva-access', refreshToken: 'canva-refresh', expiresAt: new Date(now.getTime() + 4 * 3_600_000) };
  }

  async refresh(_refreshToken: string, now: Date): Promise<CanvaTokens> {
    return { accessToken: 'canva-access', refreshToken: 'canva-refresh', expiresAt: new Date(now.getTime() + 4 * 3_600_000) };
  }

  async brandTemplates(): Promise<CanvaBrandTemplate[]> {
    return [
      { id: 'BT-fake-annonce', title: 'Annonce (Canva)' },
      { id: 'BT-fake-conseil', title: 'Conseil de la semaine (Canva)' },
    ];
  }

  async dataset(): Promise<Record<string, CanvaFieldType>> {
    return { titre: 'text', sous_titre: 'text', points: 'text', photo: 'image' };
  }

  async uploadImage(_accessToken: string, _name: string, bytes: Uint8Array): Promise<string> {
    const id = `asset-fake-${this.uploads.size + 1}`;
    this.uploads.set(id, bytes);
    return id;
  }

  async renderPng(_accessToken: string, brandTemplateId: string, title: string, data: CanvaAutofillData): Promise<{ png: Uint8Array; designId: string }> {
    this.designs.push({ brandTemplateId, title, data });
    const text = (field: string) => {
      const value = data[field];
      return value?.type === 'text' ? value.text : undefined;
    };
    const photo = data['photo']?.type === 'image' ? this.uploads.get(data['photo'].assetId) : undefined;
    const template = galleryTemplates(DEFAULT_BRAND).find((t) => t.withPhoto === (photo !== undefined)) ?? galleryTemplates(DEFAULT_BRAND)[0];
    const result = await renderTemplate((template as NonNullable<typeof template>).definition, {
      title: text('titre') ?? title,
      ...(text('sous_titre') !== undefined && { subtitle: text('sous_titre') as string }),
      bullets: (text('points') ?? '').split('\n').filter(Boolean),
      photo: photo ?? null,
    });
    return { png: result.png, designId: `design-fake-${this.designs.length}` };
  }
}
