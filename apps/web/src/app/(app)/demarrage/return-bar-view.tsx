'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './return-bar.module.css';

/** Inutile sur le démarrage lui-même : la personne y voit déjà ses étapes. */
export function ReturnBarView({ href, label, cta, done }: { href: string; label: string; cta: string; done: boolean }) {
  const pathname = usePathname();
  if (pathname.startsWith('/demarrage/')) return null;
  return (
    <nav aria-label="Démarrage" className={styles.bar}>
      <span className={done ? styles.done : undefined}>{label}</span>
      <Link href={href} className={done ? 'button primary' : 'button'}>
        {cta}
      </Link>
    </nav>
  );
}
