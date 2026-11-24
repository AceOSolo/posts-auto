/**
 * Scènes animées du site vitrine, en CSS seul (voir vivant.css) : décoratives, rendues côté
 * serveur, et à l'arrêt si la personne demande moins d'animations.
 */
import type { CSSProperties } from 'react';

const TONS = ['rose', 'soleil', 'vert', 'marbre'] as const;

/** Tesselles qui dérivent : la matière de la marque, posée en fond d'un bloc. */
export function Tesselles({ nombre = 14, className = '' }: { nombre?: number; className?: string }) {
  const tuiles = Array.from({ length: nombre }, (_, i) => ({
    left: (i * 37 + 11) % 100,
    top: (i * 53 + 7) % 100,
    taille: 8 + ((i * 7) % 4) * 4,
    ton: TONS[i % TONS.length],
    duree: 7 + ((i * 3) % 6),
    delai: -((i * 13) % 9),
    rotation: ((i * 29) % 60) - 30,
  }));
  return (
    <span className={`tesselles ${className}`} aria-hidden="true">
      {tuiles.map((t) => (
        <i
          key={`${t.left}-${t.top}`}
          className={`ton-${t.ton}`}
          style={{ left: `${t.left}%`, top: `${t.top}%`, width: t.taille, height: t.taille, '--rot': `${t.rotation}deg`, animationDuration: `${t.duree}s`, animationDelay: `${t.delai}s` } as CSSProperties}
        />
      ))}
    </span>
  );
}

const MAILS = ['RE: RE: post v3 FINAL (2)', 'Tu as pu relire ?', 'Relance n° 4', 'post_linkedin_def_OK.docx', 'On publie quand ?', 'Finalement, on change tout'];
const LIGNES = [
  ['Claire', 'Validé'],
  ['Thomas', 'Validé'],
  ['Page', 'Publié'],
] as const;

/** Le problème en image : le désordre des relances, puis une semaine sous contrôle. */
export function AvantApres() {
  return (
    <div className="aa" aria-hidden="true">
      <div className="aa-panneau aa-avant">
        <b>Sans Rostra</b>
        {MAILS.map((m) => (
          <span key={m} className="aa-mail">
            {m}
          </span>
        ))}
      </div>
      <div className="aa-fleche">→</div>
      <div className="aa-panneau aa-apres">
        <b>Avec Rostra</b>
        <ul>
          {LIGNES.map(([qui, etat]) => (
            <li key={qui}>
              <span>{qui}</span>
              <em className={etat === 'Publié' ? 'publie' : 'valide'}>{etat}</em>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const PLANNING: readonly (readonly [string, readonly (number | null)[]])[] = [
  ['Claire', [0, 2.2, 4.4]],
  ['Thomas', [1.1, 3.3, null]],
  ['Page', [5.5, null, 6.6]],
];

/** Le planning qui vit : chaque case passe de « À valider » à « Validé » puis « Publié ». */
export function PlanningVivant() {
  return (
    <figure className="maquette" style={{ margin: 0 }} aria-label="Exemple de planning pour trois comptes, dont les posts passent de à valider à validé puis publié">
      <div className="grille" aria-hidden="true">
        <span className="th" />
        <span className="th">Mar.</span>
        <span className="th">Jeu.</span>
        <span className="th">Ven.</span>
        {PLANNING.flatMap(([compte, cases]) => [
          <span key={compte} className="th">
            {compte}
          </span>,
          ...cases.map((d, i) =>
            d === null ? (
              <span key={`${compte}-${i}`} />
            ) : (
              <span key={`${compte}-${i}`} className="pc-case" style={{ '--d': `${d}s` } as CSSProperties}>
                <b className="a-valider">À valider</b>
                <b className="valide">Validé</b>
                <b className="publie">Publié</b>
              </span>
            ),
          ),
        ])}
      </div>
    </figure>
  );
}

const RANGS: Record<string, number> = { planning: 9, voix: 7, idees: 3, visuels: 16, validation: 1, delegation: 3, publication: 1, canaux: 2, stats: 6 };

/** Petite illustration animée d'une fonctionnalité. */
export function MiniVisuel({ type }: { type: keyof typeof RANGS & string }) {
  return (
    <span className={`mv mv-${type}`} aria-hidden="true">
      {Array.from({ length: RANGS[type] ?? 0 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: motif fixe, jamais réordonné.
        <i key={i} style={{ '--i': i } as CSSProperties} />
      ))}
    </span>
  );
}
