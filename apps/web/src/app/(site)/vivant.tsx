'use client';

/**
 * Démonstrations vivantes de l'accueil. Le rendu serveur reste complet et lisible : sans
 * JavaScript, ou si la personne demande moins d'animations, tout s'affiche à l'arrêt.
 */
import { type CSSProperties, useEffect, useId, useRef, useState } from 'react';

/** Vrai quand l'élément est à l'écran, l'onglet ouvert et les animations autorisées. */
function useEnVue<T extends Element>(seuil = 0.25) {
  const ref = useRef<T>(null);
  const [actif, setActif] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let visible = false;
    const maj = () => setActif(visible && !document.hidden);
    const observateur = new IntersectionObserver(
      ([entree]) => {
        visible = entree?.isIntersecting ?? false;
        maj();
      },
      { threshold: seuil },
    );
    observateur.observe(element);
    document.addEventListener('visibilitychange', maj);
    return () => {
      observateur.disconnect();
      document.removeEventListener('visibilitychange', maj);
    };
  }, [seuil]);
  return [ref, actif] as const;
}

interface Voix {
  readonly initiales: string;
  readonly nom: string;
  readonly role: string;
  readonly texte: string;
  readonly page?: boolean;
}

const VOIX: readonly Voix[] = [
  {
    initiales: 'CM',
    nom: 'Claire M.',
    role: 'Directrice générale · mar. 8 h 30',
    texte: 'Nous ouvrons une agence à Lyon. Pas pour grandir à tout prix : pour être à une heure de chaque client.',
  },
  {
    initiales: 'TR',
    nom: 'Thomas R.',
    role: 'Responsable technique · jeu. 12 h',
    texte: 'Lyon, c’est fait. Concrètement pour l’équipe : moins de route, et plus de temps sur le terrain avec vous.',
  },
  {
    initiales: 'VE',
    nom: 'Votre entreprise',
    role: 'Page d’entreprise · ven. 9 h',
    texte: 'Nouvelle adresse, même exigence. Notre agence de Lyon vous accueille dès lundi. Passez nous dire bonjour !',
    page: true,
  },
];

const ECLATS = [
  [-74, -58, 'rose'],
  [-38, -86, 'soleil'],
  [12, -92, 'vert'],
  [58, -70, 'rose'],
  [86, -24, 'soleil'],
  [-92, -12, 'vert'],
  [-56, 34, 'soleil'],
  [70, 30, 'vert'],
] as const;

type Phase = 'repos' | 'ecrit' | 'attend' | 'valide' | 'publie';
const BADGE: Record<Phase, string> = { repos: 'À valider', ecrit: 'Rédaction…', attend: 'À valider', valide: 'Validé', publie: 'Publié' };

/** Accueil : la même actualité, rédigée dans trois voix, validée puis publiée. Décoratif. */
export function PostVivant() {
  const [ref, actif] = useEnVue<HTMLDivElement>();
  const [indice, setIndice] = useState(0);
  const [phase, setPhase] = useState<Phase>('repos');
  const voix = VOIX[indice] as Voix;
  const [lettres, setLettres] = useState(voix.texte.length);

  useEffect(() => {
    if (!actif) return;
    const longueur = voix.texte.length;
    const suite: readonly [number, () => void] =
      phase === 'repos'
        ? [900, () => (setLettres(0), setPhase('ecrit'))]
        : phase === 'ecrit'
          ? lettres < longueur
            ? [28, () => setLettres(Math.min(lettres + 2, longueur))]
            : [650, () => setPhase('attend')]
          : phase === 'attend'
            ? [1300, () => setPhase('valide')]
            : phase === 'valide'
              ? [1100, () => setPhase('publie')]
              : [2400, () => (setIndice((i) => (i + 1) % VOIX.length), setLettres(0), setPhase('ecrit'))];
    const minuteur = setTimeout(suite[1], suite[0]);
    return () => clearTimeout(minuteur);
  }, [actif, phase, lettres, voix]);

  return (
    <div ref={ref} className={`post-card post-vivant phase-${phase}`}>
      <header>
        <span className={`li-avatar${voix.page ? ' page' : ''}`}>{voix.initiales}</span>
        <span className="who">
          {voix.nom}
          <small>{voix.role}</small>
        </span>
        <span className="badge pv-badge">{BADGE[phase]}</span>
      </header>
      <p className="pv-texte">
        {VOIX.map((v) => (
          <span key={v.nom} className="pv-fantome">
            {v.texte}
          </span>
        ))}
        <span>
          {voix.texte.slice(0, lettres)}
          <i className="pv-curseur" />
        </span>
      </p>
      <div className="card-actions">
        <span className="ok">{phase === 'valide' || phase === 'publie' ? 'Validé ✓' : 'Valider'}</span>
        <span>Corriger</span>
      </div>
      <i className="pv-doigt" />
      <b className="pv-tampon">Publié</b>
      <span className="pv-eclats">
        {ECLATS.map(([x, y, ton]) => (
          <i key={`${x}${y}`} className={`ton-${ton}`} style={{ '--x': `${x}px`, '--y': `${y}px` } as CSSProperties} />
        ))}
      </span>
    </div>
  );
}

