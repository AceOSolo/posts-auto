/**
 * PLA-10 : journées nationales et mondiales suggérées selon le secteur.
 *
 * Le catalogue ne contient que des journées à date fixe, chaque date ayant été vérifiée le
 * 23 novembre 2026 sur le site de l'organisme qui porte la journée (`source`). Une journée à
 * date variable n'y entre pas : une récurrence annuelle la placerait au mauvais jour.
 */

export type SectorKey = 'sante' | 'prevention' | 'btp-industrie' | 'environnement' | 'formation' | 'numerique' | 'droit-finance' | 'agroalimentaire' | 'rh';

export interface WorldDay {
  readonly id: string;
  readonly title: string;
  readonly month: number;
  readonly day: number;
  readonly scope: 'mondiale' | 'nationale';
  readonly organizer: string;
  readonly source: string;
  /** Secteurs concernés ; vide : toute entreprise. */
  readonly sectors: readonly SectorKey[];
}

export const WORLD_DAYS: readonly WorldDay[] = [
  { id: 'education', title: 'Journée internationale de l’éducation', month: 1, day: 24, scope: 'mondiale', organizer: 'l’Unesco', source: 'https://www.unesco.org/en/days/education', sectors: ['formation'] },
  { id: 'protection-donnees', title: 'Journée de la protection des données', month: 1, day: 28, scope: 'mondiale', organizer: 'le Conseil de l’Europe', source: 'https://www.coe.int/fr/web/data-protection/data-protection-day', sectors: ['numerique', 'droit-finance'] },
  { id: 'droits-femmes', title: 'Journée internationale des droits des femmes', month: 3, day: 8, scope: 'mondiale', organizer: 'l’ONU', source: 'https://www.unwomen.org/en/news-stories/in-focus/2022/03/in-focus-international-womens-day', sectors: [] },
  { id: 'eau', title: 'Journée mondiale de l’eau', month: 3, day: 22, scope: 'mondiale', organizer: 'ONU-Eau', source: 'https://www.unwater.org/our-work/world-water-day', sectors: ['environnement', 'agroalimentaire'] },
  { id: 'sante', title: 'Journée mondiale de la santé', month: 4, day: 7, scope: 'mondiale', organizer: 'l’OMS', source: 'https://www.who.int/campaigns/world-health-day', sectors: ['sante', 'prevention'] },
  { id: 'propriete-intellectuelle', title: 'Journée mondiale de la propriété intellectuelle', month: 4, day: 26, scope: 'mondiale', organizer: 'l’OMPI', source: 'https://www.wipo.int/en/web/ipday', sectors: ['numerique', 'droit-finance'] },
  { id: 'securite-sante-travail', title: 'Journée mondiale de la sécurité et de la santé au travail', month: 4, day: 28, scope: 'mondiale', organizer: 'l’OIT', source: 'https://www.ilo.org/meetings-and-events/world-day-safety-and-health-work', sectors: ['prevention', 'btp-industrie', 'sante', 'rh'] },
  { id: 'environnement', title: 'Journée mondiale de l’environnement', month: 6, day: 5, scope: 'mondiale', organizer: 'le PNUE', source: 'https://www.worldenvironmentday.global/about/history', sectors: ['environnement', 'btp-industrie'] },
  { id: 'pme', title: 'Journée des micro, petites et moyennes entreprises', month: 6, day: 27, scope: 'mondiale', organizer: 'l’ONU', source: 'https://digitallibrary.un.org/record/1288909/files/A_RES_71_279-EN.pdf', sectors: [] },
  { id: 'competences-jeunes', title: 'Journée mondiale des compétences des jeunes', month: 7, day: 15, scope: 'mondiale', organizer: 'l’ONU et l’Unesco', source: 'https://connect.unevoc.unesco.org/home/World+Youth+Skills+Day+at+UNEVOC', sectors: ['formation', 'rh'] },
  { id: 'securite-patients', title: 'Journée mondiale de la sécurité des patients', month: 9, day: 17, scope: 'mondiale', organizer: 'l’OMS', source: 'https://www.who.int/campaigns', sectors: ['sante'] },
  { id: 'enseignants', title: 'Journée mondiale des enseignants', month: 10, day: 5, scope: 'mondiale', organizer: 'l’Unesco', source: 'https://www.unesco.org/en/days/teachers', sectors: ['formation'] },
  { id: 'aidants', title: 'Journée nationale des aidants', month: 10, day: 6, scope: 'nationale', organizer: 'les pouvoirs publics français', source: 'https://www.pour-les-personnes-agees.gouv.fr/actualites/6-octobre-2026-journee-nationale-des-aidants', sectors: ['sante', 'rh'] },
  { id: 'sante-mentale', title: 'Journée mondiale de la santé mentale', month: 10, day: 10, scope: 'mondiale', organizer: 'l’OMS', source: 'https://www.who.int/campaigns', sectors: [] },
  { id: 'risques-catastrophe', title: 'Journée internationale pour la réduction des risques de catastrophe', month: 10, day: 13, scope: 'mondiale', organizer: 'l’UNDRR', source: 'https://iddrr.undrr.org/learn', sectors: ['prevention', 'environnement', 'btp-industrie'] },
  { id: 'alimentation', title: 'Journée mondiale de l’alimentation', month: 10, day: 16, scope: 'mondiale', organizer: 'la FAO', source: 'https://www.fao.org/world-food-day/events/global-events/en', sectors: ['agroalimentaire'] },
  { id: 'sida', title: 'Journée mondiale de lutte contre le sida', month: 12, day: 1, scope: 'mondiale', organizer: 'l’OMS', source: 'https://www.who.int/campaigns', sectors: ['sante'] },
  { id: 'personnes-handicapees', title: 'Journée internationale des personnes handicapées', month: 12, day: 3, scope: 'mondiale', organizer: 'l’ONU', source: 'https://social.desa.un.org/issues/disability/events', sectors: [] },
  { id: 'lutte-corruption', title: 'Journée internationale de lutte contre la corruption', month: 12, day: 9, scope: 'mondiale', organizer: 'l’ONUDC', source: 'https://www.unodc.org/unodc/en/about-unodc/international-days.html', sectors: ['droit-finance'] },
];

