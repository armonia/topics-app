/**
 * Who uses the ORBIT edition of the preview (`orbit.html`), and what each of
 * them may see and do. The areas are the ones of the internal questionnaire
 * (29/10, 14 answers): Contabile e Finanziaria, Personale, Customer service and
 * Call center, Tecnica, Flotta, Gare e Legale. The only real person is the one
 * the questionnaire names, Avv. Annarita Bruno, head of the legal office; every
 * other person is a role marked as an example, as in the Nocera edition.
 *
 * The agents are the workers of Topics that prepare and check: they never sign,
 * send or approve for a person.
 */
import type { Permission, Persona, RoleDef } from '../org/people';

/** The id of an area (a team of the work), as the cards, the team page and the filters name it: any organization has its own (`ORBIT_AREA_LABEL` lists ORBIT's). */
export type OrbitArea = string;

export const ORBIT_AREA_LABEL: Record<OrbitArea, string> = {
  contabilita: 'Contabile e Finanziaria', // allow-italian: fixture data, shown as written
  personale: 'Personale', // allow-italian: fixture data, shown as written
  customer: 'Customer service e Call center',
  tecnica: 'Tecnica', // allow-italian: fixture data, shown as written
  flotta: 'Flotta', // allow-italian: fixture data, shown as written
  legale: 'Gare e Legale', // allow-italian: fixture data, shown as written
  direzione: 'Direzione', // allow-italian: fixture data, shown as written
};

/** Every permission the ORBIT edition knows, in the order the team page lists them. */
export const ORBIT_PERMISSIONS: Permission[] = [
  'view:inbox', 'view:flows', 'view:contracts', 'view:data', 'view:knowledge', 'view:programs', 'view:team', 'view:settings',
  'edit:data', 'edit:contracts', 'approve:contracts', 'sign:contracts', 'edit:structure', 'approve', 'run:tests', 'admin', 'export',
];

const WORK: Permission[] = ['view:inbox', 'view:flows', 'view:data', 'view:knowledge', 'view:programs', 'view:team', 'edit:data'];

export const ORBIT_ROLES: RoleDef[] = [
  {
    id: 'orbit-direzione', label: 'Direzione', // allow-italian: fixture data, shown as written
    description: 'Vede tutto, approva e firma i contratti, decide chi può fare cosa.', // allow-italian: fixture data, shown as written
    permissions: ORBIT_PERMISSIONS,
  },
  {
    id: 'orbit-legale', label: 'Gare e Legale', // allow-italian: fixture data, shown as written
    description: 'Scrive e rivede contratti, varianti e gare; approva prima della firma.', // allow-italian: fixture data, shown as written
    permissions: [...WORK, 'view:contracts', 'view:settings', 'edit:contracts', 'approve:contracts', 'approve', 'export'],
  },
  {
    id: 'orbit-contabilita', label: 'Contabile e Finanziaria', // allow-italian: fixture data, shown as written
    description: 'Fatture passive, riconciliazione bancaria, costo per commessa; vede i contratti con i fornitori.', // allow-italian: fixture data, shown as written
    permissions: [...WORK, 'view:contracts', 'export'],
  },
  {
    id: 'orbit-personale', label: 'Personale', // allow-italian: fixture data, shown as written
    description: 'Tempi determinati, presenze, ferie e turni, INPS, INAIL e sindacati.', // allow-italian: fixture data, shown as written
    permissions: [...WORK, 'view:contracts', 'edit:contracts'],
  },
  {
    id: 'orbit-customer', label: 'Customer service e Call center',
    description: 'Segnalazioni AMA e delle utenze, FIR e formulari, rendiconto foglie.', // allow-italian: fixture data, shown as written
    permissions: WORK,
  },
  {
    id: 'orbit-tecnica', label: 'Tecnica', // allow-italian: fixture data, shown as written
    description: 'Programmazione dei servizi, valutazione preliminare delle gare, cantieri.', // allow-italian: fixture data, shown as written
    permissions: [...WORK, 'view:contracts'],
  },
  {
    id: 'orbit-flotta', label: 'Flotta', // allow-italian: fixture data, shown as written
    description: 'Mezzi e fogli targa dai turni.', // allow-italian: fixture data, shown as written
    permissions: WORK,
  },
  {
    id: 'orbit-lettura', label: 'Collegio sindacale', // allow-italian: fixture data, shown as written
    description: 'Vede contratti, dati e documenti; non cambia niente.', // allow-italian: fixture data, shown as written
    permissions: ['view:inbox', 'view:flows', 'view:contracts', 'view:data', 'view:knowledge'],
  },
];

/** A ORBIT person: a persona of the app plus the area of the questionnaire they work in. */
export interface OrbitPersona extends Persona {
  area: OrbitArea;
  /** The short name on a card, next to the avatar. */
  short: string;
}