const ETAPES = [
  { titre: 'Planning', image: '/marque/etape-planning.svg', texte: 'Vous posez vos temps forts et vos sujets ; l’IA complète avec des idées et votre veille.' },
  { titre: 'Rédaction par l’IA', image: '/marque/etape-redaction.svg', texte: 'Les posts des deux semaines à venir sont rédigés dans le ton de chaque compte, avec leur visuel.' },
  { titre: 'Validation', image: '/marque/etape-validation.svg', texte: 'Chaque titulaire valide, corrige ou refuse.' },
  { titre: 'Publication', image: '/marque/etape-publication.svg', texte: 'Au créneau prévu, sur LinkedIn. Vous suivez ensuite les statistiques et les enseignements du mois.' },
] as const;

const DUREE_ETAPE = 5200;
const CASES = ['a', 'b', '', 'c', 'a', 'b', 'b', '', 'c', 'a', 'c', 'b'];

/** Les quatre étapes : elles se jouent seules, un clic en choisit une et arrête le défilement. */
export function Parcours() {
  const base = useId();
  const [ref, actif] = useEnVue<HTMLDivElement>();
  const [etape, setEtape] = useState(0);
  const [auto, setAuto] = useState(true);
  const [pret, setPret] = useState(false);

  useEffect(() => setPret(true), []);
  useEffect(() => {
    if (!actif || !auto) return;
    const minuteur = setTimeout(() => setEtape((e) => (e + 1) % ETAPES.length), DUREE_ETAPE);
    return () => clearTimeout(minuteur);
  }, [actif, auto, etape]);

  return (
    <div ref={ref} className={`parcours${pret ? ' pret' : ''}${actif && auto ? ' joue' : ''}`} style={{ '--duree': `${DUREE_ETAPE}ms` } as CSSProperties}>
      <ol className="pc-etapes">
        {ETAPES.map((e, i) => (
          <li key={e.titre} className={i === etape ? 'actif' : undefined}>
            <h3>
              <button
                type="button"
                aria-expanded={pret ? i === etape : true}
                aria-controls={`${base}-${i}`}
                onClick={() => {
                  setEtape(i);
                  setAuto(false);
                }}
              >
                <img src={e.image} alt="" width={44} height={44} loading="lazy" />
                <span>
                  {i + 1}. {e.titre}
                </span>
              </button>
            </h3>
            <div className="pc-texte" id={`${base}-${i}`}>
              <p>{e.texte}</p>
            </div>
            <span className="pc-barre" aria-hidden="true" />
          </li>
        ))}
      </ol>
      <div className="pc-scene" aria-hidden="true">
        <div className={`sc sc-planning${etape === 0 ? ' actif' : ''}`}>
          <b>Novembre</b>
          <div className="sc-cases">
            {CASES.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: grille fixe, jamais réordonnée.
              <i key={i} className={c ? `c-${c}` : undefined} style={{ '--i': i } as CSSProperties} />
            ))}
          </div>
        </div>
        <div className={`sc sc-redaction${etape === 1 ? ' actif' : ''}`}>
          <span className="sc-voix">Dans le ton de Claire</span>
          <p>
            <span>Ce que trois ans sur le terrain</span>
            <span>m’ont appris : tout se joue</span>
            <span>avant le premier geste.</span>
          </p>
        </div>
        <div className={`sc sc-validation${etape === 2 ? ' actif' : ''}`}>
          <div className="sc-tel">
            <span className="sc-encoche" />
            <small>Votre post de mardi</small>
            <p>Ce que trois ans sur le terrain m’ont appris…</p>
            <span className="sc-bouton">Valider</span>
            <span className="sc-bouton fait">Validé ✓</span>
            <i className="sc-doigt" />
          </div>
        </div>
        <div className={`sc sc-publication${etape === 3 ? ' actif' : ''}`}>
          <svg viewBox="0 0 64 64" width="64" height="64">
            <path d="M6 30 58 6 44 58 30 38Z" fill="var(--rose)" />
            <path d="M58 6 30 38l-2 16 8-9" fill="var(--rose-fonce)" />
          </svg>
          <strong>En ligne</strong>
          <span>Mardi, 8 h 30</span>
          <div className="sc-reactions">
            <i className="ton-rose" />
            <i className="ton-soleil" />
            <i className="ton-vert" />
          </div>
        </div>
      </div>
    </div>
  );
}

