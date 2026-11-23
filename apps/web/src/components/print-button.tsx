'use client';

/** Ouvre l'impression du navigateur, qui permet aussi d'enregistrer la page en PDF. */
export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" onClick={() => window.print()}>
      {label}
    </button>
  );
}
