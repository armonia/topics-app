/**
 * Example data of the Settings pages. Facts about the Consorzio come from
 * `DATI-VERI.md` and say where they come from; everything else (sessions,
 * keys, estimates of speed, the state of each standard) is an example or a
 * declared estimate, and the pages say so. Words of the product are in
 * `copy/settings.ts`: here only ids, numbers and sector or customer words.
 */
import type {
  DeployId, FunctionId, FunctionStatus, OrgFactId, PrincipleId, ProtectionId, ProtectionState, RegionId, SectorId,
  StandardGroup, StandardId, StandardStatus, StartupStepId, TermId, ComplianceScope,
} from '../settings/model';
import type { Office } from './org/types';
import { DEMO_TODAY, addDays } from './org/clock';
import { FLOWS } from './org/flows';

/* ---------- general (set-general) ---------- */

export const ORG_IDENTITY = {
  fullName: 'Consorzio di Bonifica Integrale Comprensorio Sarno', // allow-italian: fixture data, shown as written
  shortName: 'Consorzio di Nocera', // allow-italian: fixture data, shown as written
  legalForm: 'ente pubblico economico a carattere associativo', // allow-italian: fixture data, shown as written
  legalSource: 'L.R. Campania 7 del 6/6/2025, art. 9 c.3', // allow-italian: fixture data, shown as written
  seat: 'Nocera Inferiore', // allow-italian: fixture data, shown as written
  factsSource: "Libro dell'anno 2025 del consorzio", // allow-italian: fixture data, shown as written
  timeZone: 'Europe/Rome',
  language: 'it',
} as const;

/** The facts of the Consorzio, each with its source; the label of each is in the copy. */
export const ORG_FACTS: Array<{ id: OrgFactId; value: string }> = [
  { id: 'founded', value: 'DPR 1/12/1952' },
  { id: 'area', value: '43.054 ha' },
  { id: 'network', value: '680 km' },
  { id: 'basins', value: 'Sarno, Torrenti Vesuviani, Irno' },
  { id: 'ponds', value: '24' },
  { id: 'irrigation', value: '7 · 1.697 ha / 10.131 ha' },
  { id: 'staff', value: '129 (3 + 30 + 96)' },
];

export const TIME_ZONES = ['Europe/Rome', 'Europe/London', 'Europe/Berlin', 'UTC'] as const;
export const NOTIFICATION_KEYS = ['deadlines', 'failures', 'digest', 'jobs'] as const;
export type NotificationKey = (typeof NOTIFICATION_KEYS)[number];

/* ---------- product (g01) ---------- */

/**
 * Share of fixed steps (rules, programs, views, sends, robots) over every step
 * of every active flow: the same count the «how fixed is the flow» block does
 * for one flow, so the two screens cannot drift apart.
 */
const FIXED_STEP_SHARE = (() => {
  const steps = FLOWS.filter((f) => f.status === 'attivo').flatMap((f) => f.steps); // allow-italian: state identifier, not shown
  const fixed = steps.filter((s) => s.kind !== 'ai' && s.kind !== 'classify' && s.kind !== 'person').length;
  return `${Math.round((fixed / Math.max(1, steps.length)) * 100)}%`;
})();

/** The ten promises. `measure` is what the product is measured by: a goal, an estimate or an example. */
export const PRINCIPLES: Array<{ id: PrincipleId; kind: 'goal' | 'estimate' | 'example'; value: string }> = [
  { id: 'anonymization', kind: 'goal', value: '0' },
  { id: 'speed', kind: 'goal', value: '0,6 s' },
  { id: 'security', kind: 'goal', value: '0' },
  { id: 'determinism', kind: 'estimate', value: FIXED_STEP_SHARE },
  { id: 'context', kind: 'estimate', value: '0,4%' },
  { id: 'memory', kind: 'example', value: '64%' },
  { id: 'person', kind: 'goal', value: '0' },
  { id: 'anywhere', kind: 'goal', value: 'Windows 10, 4 GB' },
  { id: 'tracked', kind: 'goal', value: '0' },
  { id: 'team', kind: 'example', value: '31' },
];

