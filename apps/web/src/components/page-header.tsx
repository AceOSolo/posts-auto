import Link from 'next/link';
import type { ReactNode } from 'react';

export interface PageMenuItem {
  readonly label: string;
  readonly href: string;
  /** Fichier à télécharger plutôt qu'une page à ouvrir. */
  readonly download?: boolean;
}

interface PageHeaderProps {
  readonly title: ReactNode;
  /** Une phrase, seulement si elle aide à comprendre la page. */
  readonly description?: ReactNode;
  /** L'action principale de la page : une seule. */
  readonly action?: ReactNode;
  /** Les usages rares, repliés derrière « ··· ». */
  readonly menu?: readonly PageMenuItem[];
}

/** L'en-tête commun des pages : le titre, l'action principale et les usages rares. */
export function PageHeader({ title, description, action, menu }: PageHeaderProps) {
  const hasMenu = menu !== undefined && menu.length > 0;
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {description !== undefined && <p>{description}</p>}
      </div>
      {(hasMenu || action !== undefined) && (
        <div className="page-head-actions no-print">
          {hasMenu && (
            <details className="page-menu">
              <summary aria-label="Plus d’actions">
                <span aria-hidden="true">···</span>
              </summary>
              <div className="page-menu-panel">
                {menu.map((item) =>
                  item.download === true ? (
                    <a key={item.href} href={item.href} download>
                      {item.label}
                    </a>
                  ) : (
                    <Link key={item.href} href={item.href}>
                      {item.label}
                    </Link>
                  ),
                )}
              </div>
            </details>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
