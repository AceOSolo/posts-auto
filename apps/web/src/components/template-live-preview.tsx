'use client';

/**
 * Aperçu en direct de l'éditeur de modèles (VIS-02) : à chaque changement du formulaire,
 * le brouillon est rendu par le serveur, sans être enregistré. Sans JavaScript, l'image
 * montre le modèle enregistré et se met à jour à l'enregistrement.
 */
import { useEffect, useState } from 'react';

export function TemplateLivePreview({ formId, src, alt, initialProblems }: { formId: string; src: string; alt: string; initialProblems: readonly string[] }) {
  const [url, setUrl] = useState(src);
  const [problems, setProblems] = useState<readonly string[]>(initialProblems);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let current: string | null = null;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        controller?.abort();
        controller = new AbortController();
        const data = new FormData(form);
        data.delete('nouvelle-zone');
        setPending(true);
        try {
          const response = await fetch(src, { method: 'POST', body: data, signal: controller.signal });
          if (!response.ok) {
            setError(response.status === 422 ? await response.text() : 'Aperçu indisponible.');
            return;
          }
          const next = URL.createObjectURL(await response.blob());
          if (current !== null) URL.revokeObjectURL(current);
          current = next;
          setUrl(next);
          setError(null);
          const header = response.headers.get('X-Problemes');
          setProblems(header ? (JSON.parse(decodeURIComponent(header)) as string[]) : []);
        } catch (caught) {
          if ((caught as Error).name !== 'AbortError') setError('Aperçu indisponible.');
        } finally {
          setPending(false);
        }
      }, 350);
    };
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    return () => {
      form.removeEventListener('input', refresh);
      form.removeEventListener('change', refresh);
      clearTimeout(timer);
      controller?.abort();
      if (current !== null) URL.revokeObjectURL(current);
    };
  }, [formId, src]);

  return (
    <figure className="template-preview" aria-busy={pending}>
      {/* eslint-disable-next-line @next/next/no-img-element -- image rendue par le serveur, privée */}
      <img src={url} alt={alt} width={540} />
      <figcaption>Aperçu avec des textes d’exemple{pending ? ' (mise à jour…)' : ''}.</figcaption>
      {error !== null && (
        <p className="flash error" role="alert">
          {error}
        </p>
      )}
      {error === null && problems.length > 0 && (
        <div className="flash error" role="status">
          À revoir :
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
    </figure>
  );
}