export const FUNCTIONS: Array<{ id: FunctionId; status: FunctionStatus }> = [
  { id: 'flows', status: 'testing' },
  { id: 'data', status: 'testing' },
  { id: 'knowledge', status: 'testing' },
  { id: 'views', status: 'next' },
  { id: 'channels', status: 'next' },
  { id: 'programs', status: 'active' },
  { id: 'anonymization', status: 'testing' },
  { id: 'agents', status: 'testing' },
  { id: 'testing', status: 'testing' },
  { id: 'team', status: 'active' },
  { id: 'log', status: 'active' },
];

/* ---------- sector package (k01) ---------- */

export const TERM_IDS: TermId[] = ['case', 'party', 'incoming', 'registration', 'folder', 'charges', 'office'];

export interface SectorPackage {
  id: SectorId;
  /** The name of the package, as a sector word. */
  name: string;
  /** The organization that runs it, when there is one. */
  org?: string;
  example?: boolean;
  /** The word that stands for each generic term. */
  vocabulary: Record<TermId, string>;
  /** The kinds of incoming item the package teaches the AI to recognise; `perMonth` is an estimate. */
  caseTypes: Array<{ id: string; label: string; perMonth?: number }>;
  /** Flow templates it brings; `flow` is the id of the flow made from it, when it exists. */
  templates: Array<{ id: string; label: string; flow?: string }>;
  connections: string[];
  norms: Array<{ label: string; item?: string }>;
  standards: string[];
}