type EtatEssai = 'edition' | 'refus' | 'valide' | 'publie';
const MESSAGES: Record<EtatEssai, string> = {
  edition: '',
  refus: 'Bloqué. Complétez le nombre d’entreprises pour pouvoir valider.',
  valide: 'Validé. Le post partira demain à 12 h.',
  publie: 'Publié.',
};

/** Le garde-fou à essayer soi-même : un marqueur [À COMPLÉTER] bloque la validation. */
export function EssaiValidation() {
  const champ = useId();
  const saisie = useRef<HTMLInputElement>(null);
  const [pret, setPret] = useState(false);
  const [valeur, setValeur] = useState('');
  const [etat, setEtat] = useState<EtatEssai>('edition');
  const [refus, setRefus] = useState(0);

  useEffect(() => setPret(true), []);
  useEffect(() => {
    if (etat !== 'valide') return;
    const minuteur = setTimeout(() => setEtat('publie'), 1400);
    return () => clearTimeout(minuteur);
  }, [etat]);

  const agir = () => {
    if (etat === 'publie') {
      setValeur('');
      setEtat('edition');
      saisie.current?.focus();
    } else if (etat !== 'valide') {
      if (valeur === '') {
        setEtat('refus');
        setRefus((r) => r + 1);
        saisie.current?.focus();
      } else {
        setEtat('valide');
      }
    }
  };

  const fini = etat === 'valide' || etat === 'publie';
  return (
    <figure className={`maquette essai etat-${etat}${refus > 0 ? ` secoue-${refus % 2}` : ''}`} aria-label="Démonstration : valider un post avec une information à compléter">
      <div className="tete">
        <span className="li-avatar">TR</span>
        <span>
          <b>Thomas R.</b>
          <small>Part demain à 12 h</small>
        </span>
        <span className="badge essai-badge">{etat === 'publie' ? 'Publié' : etat === 'valide' ? 'Validé' : 'À valider'}</span>
      </div>
      <div>
        Notre équipe a accompagné {valeur ? <strong className="essai-rempli">{valeur}</strong> : <mark className="marker">[À COMPLÉTER : nombre d’entreprises]</mark>} entreprises cette année. Ce qui
        revient le plus souvent ? La peur de mal faire au premier geste.
      </div>
      <label className="essai-champ" htmlFor={champ}>
        Nombre d’entreprises
        <input
          ref={saisie}
          id={champ}
          inputMode="numeric"
          autoComplete="off"
          maxLength={5}
          placeholder="Par exemple 40"
          value={valeur}
          disabled={!pret || fini}
          onChange={(e) => {
            setValeur(e.target.value.replace(/\D/g, ''));
            if (etat === 'refus') setEtat('edition');
          }}
        />
      </label>
      <div className="essai-actions">
        <button type="button" className={valeur || etat === 'publie' ? 'primary' : 'essai-bloque'} disabled={!pret} aria-disabled={etat === 'valide'} onClick={agir}>
          {etat === 'publie' ? 'Recommencer' : etat === 'valide' ? 'Validé ✓' : 'Valider'}
        </button>
      </div>
      <figcaption role="status">{MESSAGES[etat]}</figcaption>
    </figure>
  );
}