export const ORBIT_PERSONAS: OrbitPersona[] = [
  { id: 'orbit-dg', name: 'Direttore generale (esempio)', short: 'Direttore gen.', monogram: 'DG', color: '#0f766e', role: 'orbit-direzione', area: 'direzione', orgs: ['orbit'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'orbit-bruno', name: 'Avv. Annarita Bruno', short: 'Avv. Bruno', monogram: 'AB', color: '#7c3aed', role: 'orbit-legale', area: 'legale', orgs: ['orbit'], offices: [], home: '/da-fare', example: false },
  { id: 'orbit-contabilita', name: 'Responsabile contabilità (esempio)', short: 'Resp. contabilità', monogram: 'CO', color: '#1d4ed8', role: 'orbit-contabilita', area: 'contabilita', orgs: ['orbit'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'orbit-personale', name: 'Responsabile del personale (esempio)', short: 'Resp. personale', monogram: 'PE', color: '#be185d', role: 'orbit-personale', area: 'personale', orgs: ['orbit'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'orbit-callcenter', name: 'Operatrice call center (esempio)', short: 'Op. call center', monogram: 'CC', color: '#b45309', role: 'orbit-customer', area: 'customer', orgs: ['orbit'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'orbit-tecnico', name: 'Responsabile tecnico (esempio)', short: 'Resp. tecnico', monogram: 'TE', color: '#15803d', role: 'orbit-tecnica', area: 'tecnica', orgs: ['orbit'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'orbit-flotta', name: 'Responsabile flotta (esempio)', short: 'Resp. flotta', monogram: 'FL', color: '#475569', role: 'orbit-flotta', area: 'flotta', orgs: ['orbit'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'orbit-sindaci', name: 'Collegio sindacale (esempio)', short: 'Sindaco', monogram: 'CS', color: '#64748b', role: 'orbit-lettura', area: 'direzione', orgs: ['orbit'], offices: [], home: '/conoscenza/contratti', example: true }, // allow-italian: fixture data, shown as written
];

/** The id of a team: the areas plus the team of the people who only read, which sits apart. */
export type OrbitTeamId = string;

/** A team: the people who work together and the one who leads them. */
export interface OrbitTeam {
  id: OrbitTeamId;
  label: string;
  /** The persona who leads the team (the people are examples, except Avv. Bruno). */
  lead: string;
  /** What the team does, in one line. */
  does: string;
}

/** The teams in the order of the questionnaire; the six agents are a team of their own (`ORBIT_AGENTS_TEAM`). */
export const ORBIT_TEAMS: OrbitTeam[] = [
  { id: 'direzione', label: 'Direzione', lead: 'orbit-dg', does: 'Vede tutto, approva e firma i contratti, decide chi può fare cosa.' }, // allow-italian: fixture data, shown as written
  { id: 'legale', label: 'Gare e Legale', lead: 'orbit-bruno', does: 'Scrive e rivede contratti, varianti e gare; approva prima della firma.' }, // allow-italian: fixture data, shown as written
  { id: 'contabilita', label: 'Contabile e Finanziaria', lead: 'orbit-contabilita', does: 'Fatture passive, riconciliazione bancaria, costo per commessa.' }, // allow-italian: fixture data, shown as written
  { id: 'personale', label: 'Personale', lead: 'orbit-personale', does: 'Tempi determinati, presenze, ferie e turni, INPS, INAIL e sindacati.' }, // allow-italian: fixture data, shown as written
  { id: 'customer', label: 'Customer service e Call center', lead: 'orbit-callcenter', does: 'Segnalazioni AMA e delle utenze, FIR e formulari, rendiconto foglie.' }, // allow-italian: fixture data, shown as written
  { id: 'tecnica', label: 'Tecnica', lead: 'orbit-tecnico', does: 'Programmazione dei servizi, valutazione preliminare delle gare, cantieri.' }, // allow-italian: fixture data, shown as written
  { id: 'flotta', label: 'Flotta', lead: 'orbit-flotta', does: 'Mezzi e fogli targa dai turni.' }, // allow-italian: fixture data, shown as written
  { id: 'sindaci', label: 'Collegio sindacale', lead: 'orbit-sindaci', does: 'Vede contratti, dati e documenti; non cambia niente.' }, // allow-italian: fixture data, shown as written
];

/** The team the six agents of Topics form: no leader, no permissions to give. */
export const ORBIT_AGENTS_TEAM = { id: 'agenti', label: 'Agenti' } as const; // allow-italian: fixture data, shown as written

export const ORBIT_DEFAULT_PERSONA = 'orbit-dg';

/** A worker of Topics on a card: what it is called and what it does in plain words. */
export interface OrbitAgent {
  id: string;
  name: string;
  /** The one line the team page shows: what it prepares, never what it decides. */
  does: string;
  area: OrbitArea;
}

export const ORBIT_AGENTS: OrbitAgent[] = [
  { id: 'ag-segnalazioni', name: 'Agente segnalazioni', does: 'legge mail AMA, portale e telefonate, propone turno e mezzo', area: 'customer' }, // allow-italian: fixture data, shown as written
  { id: 'ag-fir', name: 'Agente FIR e RENTRI', does: 'prepara il formulario e la registrazione, controlla pesi e codici', area: 'customer' }, // allow-italian: fixture data, shown as written
  { id: 'ag-fatture', name: 'Agente fatture', does: 'abbina fattura, ordine e movimento in banca', area: 'contabilita' }, // allow-italian: fixture data, shown as written
  { id: 'ag-gare', name: 'Agente gare', does: 'legge bando e disciplinare, prepara la scheda di valutazione', area: 'legale' }, // allow-italian: fixture data, shown as written
  { id: 'ag-personale', name: 'Agente turni e scadenze', does: 'incrocia turni, presenze e contratti a termine', area: 'personale' }, // allow-italian: fixture data, shown as written
  { id: 'ag-contratti', name: 'Agente contratti', does: 'confronta le versioni, estrae obblighi e scadenze dalle clausole', area: 'legale' }, // allow-italian: fixture data, shown as written
];