export const SECTOR_PACKAGES: SectorPackage[] = [
  {
    id: 'bonifica',
    name: 'Consorzio di bonifica', // allow-italian: fixture data, shown as written
    org: 'Consorzio di Nocera', // allow-italian: fixture data, shown as written
    vocabulary: {
      case: 'pratica', party: 'contribuente', incoming: 'PEC', registration: 'protocollo', folder: 'fascicolo', charges: 'ruolo', office: 'ufficio', // allow-italian: fixture data, shown as written
    },
    caseTypes: [
      { id: 'A', label: 'Ricorso o atto giudiziario', perMonth: 6 }, // allow-italian: fixture data, shown as written
      { id: 'B', label: 'Istanza del contribuente (rimborso, rateizzazione, sgravio)', perMonth: 210 }, // allow-italian: fixture data, shown as written
      { id: 'C', label: 'Comunicazione da un ente (Regione, Comuni, ANAC, INPS)', perMonth: 380 }, // allow-italian: fixture data, shown as written
      { id: 'D', label: 'Richiesta irrigua o segnalazione dal territorio', perMonth: 140 }, // allow-italian: fixture data, shown as written
      { id: 'E', label: 'Fattura o nota di credito fuori SdI', perMonth: 31 }, // allow-italian: fixture data, shown as written
      { id: 'F', label: 'Accesso agli atti', perMonth: 12 }, // allow-italian: fixture data, shown as written
      { id: 'G', label: 'Non pertinente (newsletter, pubblicità)', perMonth: 425 }, // allow-italian: fixture data, shown as written
    ],
    templates: [
      { id: 'pec', label: 'PEC in arrivo → protocollo', flow: 'pec' }, // allow-italian: fixture data, shown as written
      { id: 'fatture', label: 'Fattura passiva → pagamento', flow: 'fatture' }, // allow-italian: fixture data, shown as written
      { id: 'irrigua', label: 'Richiesta irrigua → turno', flow: 'irrigua' }, // allow-italian: fixture data, shown as written
      { id: 'segnalazioni', label: 'Segnalazione dal territorio → intervento', flow: 'segnalazioni' }, // allow-italian: fixture data, shown as written
      { id: 'concessioni', label: 'Concessione o autorizzazione idraulica', flow: 'concessioni' }, // allow-italian: fixture data, shown as written
      { id: 'accesso', label: 'Accesso agli atti', flow: 'accesso' }, // allow-italian: fixture data, shown as written
    ],
    connections: ['Halley (robot)', 'Prunes (database in lettura)', 'TeamSystem (agente sul PC)'], // allow-italian: fixture data, shown as written
    norms: [{ label: 'R.D. 368/1904' }, { label: 'L.R. 7/2025', item: 'lr-7-2025' }],
    standards: ['AgID', 'GDPR', 'NIS2'],
  },
  {
    id: 'ambiente',
    name: 'Servizi ambientali', // allow-italian: fixture data, shown as written
    org: 'ORBIT',
    vocabulary: {
      case: 'segnalazione', party: 'utenza', incoming: 'mail, portale, telefonata', registration: 'ordine SAP, FIR', folder: 'fascicolo', charges: 'rendicontazione', office: 'area', // allow-italian: fixture data, shown as written
    },
    caseTypes: [
      { id: 'A', label: 'Segnalazione AMA' }, // allow-italian: fixture data, shown as written
      { id: 'B', label: 'Segnalazione di un utente privato' }, // allow-italian: fixture data, shown as written
      { id: 'C', label: 'FIR e RENTRI' },
      { id: 'D', label: 'Rendicontazione del servizio foglie' }, // allow-italian: fixture data, shown as written
      { id: 'E', label: 'Fattura passiva' }, // allow-italian: fixture data, shown as written
    ],
    templates: [
      { id: 'segnalazioni', label: 'Segnalazioni AMA e utenze → intervento', flow: 'orbit-segnalazioni' }, // allow-italian: fixture data, shown as written
      { id: 'fatture', label: 'Fattura passiva → riconciliazione', flow: 'orbit-fatture' }, // allow-italian: fixture data, shown as written
      { id: 'fir', label: 'FIR e RENTRI' },
      { id: 'foglie', label: 'Rendicontazione del servizio foglie' }, // allow-italian: fixture data, shown as written
      { id: 'turni', label: 'Turni e scadenze dei tempi determinati' }, // allow-italian: fixture data, shown as written
      { id: 'gare', label: 'Valutazione preliminare delle gare' }, // allow-italian: fixture data, shown as written
    ],
    connections: ['SAP', 'Enviro', 'RENTRI'],
    norms: [{ label: 'D.Lgs. 152/2006' }, { label: 'RENTRI' }],
    standards: ['ISO 9001', 'ISO 14001', 'ISO 45001'],
  },
  {
    id: 'impianti',
    name: 'Impiantistica', // allow-italian: fixture data, shown as written
    org: 'Alfa Impianti',
    example: true,
    vocabulary: {
      case: 'intervento', party: 'cliente', incoming: 'mail, modulo, telefonata', registration: 'rapportino', folder: 'commessa', charges: 'preventivo', office: 'reparto', // allow-italian: fixture data, shown as written
    },
    caseTypes: [
      { id: 'A', label: 'Installazione' }, // allow-italian: fixture data, shown as written
      { id: 'B', label: 'Manutenzione programmata' }, // allow-italian: fixture data, shown as written
      { id: 'C', label: 'Guasto' }, // allow-italian: fixture data, shown as written
      { id: 'D', label: 'Collaudo' }, // allow-italian: fixture data, shown as written
    ],
    templates: [
      { id: 'richiesta', label: 'Richiesta di intervento' }, // allow-italian: fixture data, shown as written
      { id: 'rapportino', label: 'Rapportino a fine lavoro' }, // allow-italian: fixture data, shown as written
      { id: 'preventivo', label: 'Preventivo' },
      { id: 'scadenza', label: 'Scadenza di manutenzione' }, // allow-italian: fixture data, shown as written
    ],
    connections: ['Gestionale interventi'], // allow-italian: fixture data, shown as written
    norms: [{ label: 'D.M. 37/2008' }],
    standards: ['ISO 9001'],
  },
  {
    id: 'generico',
    name: 'Qualsiasi azienda', // allow-italian: fixture data, shown as written
    vocabulary: {
      case: 'richiesta', party: 'cliente', incoming: 'mail', registration: 'numero interno', folder: 'cartella', charges: 'elenco', office: 'ufficio', // allow-italian: fixture data, shown as written
    },
    caseTypes: [],
    templates: [
      { id: 'richiesta', label: 'Richiesta in arrivo' }, // allow-italian: fixture data, shown as written
      { id: 'fattura', label: 'Fattura passiva' }, // allow-italian: fixture data, shown as written
      { id: 'scadenza', label: 'Scadenza da ricordare' }, // allow-italian: fixture data, shown as written
    ],
    connections: [],
    norms: [],
    standards: ['GDPR'],
  },
];

