import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { preload } from 'react-dom';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Rostra', template: '%s · Rostra' },
  description: 'Vos posts LinkedIn rédigés par l’IA, validés par chacun, publiés à l’heure.',
  applicationName: 'Rostra',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Couleur de la barre du navigateur : travertin, ou fond sombre en mode sombre (charte Rostra).
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5efe4' },
    { media: '(prefers-color-scheme: dark)', color: '#1a1614' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Polices de la charte, hébergées sur le site : chargées en priorité pour limiter le décalage d'affichage.
  preload('/fonts/fraunces-latin.woff2', { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
  preload('/fonts/hanken-grotesk-latin.woff2', { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
