import Link from 'next/link';
import type { ReactNode } from 'react';
import { requireAdmin } from '../../../server/admin.ts';

/** Back-office de l'éditeur (ADM-01 à ADM-06). */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return (
    <>
      <nav aria-label="Back-office" className="subnav">
        <Link href="/admin">Organisations</Link>
        <Link href="/admin/supervision">Supervision</Link>
        <Link href="/admin/parametres">Paramètres et IA</Link>
        <Link href="/admin/galerie">Galerie de départ</Link>
        <Link href="/admin/annonces">Annonces</Link>
        <Link href="/admin/site">Site et démos</Link>
      </nav>
      {children}
    </>
  );
}