/* ---------- start-up (o01) ---------- */

/**
 * The start-up of an organization: eight weeks from `startDay` (a Monday). The
 * week of today is derived from the demo clock. Counts are the ones the
 * Principles page and the team page print too: 31 people, 142 activities, 91
 * written as procedure (64%).
 */
export const STARTUP = {
  startDay: addDays(DEMO_TODAY, -32),
  totalWeeks: 8,
  people: 31,
  interviewed: 19,
  activities: 142,
  documented: 91,
  /** Activities the AI finds in one more interview (an estimate). */
  perInterview: 6,
} as const;

export interface StartupStepSeed {
  id: StartupStepId;
  /** First and last week of the plan; `upkeep` has none. */
  weeks?: [number, number];
  /** Set for a step already done when the demo starts. */
  doneOn?: string;
  tasks: Array<{ id: string; done: boolean }>;
}

export const STARTUP_STEPS: StartupStepSeed[] = [
  {
    id: 'connect', weeks: [1, 1], doneOn: addDays(DEMO_TODAY, -28),
    tasks: [{ id: 'pec', done: true }, { id: 'm365', done: true }, { id: 'prunes', done: true }, { id: 'halley', done: true }, { id: 'agent', done: true }],
  },
  {
    id: 'documents', weeks: [1, 2], doneOn: addDays(DEMO_TODAY, -21),
    tasks: [{ id: 'statute', done: true }, { id: 'regulations', done: true }, { id: 'classification', done: true }, { id: 'resolutions', done: true }, { id: 'index', done: true }],
  },
  {
    id: 'mapping', weeks: [2, 5],
    tasks: [{ id: 'calendar', done: true }, { id: 'consent', done: true }, { id: 'observe', done: true }, { id: 'group', done: false }, { id: 'programs', done: false }],
  },
  { id: 'procedures', weeks: [6, 7], tasks: [{ id: 'draft', done: false }, { id: 'review', done: false }, { id: 'approve', done: false }] },
  // The PEC flow is already in trial (day 4 of 7), so choosing the first flows is done.
  { id: 'trial', weeks: [4, 6], tasks: [{ id: 'pick', done: true }, { id: 'shadow', done: false }, { id: 'compare', done: false }] },
  { id: 'launch', weeks: [7, 8], tasks: [{ id: 'protocol', done: false }, { id: 'accounting', done: false }, { id: 'training', done: false }] },
  { id: 'upkeep', tasks: [{ id: 'monthly', done: false }, { id: 'roles', done: false }, { id: 'new', done: false }] },
];

/** The interviews still to do, in the order they are scheduled. The first five are in the calendar at the start. */
export const INTERVIEW_POOL: Array<{ id: string; office: Office; day: string; time: string }> = [
  { id: 'catasto', office: 'catasto', day: DEMO_TODAY, time: '14:00' },
  { id: 'tecnico', office: 'tecnico', day: DEMO_TODAY, time: '15:00' },
  { id: 'protocollo', office: 'protocollo', day: addDays(DEMO_TODAY, 3), time: '10:00' },
  { id: 'ragioneria', office: 'ragioneria', day: addDays(DEMO_TODAY, 3), time: '15:00' },
  { id: 'irrigazione', office: 'irrigazione', day: addDays(DEMO_TODAY, 4), time: '10:00' },
  { id: 'segreteria', office: 'segreteria', day: addDays(DEMO_TODAY, 5), time: '11:00' },
  { id: 'manutenzione', office: 'manutenzione', day: addDays(DEMO_TODAY, 6), time: '09:30' },
  { id: 'amministrazione', office: 'amministrazione', day: addDays(DEMO_TODAY, 7), time: '10:30' },
];
export const INTERVIEWS_SCHEDULED_AT_START = 5;

/* ---------- security and speed (g04) ---------- */

