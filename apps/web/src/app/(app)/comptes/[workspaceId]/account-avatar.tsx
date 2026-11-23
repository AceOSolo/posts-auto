'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './comptes.module.css';

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters.map((word) => Array.from(word as string)[0]?.toUpperCase() ?? '').join('');
}

/**
 * Photo du compte LinkedIn, ou ses initiales s'il n'y en a pas ou si le lien ne répond plus
 * (les liens de photo de LinkedIn expirent ; la vérification quotidienne les renouvelle).
 */
export function AccountAvatar({ name, src, kind }: { name: string; src: string | null; kind: 'profile' | 'page' }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const image = useRef<HTMLImageElement>(null);

  // Une image en erreur avant l'hydratation n'a pas déclenché onError.
  useEffect(() => {
    const element = image.current;
    if (element !== null && element.complete && element.naturalWidth === 0) setFailedSrc(src);
  }, [src]);

  const className = `${styles.avatar} ${kind === 'page' ? styles.avatarPage : ''}`;
  return (
    <span className={className} aria-hidden="true">
      {src !== null && src !== failedSrc ? (
        // eslint-disable-next-line @next/next/no-img-element -- image hébergée par LinkedIn
        <img ref={image} src={src} alt="" width={64} height={64} referrerPolicy="no-referrer" onError={() => setFailedSrc(src)} />
      ) : (
        initials(name)
      )}
    </span>
  );
}
