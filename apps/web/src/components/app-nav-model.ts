/**
 * Le menu de l'application : cinq rubriques, et tout le reste rangé dessous en onglets.
 * Aucune dépendance à React : la correspondance entre une adresse et sa rubrique se lit ici.
 */

export type SectionId = 'valider' | 'creer' | 'equipe' | 'parametres' | 'compte';

export interface NavTab {
  readonly label: string;
  readonly href: string;
  /** Vrai si l'adresse (découpée en segments) appartient à cet onglet. */
  readonly matches: (segments: readonly string[]) => boolean;
}

export interface NavSection {
  readonly id: SectionId;
  readonly label: string;
  readonly href: string;
  readonly tabs: readonly NavTab[];
}

export interface NavContext {
  /** Espace en cours ; null pour une personne qui n'en a aucun. */
  readonly workspaceId: string | null;
  /** Organisations dont la personne est propriétaire (page Clients ou Espaces). */
  readonly owned: readonly { readonly label: string; readonly workspaceId: string }[];
  readonly platformAdmin: boolean;
}

/** Un rappel non urgent, rangé dans « À faire » plutôt qu'en bandeau. */
export interface Reminder {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly href: string | null;
  readonly cta: string | null;
}

export const segmentsOf = (pathname: string): string[] => pathname.split('/').filter((part) => part !== '');

const under =
  (...roots: string[]) =>
  (segments: readonly string[]) =>
    roots.includes(segments[0] ?? '');

const isIntegrations = (segments: readonly string[]) => segments[0] === 'espace' && segments[2] === 'integrations';

/** Événements et banque de sujets : des sources d'idées, même si leur adresse est sous le planning. */
const isIdeaSource = (segments: readonly string[]) => segments[0] === 'planning' && (segments[2] === 'banque' || segments[2] === 'evenements');

/** La rédaction automatique se règle dans Paramètres, même si son adresse est sous le planning. */
const isDrafting = (segments: readonly string[]) => segments[0] === 'planning' && segments[2] === 'redactions';

/** Les rubriques ; celles qui dépendent d'un espace disparaissent quand il n'y en a pas. */
export function buildSections({ workspaceId, owned, platformAdmin }: NavContext): NavSection[] {
  const valider: NavSection = {
    id: 'valider',
    label: 'Valider',
    href: '/',
    tabs: [{ label: 'Mes posts', href: '/', matches: (s) => s.length === 0 || s[0] === 'posts' }],
  };
  const compte: NavSection = {
    id: 'compte',
    label: 'Mon compte',
    href: '/moi',
    tabs: [
      { label: 'Données et sécurité', href: '/moi', matches: under('moi') },
      { label: 'Notifications', href: '/notifications', matches: under('notifications') },
      ...(platformAdmin ? [{ label: 'Back-office', href: '/admin', matches: under('admin') }] : []),
    ],
  };
  if (workspaceId === null) return [valider, compte];

  const id = workspaceId;
  return [
    valider,
    {
      id: 'creer',
      label: 'Créer',
      href: `/planning/${id}`,
      tabs: [
        { label: 'Planning', href: `/planning/${id}`, matches: (s) => s[0] === 'planning' && !isIdeaSource(s) && !isDrafting(s) },
        { label: 'Idées', href: `/idees/${id}`, matches: (s) => s[0] === 'idees' || s[0] === 'demandes' || isIdeaSource(s) },
        { label: 'Visuels', href: `/visuels/${id}`, matches: under('visuels') },
      ],
    },
    {
      id: 'equipe',
      label: 'Équipe',
      href: `/espace/${id}`,
      tabs: [
        { label: 'Membres', href: `/espace/${id}`, matches: (s) => s[0] === 'espace' && !isIntegrations(s) },
        { label: 'Comptes LinkedIn', href: `/comptes/${id}`, matches: under('comptes') },
        { label: 'Vue équipe', href: `/equipe/${id}`, matches: under('equipe') },
        { label: 'Tableau de bord', href: `/tableau/${id}`, matches: under('tableau') },
      ],
    },
    {
      id: 'parametres',
      label: 'Paramètres',
      href: `/ligne/${id}`,
      tabs: [
        { label: 'Ligne éditoriale', href: `/ligne/${id}`, matches: under('ligne') },
        { label: 'Rédaction', href: `/planning/${id}/redactions`, matches: isDrafting },
        { label: 'Abonnement', href: `/abonnement/${id}`, matches: under('abonnement') },
        { label: 'Intégrations et support', href: `/espace/${id}/integrations`, matches: isIntegrations },
        { label: 'Démarrage', href: `/demarrage/${id}`, matches: under('demarrage') },
        ...owned.map((org) => ({ label: org.label, href: `/espaces/${org.workspaceId}`, matches: (s: readonly string[]) => s[0] === 'espaces' && s[1] === org.workspaceId })),
      ],
    },
    compte,
  ];
}

/** La rubrique et l'onglet de l'adresse courante. */
export function locate(sections: readonly NavSection[], pathname: string): { section: NavSection | null; tab: NavTab | null } {
  const segments = segmentsOf(pathname);
  for (const section of sections) {
    const tab = section.tabs.find((candidate) => candidate.matches(segments));
    if (tab !== undefined) return { section, tab };
  }
  return { section: null, tab: null };
}

/** L'espace désigné par l'adresse, s'il fait partie de ceux de la personne. */
export function workspaceInPath(pathname: string, workspaceIds: readonly string[]): string | null {
  const candidate = segmentsOf(pathname)[1];
  return candidate !== undefined && workspaceIds.includes(candidate) ? candidate : null;
}