export const SESSIONS: Array<{ id: string; device: string; place: string; minutesAgo: number; current?: boolean }> = [
  { id: 'mac', device: 'Mac · Safari', place: 'Nocera Inferiore', minutesAgo: 0, current: true }, // allow-italian: fixture data, shown as written
  { id: 'pc', device: 'PC Windows 10 · Edge', place: 'Nocera Inferiore', minutesAgo: 42 }, // allow-italian: fixture data, shown as written
  { id: 'phone', device: 'iPhone · app Topics', place: 'Salerno', minutesAgo: 190 }, // allow-italian: fixture data, shown as written
];

export const PASSKEYS: Array<{ id: string; name: string; createdOn: string }> = [
  { id: 'pk-mac', name: 'MacBook (Touch ID)', createdOn: addDays(DEMO_TODAY, -41) },
  { id: 'pk-usb', name: 'Chiave di sicurezza USB', createdOn: addDays(DEMO_TODAY, -12) }, // allow-italian: fixture data, shown as written
];

/** Network ranges of the example. `192.0.2.0/24` and `198.51.100.0/28` are reserved for documentation (RFC 5737). */
export const IP_RANGES: Array<{ id: string; cidr: string; note: string }> = [
  { id: 'ip-seat', cidr: '192.0.2.0/24', note: 'Sede di Nocera Inferiore (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'ip-vpn', cidr: '198.51.100.0/28', note: 'Accesso da remoto (esempio)' }, // allow-italian: fixture data, shown as written
];

export const CONNECTORS = ['QGIS', 'Microsoft 365', 'Prunes (sola lettura)', 'Archivio PEC']; // allow-italian: fixture data, shown as written
export const ROBOTS: Array<{ id: string; name: string }> = [
  { id: 'halley', name: 'Halley' },
  { id: 'prunes', name: 'Prunes' },
  { id: 'teamsystem', name: 'TeamSystem' },
];

export const REGIONS: RegionId[] = ['it-mi', 'it-rm', 'eu-fra', 'eu-par'];

/** Speed of the steps of the PEC flow, seconds. Declared estimates from the test runs, not measures of a live system. */
export const STEP_SPEED: Array<{ id: string; label: string; median: number; p95: number; limit: number }> = [
  { id: 'prepare', label: 'Prepara gli allegati', median: 2.1, p95: 6.8, limit: 10 }, // allow-italian: fixture data, shown as written
  { id: 'classify', label: 'Riconosce il tipo (AI)', median: 4.0, p95: 9.1, limit: 15 }, // allow-italian: fixture data, shown as written
  { id: 'prunes', label: 'Cerca in Prunes', median: 0.3, p95: 0.9, limit: 2 }, // allow-italian: fixture data, shown as written
  { id: 'halley', label: 'Protocollo in Halley (robot)', median: 31, p95: 52, limit: 90 }, // allow-italian: fixture data, shown as written
  { id: 'open', label: 'Apertura «Da fare»', median: 0.3, p95: 0.6, limit: 1 }, // allow-italian: fixture data, shown as written
];

export const SECURITY_START = {
  lastCheckAt: `${DEMO_TODAY}T03:00:00+01:00`,
  lastBackupAt: `${DEMO_TODAY}T03:00:00+01:00`,
  // Renewed in the summer: Halley changed the password on 05/11 and the robot still has the old one (the stopped run, n11).
  robotRenewedAt: '2026-08-05T10:00:00+02:00',
  region: 'it-mi' as RegionId,
  backupRegion: 'it-rm' as RegionId,
  backupKeepDays: 35,
};

/* ---------- where it runs (s06) ---------- */

export const DEPLOYMENTS: DeployId[] = ['cloud', 'ente', 'pc', 'isolated'];

export const PROTECTIONS: Array<{ id: ProtectionId; state: ProtectionState }> = [
  { id: 'access', state: 'on' },
  { id: 'zerotrust', state: 'on' },
  { id: 'keys', state: 'to-enable' },
  { id: 'separation', state: 'on' },
  { id: 'confidential', state: 'to-evaluate' },
  { id: 'log', state: 'on' },
  { id: 'pentest', state: 'planned' },
  { id: 'releases', state: 'partial' },
];

/* ---------- anonymization (g02) ---------- */

/** The text of the example, written the way a case reads: names, codes and amounts are invented. */
export const ANON_SAMPLE =
  "Ricorso dell'Azienda Agricola Esempio di Mario Rossi, C.F. RSSMRA85T10A562S, residente in via Esempio 1, Sarno, tel. 081 1234567, contro l'avviso 2025 di 1.248 €, foglio 12 particella 345. Rimborso su IBAN IT60 X054 2811 1010 0000 0123 456. Difeso dall'avv. Anna Esposito."; // allow-italian: fixture data, shown as written

/** A reply of the AI to the sample; `{PERSONA}` stands for the person it was given. */
export const ANON_REPLY = 'Il ricorrente {PERSONA} contesta il beneficio e chiede il rimborso su {IBAN}.'; // allow-italian: fixture data, shown as written

/** What the recognisers find in a month of work, an estimate (base: 1.204 PEC and their attachments). */
export const ANON_MONTHLY: Record<'fiscal-code' | 'vat-iban' | 'names' | 'contacts', number> = {
  'fiscal-code': 2904,
  'vat-iban': 1118,
  names: 6420,
  contacts: 3377,
};
export const ANON_OVERHEAD_MS = 90;

/* ---------- compliance (q03) ---------- */

export interface StandardSeed {
  id: StandardId;
  /** The name of the standard or the law, as it is cited. */
  name: string;
  group: StandardGroup;
  scopes: ComplianceScope[];
  status: StandardStatus;
  /** Days before today of the last check; the nightly ones are 1. */
  checkedDaysAgo: number;
  /** Where the proof lives in the app, when it lives there. */
  proofPath?: 'quality' | 'log' | 'versions' | 'security' | 'anonymization' | 'hosting';
  /** What a «Verifica ora» run finds: it passes, or stops at a named control. (allow-italian: quotes the Italian interface) */
  verify: 'pass' | 'fail' | 'external';
}

export const STANDARDS: StandardSeed[] = [
  { id: 'agid-docs', name: 'Linee guida AgID sui documenti informatici', group: 'documents', scopes: ['nocera'], status: 'covered', checkedDaysAgo: 1, verify: 'pass', proofPath: 'quality' }, // allow-italian: fixture data, shown as written
  { id: 'cad', name: 'CAD, D.Lgs. 82/2005', group: 'documents', scopes: ['nocera'], status: 'covered', checkedDaysAgo: 1, verify: 'pass', proofPath: 'log' },
  { id: 'agid-seg', name: 'Allegato 6 AgID, segnatura di protocollo', group: 'documents', scopes: ['nocera'], status: 'covered', checkedDaysAgo: 1, verify: 'pass' }, // allow-italian: fixture data, shown as written
  { id: 'preservation', name: 'Conservazione a norma (ISO 14721 OAIS)', group: 'documents', scopes: ['nocera'], status: 'by-others', checkedDaysAgo: 7, verify: 'external' }, // allow-italian: fixture data, shown as written
  { id: 'gdpr', name: 'GDPR', group: 'personal', scopes: ['nocera', 'orbit', 'topics'], status: 'in-progress', checkedDaysAgo: 3, verify: 'fail', proofPath: 'anonymization' },
  { id: 'iso27001', name: 'ISO/IEC 27001', group: 'personal', scopes: ['nocera', 'orbit', 'topics'], status: 'to-certify', checkedDaysAgo: 14, verify: 'external', proofPath: 'security' },
  { id: 'acn', name: 'Qualificazione cloud ACN', group: 'personal', scopes: ['nocera', 'topics'], status: 'to-request', checkedDaysAgo: 14, verify: 'external', proofPath: 'hosting' }, // allow-italian: fixture data, shown as written
  { id: 'nis2', name: 'NIS2', group: 'personal', scopes: ['nocera', 'orbit', 'topics'], status: 'to-verify', checkedDaysAgo: 21, verify: 'external' },
  { id: 'iso25012', name: 'ISO/IEC 25012', group: 'data', scopes: ['nocera', 'orbit', 'topics'], status: 'covered', checkedDaysAgo: 1, verify: 'pass', proofPath: 'quality' },
  { id: 'iso8000', name: 'ISO 8000', group: 'data', scopes: ['nocera', 'orbit', 'topics'], status: 'partial', checkedDaysAgo: 5, verify: 'fail', proofPath: 'quality' },
  { id: 'aiact', name: 'AI Act', group: 'data', scopes: ['nocera', 'orbit', 'topics'], status: 'covered', checkedDaysAgo: 2, verify: 'pass', proofPath: 'log' },
  { id: 'iso42001', name: 'ISO/IEC 42001', group: 'data', scopes: ['nocera', 'orbit', 'topics'], status: 'to-certify', checkedDaysAgo: 14, verify: 'external', proofPath: 'versions' },
  { id: 'wcag', name: 'Accessibilità AgID (WCAG 2.1 AA)', group: 'data', scopes: ['nocera', 'orbit', 'topics'], status: 'partial', checkedDaysAgo: 2, verify: 'fail' }, // allow-italian: fixture data, shown as written
  { id: 'rentri', name: 'D.Lgs. 152/2006 e RENTRI', group: 'sector', scopes: ['orbit'], status: 'to-verify', checkedDaysAgo: 21, verify: 'external' },
  { id: 'iso9001', name: 'ISO 9001', group: 'sector', scopes: ['orbit'], status: 'to-verify', checkedDaysAgo: 21, verify: 'external' },
  { id: 'iso14001', name: 'ISO 14001', group: 'sector', scopes: ['orbit'], status: 'to-verify', checkedDaysAgo: 21, verify: 'external' },
  { id: 'iso45001', name: 'ISO 45001', group: 'sector', scopes: ['orbit'], status: 'to-verify', checkedDaysAgo: 21, verify: 'external' },
];

/** The words of each step of the start-up of the Consorzio: customer and program names, so they are data. */
export const STARTUP_TEXT: Record<StartupStepId, { title: string; text: string; tasks: Record<string, string> }> = {
  connect: {
    title: 'Collegamenti', // allow-italian: fixture data, shown as written
    text: 'PEC, Microsoft 365, Prunes in lettura, Halley con il robot, agente sul PC della ragioneria', // allow-italian: fixture data, shown as written
    tasks: {
      pec: 'Casella PEC collegata', // allow-italian: fixture data, shown as written
      m365: 'Microsoft 365 collegato', // allow-italian: fixture data, shown as written
      prunes: 'Prunes in lettura', // allow-italian: fixture data, shown as written
      halley: 'Robot di Halley provato', // allow-italian: fixture data, shown as written
      agent: 'Agente sul PC della ragioneria', // allow-italian: fixture data, shown as written
    },
  },
  documents: {
    title: "Documenti dell'organizzazione", // allow-italian: fixture data, shown as written
    text: "statuto, regolamenti, piano di classifica, le delibere pubblicate all'albo, titolario", // allow-italian: fixture data, shown as written
    tasks: {
      statute: 'Statuto caricato', // allow-italian: fixture data, shown as written
      regulations: 'Regolamenti caricati', // allow-italian: fixture data, shown as written
      classification: 'Piano di classifica caricato', // allow-italian: fixture data, shown as written
      resolutions: "Delibere dell'albo caricate", // allow-italian: fixture data, shown as written
      index: 'Titolario caricato', // allow-italian: fixture data, shown as written
    },
  },
  mapping: {
    title: 'Mappatura del lavoro', // allow-italian: fixture data, shown as written
    text: "intervista di 20 minuti a ogni persona · 2 settimane di osservazione di PEC e board · l'AI ricava attività, programmi, dati ed eccezioni", // allow-italian: fixture data, shown as written
    tasks: {
      calendar: 'Calendario delle interviste inviato', // allow-italian: fixture data, shown as written
      consent: 'Consenso firmato da chi viene intervistato', // allow-italian: fixture data, shown as written
      observe: 'Osservazione di PEC e board in corso', // allow-italian: fixture data, shown as written
      group: 'Attività raggruppate per ufficio', // allow-italian: fixture data, shown as written
      programs: 'Elenco dei programmi usati rivisto', // allow-italian: fixture data, shown as written
    },
  },
  procedures: {
    title: 'Procedure scritte e approvate', // allow-italian: fixture data, shown as written
    text: "una per attività mappata, approvata dal responsabile d'ufficio", // allow-italian: fixture data, shown as written
    tasks: {
      draft: "Bozze scritte dall'AI", // allow-italian: fixture data, shown as written
      review: 'Riviste dagli uffici', // allow-italian: fixture data, shown as written
      approve: 'Approvate dai responsabili', // allow-italian: fixture data, shown as written
    },
  },
  trial: {
    title: 'Primi 3 flussi in prova', // allow-italian: fixture data, shown as written
    text: 'girano accanto al lavoro di oggi senza scrivere nulla, e si confrontano i risultati', // allow-italian: fixture data, shown as written
    tasks: {
      pick: 'Tre flussi scelti', // allow-italian: fixture data, shown as written
      shadow: 'In prova accanto al lavoro di oggi', // allow-italian: fixture data, shown as written
      compare: 'Risultati confrontati', // allow-italian: fixture data, shown as written
    },
  },
  launch: {
    title: 'Accensione, un ufficio alla volta', // allow-italian: fixture data, shown as written
    text: 'prima Protocollo, poi Ragioneria · formazione di 2 ore per ufficio', // allow-italian: fixture data, shown as written
    tasks: {
      protocol: 'Protocollo acceso', // allow-italian: fixture data, shown as written
      accounting: 'Ragioneria accesa', // allow-italian: fixture data, shown as written
      training: 'Formazione di 2 ore per ufficio', // allow-italian: fixture data, shown as written
    },
  },
  upkeep: {
    title: 'Manutenzione della memoria', // allow-italian: fixture data, shown as written
    text: 'ogni mese: procedure da rivedere, persone che cambiano ruolo, attività nuove viste nelle PEC', // allow-italian: fixture data, shown as written
    tasks: {
      monthly: 'Procedure da rivedere', // allow-italian: fixture data, shown as written
      roles: 'Persone che cambiano ruolo', // allow-italian: fixture data, shown as written
      new: 'Attività nuove nelle PEC', // allow-italian: fixture data, shown as written
    },
  },
};

/** What a standard of a sector package says about itself: it comes with the package, so it is data. */
export const SECTOR_STANDARD_TEXT: Partial<Record<StandardId, { about: string; how: string; proof: string }>> = {
  'agid-docs': { about: 'protocollo, fascicoli, conservazione', how: "i tipi seguono il titolario; ogni documento ha i metadati dell'allegato 5", proof: 'controllo sui metadati, ogni notte' }, // allow-italian: fixture data, shown as written
  cad: { about: 'firma, PEC, copie informatiche', how: 'firme verificate sugli allegati, ricevute di consegna conservate con la pratica', proof: 'Registro delle verifiche di firma' }, // allow-italian: fixture data, shown as written
  'agid-seg': { about: 'scambio tra amministrazioni', how: 'il protocollo resta nel programma di protocollo; Topics non lo duplica', proof: 'robot: un numero solo per PEC' }, // allow-italian: fixture data, shown as written
  preservation: { about: 'chi fa conservazione a norma', how: "Topics non conserva: versa al conservatore qualificato dell'organizzazione", proof: 'ricevute di versamento' }, // allow-italian: fixture data, shown as written
  rentri: { about: 'rifiuti, formulari, registri', how: 'FIR e RENTRI come passi dei flussi, scadenze nello scadenzario', proof: 'da concordare con ORBIT' }, // allow-italian: fixture data, shown as written
  iso9001: { about: 'gestione della qualità', how: 'procedure approvate e versionate, registro delle modifiche', proof: 'da concordare con ORBIT' }, // allow-italian: fixture data, shown as written
  iso14001: { about: 'gestione ambientale', how: 'dati di servizio tracciati per commessa', proof: 'da concordare con ORBIT' }, // allow-italian: fixture data, shown as written
  iso45001: { about: 'salute e sicurezza sul lavoro', how: 'scadenze di formazione e idoneità nei turni', proof: 'da concordare con ORBIT' }, // allow-italian: fixture data, shown as written
};
