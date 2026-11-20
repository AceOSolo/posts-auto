import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '../../components/logo.tsx';

/** Site vitrine et pages légales (SIT-01, SIT-04) : rendu serveur, sans JavaScript ni cookie. */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="site">
      <header className="site-header">
        <Link href="/" className="brand" aria-label="Rostra, accueil">
          <Logo title="Rostra" />
        </Link>
        <nav aria-label="Site">
          <a href="/#fonctionnement">Comment ça marche</a>
          <a href="/#tarifs">Tarifs</a>
          <a href="/#faq">Questions</a>
          <Link href="/connexion">Connexion</Link>
          <Link href="/inscription" className="button primary">
            Essai gratuit
          </Link>
        </nav>
      </header>
      {children}
      <footer className="site-footer">
        <div className="footer-brand">
          <Logo title="Rostra" />
          <p className="signature">Prenez la parole.</p>
        </div>
        <nav aria-label="Informations légales">
          <Link href="/mentions-legales">Mentions légales</Link>
          <Link href="/cgu">Conditions d’utilisation</Link>
          <Link href="/cgv">Conditions de vente</Link>
          <Link href="/confidentialite">Confidentialité</Link>
          <Link href="/cookies">Cookies</Link>
          <Link href="/sous-traitants">Sous-traitants</Link>
          <Link href="/comment-fonctionne-la-redaction">Comment fonctionne la rédaction</Link>
        </nav>
        <p className="muted">Rostra est un service édité par SimplX. Données hébergées dans l’Union européenne.</p>
      </footer>
    </div>
  );
}
