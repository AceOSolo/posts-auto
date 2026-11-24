/**
 * Aperçu fidèle du rendu LinkedIn (VAL-01) : texte coupé à « … voir plus » comme sur
 * l'application mobile, marqueurs [À COMPLÉTER] surlignés (VAL-03), photos dans l'ordre.
 * Fonctionne sans JavaScript (<details>).
 */
import { findBlockingMarkers } from '@posts-auto/core';
import type { PostMedia } from '@posts-auto/services';
import type { ReactNode } from 'react';

/** Longueur affichée avant « voir plus » sur mobile (environ trois lignes). */
const FOLD = 210;

function withMarkers(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const marker of findBlockingMarkers(text)) {
    if (marker.start > last) nodes.push(text.slice(last, marker.start));
    nodes.push(
      <mark key={`${keyPrefix}-${marker.start}`} className="marker" title="À compléter avant de valider">
        {marker.text}
      </mark>,
    );
    last = marker.end;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Coupe sans tomber au milieu d'un mot ni d'un marqueur. */
function foldAt(text: string): number {
  if (text.length <= FOLD + 40) return text.length;
  let cut = text.lastIndexOf(' ', FOLD);
  if (cut < FOLD / 2) cut = FOLD;
  for (const marker of findBlockingMarkers(text)) {
    if (marker.start < cut && marker.end > cut) cut = marker.start;
  }
  return cut;
}

export function PostPreview({
  accountName,
  accountKind,
  body: rawBody,
  media,
  mediaBase = '/media',
  expanded = false,
}: {
  accountName: string;
  accountKind: 'profile' | 'page';
  body: string;
  media: readonly PostMedia[];
  /** Adresse des images : `/media` avec une session, le lien de validation sinon (VAL-06). */
  mediaBase?: string;
  expanded?: boolean;
}) {
  // PUB-08 : une mention s'affiche comme sur LinkedIn, « @Nom de la page ».
  const body = rawBody.replace(/@\[([^\]\n]{1,100})\]\(urn:li:(?:organization|person):[A-Za-z0-9_-]{1,40}\)/g, '@$1');
  const cut = expanded ? body.length : foldAt(body);
  const initials = accountName
    .split(/\s+/)
    .map((word) => word[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <article className="li-preview" aria-label={`Aperçu LinkedIn du post de ${accountName}`}>
      <header className="li-author">
        <span className={`li-avatar ${accountKind}`} aria-hidden="true">
          {initials}
        </span>
        <span>
          <strong>{accountName}</strong>
          <small>{accountKind === 'page' ? 'Page' : 'Profil'}</small>
        </span>
      </header>
      <div className="li-text">
        {withMarkers(body.slice(0, cut), 'a')}
        {cut < body.length && (
          <details className="li-more">
            <summary>… voir plus</summary>
            {withMarkers(body.slice(cut), 'b')}
          </details>
        )}
      </div>
      {media.length > 0 && (
        <div className={`li-media count-${Math.min(media.length, 5)}`}>
          {media.slice(0, 5).map((item, index) => (
            <figure key={item.assetId} className={index === 0 ? 'cover' : undefined}>
              {item.isDocument ? (
                // VIS-10 : carrousel PDF, ouvert dans un nouvel onglet.
                <a href={`${mediaBase}/${item.assetId}`} target="_blank" rel="noopener noreferrer" className="document-link">
                  Carrousel PDF : {item.altText ?? 'document'}
                </a>
              ) : (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- images privées servies par /media */}
                  <img src={`${mediaBase}/${item.assetId}`} alt={item.altText ?? `Photo ${index + 1}`} loading="lazy" />
                </>
              )}
              {index === 4 && media.length > 5 && <span className="more">+{media.length - 5}</span>}
              {item.aiGenerated && <span className="ai-badge">Image générée par IA</span>}
            </figure>
          ))}
        </div>
      )}
    </article>
  );
}