const SECTOR_PATTERNS: Readonly<Record<SectorKey, RegExp>> = {
  sante: /\b(sante|medic|hopital|clinique|pharma|soins?\b|ehpad)/,
  prevention: /\b(securite|prevention|qhse\b|hse\b|sst\b|risques?\b|incendie)/,
  'btp-industrie': /\b(btp\b|batiment|construction|travaux|chantier|industri|logistique|transport|manufactur)/,
  environnement: /\b(environnement|energie|eaux?\b|dechet|recyclage|climat|rse\b)/,
  formation: /\b(formation|education|enseignement|ecole|universite|apprentissage)/,
  numerique: /\b(numerique|informatique|logiciel|saas\b|data\b|donnees|cyber|digital|tech\b)/,
  'droit-finance': /\b(juridique|droit|avocat|notaire|comptab|audit\b|financ|banque|assurance)/,
  agroalimentaire: /\b(agroalimentaire|agricult|alimentaire|restauration)/,
  rh: /\b(rh\b|ressources humaines|recrutement|interim|insertion|handicap)/,
};

/** Normalise pour comparer sans tenir compte de la casse ni des accents. */
export function normalizeLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/’/g, "'")
    .toLowerCase()
    .trim();
}

/** Secteurs reconnus dans le secteur d'activité saisi librement par le client. */
export function sectorsOf(sector: string | null): SectorKey[] {
  if (sector === null) return [];
  const text = normalizeLabel(sector);
  return (Object.keys(SECTOR_PATTERNS) as SectorKey[]).filter((key) => SECTOR_PATTERNS[key].test(text));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Prochaine date de la journée, aujourd'hui compris (AAAA-MM-JJ). */
export function nextWorldDayDate(day: Pick<WorldDay, 'month' | 'day'>, today: string): string {
  const year = Number(today.slice(0, 4));
  const thisYear = `${year}-${pad(day.month)}-${pad(day.day)}`;
  return thisYear >= today ? thisYear : `${year + 1}-${pad(day.month)}-${pad(day.day)}`;
}

export interface WorldDaySuggestion extends WorldDay {
  readonly date: string;
  /** La journée vise le secteur du client (sinon : elle concerne toute entreprise). */
  readonly matchesSector: boolean;
}

export interface WorldDayOptions {
  readonly limit?: number;
  readonly horizonDays?: number;
  readonly excludeTitles?: ReadonlySet<string>;
}

/**
 * Journées à venir pour ce secteur, de la plus proche à la plus lointaine : celles du secteur
 * et celles qui concernent toute entreprise. `excludeTitles` : titres normalisés déjà planifiés.
 */
export function upcomingWorldDays(sector: string | null, today: string, options: WorldDayOptions = {}): WorldDaySuggestion[] {
  const { limit = 6, horizonDays = 120, excludeTitles } = options;
  const sectors = sectorsOf(sector);
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + horizonDays * 86_400_000).toISOString().slice(0, 10);
  return WORLD_DAYS.flatMap((day) => {
    const matchesSector = day.sectors.some((key) => sectors.includes(key));
    if (day.sectors.length > 0 && !matchesSector) return [];
    if (excludeTitles?.has(normalizeLabel(day.title))) return [];
    const date = nextWorldDayDate(day, today);
    return date <= horizon ? [{ ...day, date, matchesSector }] : [];
  })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, limit);
}
