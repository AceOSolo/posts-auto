import type { ReactNode } from 'react';

/** Information que SimplX doit compléter avant la mise en ligne (pages légales, SIT-04). */
export function Todo({ children }: { children: ReactNode }) {
  return <span className="todo">[À compléter par SimplX : {children}]</span>;
}

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="site-main legal">
      <h1>{title}</h1>
      <p className="hint">
        Dernière mise à jour : {updated}. Projet de texte, à faire relire par un juriste avant la mise en ligne.
      </p>
      {children}
    </main>
  );
}
