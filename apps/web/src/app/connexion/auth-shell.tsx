import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '../../components/logo.tsx';
import styles from './connexion.module.css';

/** Cadre des écrans de connexion : le formulaire d'un côté, la mosaïque de la marque de l'autre. */
export function AuthShell({ title, intro, children, footer }: { title: string; intro?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={styles.colonne}>
        <Link href="/" className={styles.marque} aria-label="Rostra, accueil">
          <Logo title="Rostra" />
        </Link>
        <div className={styles.contenu}>
          <h1 className={styles.titre}>{title}</h1>
          {intro !== undefined && <p className={styles.intro}>{intro}</p>}
          {children}
        </div>
        {footer !== undefined && <div className={styles.pied}>{footer}</div>}
      </div>
      <div className={styles.scene} aria-hidden="true">
        <p className={styles.signature}>
          Prenez
          <br />
          la <span>parole.</span>
        </p>
        {/* Différée : le panneau est masqué sur téléphone, l'image n'y est pas téléchargée. */}
        <img className={styles.buste} src="/marque/buste-mosaique.svg" alt="" width={520} height={520} loading="lazy" decoding="async" />
      </div>
    </main>
  );
}

/** Logos officiels des fournisseurs de connexion. */
export function SsoIcon({ provider }: { provider: string }) {
  if (provider === 'google') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
        <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z" />
        <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z" />
        <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" />
      </svg>
    );
  }
  if (provider === 'microsoft') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
        <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
        <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
        <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
      </svg>
    );
  }
  return null;
}
