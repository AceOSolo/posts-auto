import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="narrow">
      <h1>Page introuvable</h1>
      <p>Cette page n’existe pas, ou vous n’y avez pas accès.</p>
      <p>
        <Link href="/">Retour à mes posts</Link>
      </p>
    </main>
  );
}
