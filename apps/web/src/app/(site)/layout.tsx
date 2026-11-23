import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '../../components/logo.tsx';
import { appUrl } from '../../server/context.ts';
import './vitrine.css';

// L'adresse du site (APP_URL) n'est connue qu'au lancement : les pages sont rendues à la demande.
export const dynamic = 'force-dynamic';

/** SIT-06 : adresses canoniques et images de partage absolues. */
export function generateMetadata(): Metadata {
  return { metadataBase: new URL(appUrl()) };
}

/** Site vitrine et pages légales (SIT-01, SIT-04) : rendu serveur, sans JavaScript ni cookie. */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="site">
      <header className="site-header">
        <Link href="/" className="brand" aria-label="Rostra, accueil">
          <Logo title="Rostra" />
        </Link>
        <nav aria-label="Site">
          <a href="/#fonctionnement" className="nav-large">
            Comment ça marche
          </a>
          <Link href="/pme-eti" className="nav-large">
            PME et ETI
          </Link>
          <Link href="/agences" className="nav-large">
            Agences
          </Link>
          <Link href="/tarifs">Tarifs</Link>
          <Link href="/en" hrefLang="en" lang="en" className="lien-english">
            English
          </Link>
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
        <div className="footer-colonnes">
          <nav aria-labelledby="pied-produit">
            <h2 id="pied-produit">Produit</h2>
            <a href="/#fonctionnement">Comment ça marche</a>
            <Link href="/tarifs">Tarifs</Link>
            <Link href="/comment-fonctionne-la-redaction">Comment fonctionne la rédaction</Link>
            <a href="/#faq">Questions fréquentes</a>
          </nav>
          <nav aria-labelledby="pied-solutions">
            <h2 id="pied-solutions">Pour qui</h2>
            <Link href="/pme-eti">PME et ETI</Link>
            <Link href="/agences">Agences et freelances</Link>
            <Link href="/en" hrefLang="en" lang="en">
              English
            </Link>
          </nav>
          <nav aria-labelledby="pied-confiance">
            <h2 id="pied-confiance">Confiance</h2>
            <Link href="/confiance">Sécurité et RGPD</Link>
            <Link href="/sous-traitants">Sous-traitants</Link>
            <Link href="/confidentialite">Confidentialité</Link>
            <Link href="/cookies">Cookies</Link>
          </nav>
          <nav aria-labelledby="pied-legal">
            <h2 id="pied-legal">Informations légales</h2>
            <Link href="/mentions-legales">Mentions légales</Link>
            <Link href="/cgu">Conditions d’utilisation</Link>
            <Link href="/cgv">Conditions de vente</Link>
          </nav>
        </div>
        <p className="muted">
          Rostra est un service édité par SimplX. Données hébergées dans l’Union européenne. LinkedIn est une marque de LinkedIn Corporation ; Rostra n’est ni affilié à LinkedIn ni approuvé par
          LinkedIn.
        </p>
      </footer>
    </div>
  );
}
