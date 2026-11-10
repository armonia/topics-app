/**
 * Example data of the `team` area: testing, who may change the structure, the
 * team and its invitations, sharing with an outside person, the connections
 * of the organization and the month of the log that cannot be edited.
 *
 * Real: the programs the Consorzio uses (Halley, Prunes, TeamSystem, Publisys,
 * PA Legal, Traspare, QGIS, Microsoft 365, PEC Aruba; `DATI-VERI.md`), the
 * Regione Campania as a possible outside reader. An example, and labelled so:
 * every person (a role, never a name), every address (the `esempio` domain), (allow-italian: quotes the Italian interface)
 * every count of a day in test or of passes, every protocol number. Volumes
 * of a test are estimates derived from the flow's monthly volume.
 */
import type { CaseKind, Office } from './org/types';
import type { Permission } from './org/people';
import { DEMO_TODAY, addDays } from './org/clock';

/* ---------- testing (c01, c02) ---------- */

/** What a type of case is called by the people who work it. */
export const CASE_KIND_LABEL: Record<CaseKind, string> = {
  ricorso: 'Ricorso', // allow-italian: fixture data, shown as written
  sgravio: 'Istanza di sgravio', // allow-italian: fixture data, shown as written
  concessione: 'Concessione idraulica', // allow-italian: fixture data, shown as written
  accesso: 'Accesso agli atti', // allow-italian: fixture data, shown as written
  segnalazione: 'Segnalazione', // allow-italian: fixture data, shown as written
  fattura: 'Fattura passiva', // allow-italian: fixture data, shown as written
  verbale: 'Verbale di polizia idraulica', // allow-italian: fixture data, shown as written
  irrigazione: 'Richiesta irrigua', // allow-italian: fixture data, shown as written
  regione: 'Comunicazione della Regione', // allow-italian: fixture data, shown as written
  send: 'Notifica via SEND', // allow-italian: fixture data, shown as written
  rifiuti: 'Segnalazione rifiuti', // allow-italian: fixture data, shown as written
  foglie: 'Servizio foglie', // allow-italian: fixture data, shown as written
  fir: 'FIR e RENTRI', // allow-italian: fixture data, shown as written
};

/** The type the AI mixes a type of case up with when it is unsure (the unstable case). */
export const KIND_CONFUSION: Partial<Record<CaseKind, CaseKind>> = {
  ricorso: 'sgravio',
  sgravio: 'ricorso',
  accesso: 'segnalazione',
  segnalazione: 'accesso',
  concessione: 'verbale',
  verbale: 'concessione',
  fattura: 'regione',
  irrigazione: 'segnalazione',
  regione: 'accesso',
};

/** How many days a new version runs beside the active one before it can be approved. */
export const TEST_DAYS = 7;

/** A new version of a flow that runs beside the active one, without writing anything. */
export interface TestPlan {
  version: number;
  /** The day of the test the demo's today falls on (1-based). */
  day: number;
  of: number;
  /** When the test started, YYYY-MM-DD. */
  startedOn: string;
  /** Who started it (a persona id). */
  startedBy: string;
  /** What the new version changes, one line. */
  change: string;
}

/** Versions in test, by flow id. A flow without one is tested as it runs. */
export const TEST_PLANS: Record<string, TestPlan> = {
  pec: {
    version: 5, day: 4, of: 7, startedOn: addDays(DEMO_TODAY, -3), startedBy: 'attilio',
    change: 'soglia 90% → 85%, nuovo blocco «accesso atti»', // allow-italian: fixture data, shown as written
  },
  concessioni: {
    version: 1, day: 6, of: 7, startedOn: addDays(DEMO_TODAY, -5), startedBy: 'attilio',
    change: 'prima versione: dalla richiesta al provvedimento', // allow-italian: fixture data, shown as written
  },
};

/** Who approves a version once it is tested. */
export const DEFAULT_APPROVER = 'Direttore'; // allow-italian: fixture data, shown as written

/** What was agreed on a flow with the office, the line under «Criteri per passare». */
export const CRITERIA_AGREED_WITH: Record<string, string> = {
  pec: 'il responsabile del Protocollo', // allow-italian: fixture data, shown as written
  concessioni: 'il responsabile del servizio tecnico', // allow-italian: fixture data, shown as written
  fatture: 'il responsabile della Ragioneria', // allow-italian: fixture data, shown as written
};
export const DEFAULT_AGREED_WITH = 'il responsabile del flusso'; // allow-italian: fixture data, shown as written

/** A piece of the system that can change a result and is tested on its own (c02). */
export interface TestableThing {
  id: string;
  name: string;
  kind: 'ai' | 'rule' | 'robot' | 'data' | 'procedure' | 'system';
  version: number;
  status: 'attivo' | 'collaudo' | 'da-rifare'; // allow-italian: fixture data, shown as written
  /** Fixed cases it is replayed on: an estimate until the cases of the preview cover it. */
  fixed: number;
  /** Same result over three rounds, in percent; null before the first test. */
  stability: number | null;
  /** Whole days since the last check; 0 = last night. */
  checkedDaysAgo: number;
  approvedBy?: string;
  /** The connection a robot works through (`CONNECTIONS`): the test fails when it is not connected. */
  connection?: string;
  /** Why the last check failed, when it did. */
  lastFailure?: string;
}

export const TESTABLE_THINGS: TestableThing[] = [
  { id: 'ai-tipo-pec', name: 'Riconosce il tipo di PEC', kind: 'ai', version: 7, status: 'attivo', fixed: 120, stability: 99.6, checkedDaysAgo: 0, approvedBy: 'Responsabile del protocollo' }, // allow-italian: fixture data, shown as written
  { id: 'ai-righe-fattura', name: 'Legge righe, importi e IVA', kind: 'ai', version: 3, status: 'attivo', fixed: 64, stability: 99.1, checkedDaysAgo: 0, approvedBy: 'Responsabile della ragioneria' }, // allow-italian: fixture data, shown as written
  { id: 'rule-scadenze-ricorso', name: 'Scadenze del ricorso', kind: 'rule', version: 2, status: 'attivo', fixed: 24, stability: 100, checkedDaysAgo: 0, approvedBy: 'Avvocato interno' }, // allow-italian: fixture data, shown as written
  { id: 'rule-canone', name: 'Calcolo del canone di concessione', kind: 'rule', version: 1, status: 'attivo', fixed: 16, stability: 100, checkedDaysAgo: 0, approvedBy: 'Direttore' }, // allow-italian: fixture data, shown as written
  { id: 'robot-halley', name: 'Robot Halley, protocollo', kind: 'robot', version: 3, status: 'da-rifare', fixed: 12, stability: 100, checkedDaysAgo: 0, approvedBy: 'Responsabile del protocollo', connection: 'halley', lastFailure: 'password cambiata in Halley il 05/11, fermo dalle 09:50' }, // allow-italian: fixture data, shown as written
  { id: 'robot-prunes', name: 'Robot Prunes, catasto', kind: 'robot', version: 2, status: 'attivo', fixed: 30, stability: 100, checkedDaysAgo: 0, approvedBy: 'Responsabile del catasto', connection: 'prunes' }, // allow-italian: fixture data, shown as written
  { id: 'robot-teamsystem', name: 'Agente TeamSystem, registrazioni', kind: 'robot', version: 2, status: 'attivo', fixed: 18, stability: 100, checkedDaysAgo: 0, approvedBy: 'Responsabile della ragioneria', connection: 'teamsystem' }, // allow-italian: fixture data, shown as written
  { id: 'robot-traspare', name: 'Robot Traspare, gare', kind: 'robot', version: 1, status: 'da-rifare', fixed: 8, stability: null, checkedDaysAgo: 4, approvedBy: 'Responsabile del servizio tecnico', connection: 'traspare', lastFailure: 'il portale ha chiesto un nuovo accesso' }, // allow-italian: fixture data, shown as written
  { id: 'data-ricorsi', name: 'Tabella Ricorsi, campi', kind: 'data', version: 4, status: 'attivo', fixed: 18, stability: 100, checkedDaysAgo: 0, approvedBy: 'Direttore' }, // allow-italian: fixture data, shown as written
  { id: 'proc-rimborso', name: 'Procedura rimborso doppio', kind: 'procedure', version: 1, status: 'collaudo', fixed: 12, stability: null, checkedDaysAgo: 3 }, // allow-italian: fixture data, shown as written
  { id: 'sys-anonimizzazione', name: 'Anonimizzazione', kind: 'system', version: 2, status: 'attivo', fixed: 96, stability: 100, checkedDaysAgo: 0, approvedBy: 'Armonia' }, // allow-italian: fixture data, shown as written
];

/* ---------- structure (c03) ---------- */

/** A part of the structure whose rights are listed: what sees it, changes it, approves it. */
export interface StructureArea {
  id: string;
  name: string;
  /** What it takes to see it. */
  view: Permission;
  /** What it takes to change it. */
  edit: Permission;
}

export const STRUCTURE_AREAS: StructureArea[] = [
  { id: 'flow-pec', name: 'Flusso PEC → protocollo', view: 'view:flows', edit: 'edit:structure' }, // allow-italian: fixture data, shown as written
  { id: 'flow-fatture', name: 'Flusso Fattura → pagamento', view: 'view:flows', edit: 'edit:structure' }, // allow-italian: fixture data, shown as written
  { id: 'types-pec', name: 'Tipi di PEC', view: 'view:flows', edit: 'edit:structure' }, // allow-italian: fixture data, shown as written
  { id: 'fields-ricorsi', name: 'Campi della tabella Ricorsi', view: 'view:data', edit: 'edit:structure' }, // allow-italian: fixture data, shown as written
  { id: 'views', name: 'Viste e mappe', view: 'view:views', edit: 'edit:structure' }, // allow-italian: fixture data, shown as written
  { id: 'channels', name: 'Canali: PEC, mail, WhatsApp', view: 'view:channels', edit: 'edit:structure' }, // allow-italian: fixture data, shown as written
  { id: 'robots', name: 'Robot e agenti sui programmi', view: 'view:programs', edit: 'edit:structure' }, // allow-italian: fixture data, shown as written
  { id: 'collections', name: 'Raccolte di Conoscenza', view: 'view:knowledge', edit: 'edit:structure' }, // allow-italian: fixture data, shown as written
  { id: 'permissions', name: 'I permessi stessi', view: 'view:settings', edit: 'admin' }, // allow-italian: fixture data, shown as written
];

/** The change somebody asked for and the structure team has not done yet (the aside of c03). */
export interface ChangeProposal {
  id: string;
  title: string;
  reason: string;
  /** Persona id who asked. */
  by: string;
  /** YYYY-MM-DD */
  on: string;
  /** The flow the change is tested on, when it has one. */
  flow?: string;
  stage: 'proposta' | 'modifica' | 'collaudo' | 'approvazione'; // allow-italian: fixture data, shown as written
}

export const SEED_PROPOSALS: ChangeProposal[] = [
  {
    id: 'prop-diffida', title: 'Aggiungere «diffida» ai tipi di PEC', // allow-italian: fixture data, shown as written
    reason: 'Le diffide finiscono a volte tra le comunicazioni e perdiamo i 15 giorni.', // allow-italian: fixture data, shown as written
    by: 'legale', on: addDays(DEMO_TODAY, -1), flow: 'pec', stage: 'modifica', // allow-italian: fixture data, shown as written
  },
];

/** The role as a short word, for a cell that lists several of them. */
export const ROLE_SHORT: Record<string, string> = {
  operatore: 'Armonia', // allow-italian: fixture data, shown as written
  direzione: 'Direzione', // allow-italian: fixture data, shown as written
  legale: 'Legale', // allow-italian: fixture data, shown as written
  protocollo: 'Protocollo', // allow-italian: fixture data, shown as written
  lettura: 'Lettura', // allow-italian: fixture data, shown as written
  'call-center': 'Call center', // allow-italian: fixture data, shown as written
};

/* ---------- team (t01) ---------- */

/** Who asked for an access and has not answered yet. */
export interface SeedInvite {
  id: string;
  email: string;
  role: string;
  orgs: string[];
  /** ISO date-time the invitation was sent. */
  sentAt: string;
  by: string;
}

export const SEED_INVITES: SeedInvite[] = [
  { id: 'inv-seed-1', email: 'revisore.esterno@x.example.it', role: 'lettura', orgs: ['nocera'], sentAt: `${addDays(DEMO_TODAY, -2)}T15:20:00+01:00`, by: 'attilio' }, // allow-italian: fixture data, shown as written
];

/** The offices a person can be given, in the order of the filter. */
export const OFFICE_ORDER: Office[] = [
  'protocollo', 'legale', 'catasto', 'tecnico', 'manutenzione', 'ragioneria', 'segreteria', 'irrigazione', 'direzione',
];

/* ---------- sharing (t02) ---------- */

export interface ShareOpen {
  /** ISO date-time. */
  at: string;
  /** Who opened it, as the access code identified them. */
  who: string;
}

export interface ShareSeed {
  id: string;
  /** `record` or `view`, and the id of the case or the name of the view. */
  scope: { kind: 'record' | 'view'; id: string; label: string };
  to: { email: string; label: string };
  can: 'view' | 'comment';
  /** YYYY-MM-DD */
  until: string;
  watermark: boolean;
  /** What the guest also sees, besides the record. */
  includes: { contributor: boolean; sameContributor: boolean; assistant: boolean };
  /** ISO date-time created and by whom. */
  createdAt: string;
  by: string;
  code: string;
  revoked?: boolean;
  opens: ShareOpen[];
}

export const SEED_SHARES: ShareSeed[] = [
  {
    id: 'sh-1', scope: { kind: 'record', id: '2418', label: 'Ricorso CGT, azienda agricola' }, // allow-italian: fixture data, shown as written
    to: { email: 'studio.incaricato@x.example.it', label: 'Studio legale incaricato (esempio)' }, // allow-italian: fixture data, shown as written
    can: 'comment', until: '2026-12-31', watermark: true,
    includes: { contributor: false, sameContributor: false, assistant: false },
    createdAt: `${DEMO_TODAY}T09:48:00+01:00`, by: 'legale', code: 'k7d2m9',
    opens: [{ at: `${DEMO_TODAY}T10:02:00+01:00`, who: 'studio.incaricato@x.example.it' }], // allow-italian: fixture data, shown as written
  },
  {
    id: 'sh-2', scope: { kind: 'view', id: 'particelle-sarno', label: 'Particelle del bacino Sarno sulla mappa' }, // allow-italian: fixture data, shown as written
    to: { email: 'ufficio.bonifica@x.example.it', label: 'Regione Campania, ufficio bonifica (esempio)' }, // allow-italian: fixture data, shown as written
    can: 'view', until: '2026-11-30', watermark: true,
    includes: { contributor: false, sameContributor: false, assistant: false },
    createdAt: `${addDays(DEMO_TODAY, -6)}T16:05:00+01:00`, by: 'attilio', code: 'p3x8q1',
    opens: [
      { at: `${addDays(DEMO_TODAY, -5)}T09:30:00+01:00`, who: 'ufficio.bonifica@x.example.it' }, // allow-italian: fixture data, shown as written
      { at: `${addDays(DEMO_TODAY, -2)}T11:12:00+01:00`, who: 'ufficio.bonifica@x.example.it' }, // allow-italian: fixture data, shown as written
    ],
  },
];

/** The kinds of outside person a share is made for, with the line that says who they are. */
export const GUEST_KINDS: Array<{ id: string; label: string }> = [
  { id: 'legal', label: 'legale esterno del consorzio' }, // allow-italian: fixture data, shown as written
  { id: 'region', label: 'ente pubblico (Regione, Comune)' }, // allow-italian: fixture data, shown as written
  { id: 'auditor', label: 'revisore o consulente' }, // allow-italian: fixture data, shown as written
];

/** The views an outside person can be given, besides a single record. */
export const SHAREABLE_VIEWS: Array<{ id: string; label: string }> = [
  { id: 'particelle-sarno', label: 'Particelle del bacino Sarno sulla mappa' }, // allow-italian: fixture data, shown as written
  { id: 'scadenzario', label: 'Scadenzario delle pratiche aperte' }, // allow-italian: fixture data, shown as written
];

/* ---------- connections (n16) ---------- */

export type ConnectionMethod = 'robot' | 'agent' | 'mcp' | 'read' | 'mail' | 'official';

export interface ConnectionSeed {
  id: string;
  name: string;
  /** Short line: what Topics does through it. */
  how: string;
  method: ConnectionMethod;
  state: 'connected' | 'error' | 'todo';
  /** What is wrong, when `state` is `error`. */
  problem?: string;
  /** Persona id who connected it. */
  by?: string;
  /** ISO date-time of the last use. */
  lastUse?: string;
  /** What it may do. */
  rights: 'read' | 'readwrite' | 'send';
  /** The sector word for the thing it connects to, one line. */
  what: string;
}

export const CONNECTIONS: ConnectionSeed[] = [
  { id: 'pec-aruba', name: 'PEC Aruba, protocollo@', how: 'lettura e invio con conferma', method: 'mail', state: 'connected', by: 'protocollo', lastUse: `${DEMO_TODAY}T10:28:00+01:00`, rights: 'send', what: 'La casella certificata del protocollo, dove arrivano ricorsi e comunicazioni.' }, // allow-italian: fixture data, shown as written
  { id: 'microsoft-365', name: 'Microsoft 365', how: "con l'account di chi accede", method: 'official', state: 'connected', by: 'attilio', lastUse: `${DEMO_TODAY}T10:05:00+01:00`, rights: 'read', what: "Posta, calendario e Teams dell'organizzazione, con l'account di chi accede." }, // allow-italian: fixture data, shown as written
  { id: 'halley', name: 'Halley, protocollo', how: 'con utente dedicato', method: 'robot', state: 'error', problem: 'password cambiata in Halley il 05/11', by: 'protocollo', lastUse: `${DEMO_TODAY}T09:50:00+01:00`, rights: 'readwrite', what: 'Protocollo, atti e albo: il robot protocolla e prepara i fascicoli.' }, // allow-italian: fixture data, shown as written
  { id: 'prunes', name: 'Prunes, catasto e ruoli', how: 'direttamente sul database', method: 'read', state: 'connected', by: 'attilio', lastUse: `${DEMO_TODAY}T10:15:00+01:00`, rights: 'read', what: 'Catasto consortile, ruoli e riscossione: contribuenti, avvisi, particelle.' }, // allow-italian: fixture data, shown as written
  { id: 'teamsystem', name: 'TeamSystem, contabilità', how: 'registrazione fatture', method: 'agent', state: 'connected', by: 'attilio', lastUse: `${addDays(DEMO_TODAY, -1)}T17:40:00+01:00`, rights: 'readwrite', what: 'La contabilità: le fatture passive si registrano da un agente sul PC della Ragioneria.' }, // allow-italian: fixture data, shown as written
  { id: 'publisys', name: 'Publisys, paghe', how: 'lettura di contratti a termine e certificati', method: 'robot', state: 'connected', by: 'attilio', lastUse: `${DEMO_TODAY}T07:00:00+01:00`, rights: 'read', what: 'Le paghe: serve allo scadenzario del personale, ogni giorno alle 7.' }, // allow-italian: fixture data, shown as written
  { id: 'qgis', name: 'QGIS', how: 'tavole e perimetri', method: 'agent', state: 'connected', by: 'attilio', lastUse: `${addDays(DEMO_TODAY, -1)}T14:22:00+01:00`, rights: 'read', what: 'Le tavole del comprensorio: il Tecnico le carica sulle pratiche.' }, // allow-italian: fixture data, shown as written
  { id: 'traspare', name: 'Traspare, gare telematiche', how: 'sul portale di gara', method: 'robot', state: 'error', problem: 'il portale ha chiesto un nuovo accesso', by: 'attilio', lastUse: `${addDays(DEMO_TODAY, -4)}T11:10:00+01:00`, rights: 'readwrite', what: 'Il portale delle gare: il robot apre le procedure e legge gli esiti.' }, // allow-italian: fixture data, shown as written
  { id: 'pa-legal', name: 'PA Legal, contenzioso', how: 'fascicoli dei ricorsi', method: 'read', state: 'todo', rights: 'read', what: 'Il contenzioso: collegarlo porta i fascicoli dei ricorsi accanto alle pratiche.' }, // allow-italian: fixture data, shown as written
];

/* ---------- the log (n15) ---------- */

/** Who did a line of the log, when it is not a person of the preview. */
export interface LogActor {
  id: string;
  kind: 'ai' | 'robot' | 'access' | 'system';
  label: string;
}

export const LOG_ACTORS: LogActor[] = [
  { id: 'ai:classifica', kind: 'ai', label: 'Classifica' }, // allow-italian: fixture data, shown as written
  { id: 'ai:bozza', kind: 'ai', label: 'Bozza' }, // allow-italian: fixture data, shown as written
  { id: 'robot:halley', kind: 'robot', label: 'Halley' },
  { id: 'robot:prunes', kind: 'robot', label: 'Prunes' },
  { id: 'access:armonia', kind: 'access', label: 'Armonia' },
  { id: 'access:mcp', kind: 'access', label: 'Claude via MCP' },
  { id: 'system:notte', kind: 'system', label: 'Controllo notturno' }, // allow-italian: fixture data, shown as written
];

export interface SeedLogLine {
  /** Days before the demo's today. */
  day: number;
  time: string;
  /** A persona id or a `LogActor` id. */
  who: string;
  what: string;
  /** The case, flow or place it concerns, as the sector names it. */
  subject?: string;
  detail?: string;
  /** Where the line opens: a path of the app, built by the screen from `to`. */
  to: { kind: 'record' | 'flowTest' | 'testAll' | 'settings' | 'remote' | 'knowledge' | 'flow'; id: string };
  kind: 'case' | 'structure' | 'permission' | 'test' | 'knowledge' | 'access' | 'setting' | 'share';
}

/** The month before the demo's today, oldest first within a day is the screen's job. */
export const SEED_LOG: SeedLogLine[] = [
  { day: 0, time: '10:12:44', who: 'legale', what: 'Ha confermato la classificazione', subject: '2416 Accesso agli atti (esempio)', detail: 'ufficio e titolario confermati, nessuna correzione', to: { kind: 'record', id: '2416' }, kind: 'case' }, // allow-italian: fixture data, shown as written
  { day: 0, time: '09:50:00', who: 'robot:halley', what: 'Si è fermato', subject: '2417 Avviso contestato (esempio)', detail: 'password rifiutata, 3 tentativi, nessun dato scritto', to: { kind: 'record', id: '2417' }, kind: 'case' }, // allow-italian: fixture data, shown as written
  { day: 0, time: '09:48:00', who: 'legale', what: 'Ha condiviso la pratica con un esterno', subject: '2418 Ricorso CGT (esempio)', detail: 'Studio legale incaricato (esempio), vede e commenta, fino al 31/12/2026', to: { kind: 'settings', id: 'condivisioni' }, kind: 'share' }, // allow-italian: fixture data, shown as written
  { day: 0, time: '09:14:03', who: 'access:armonia', what: 'Controllo remoto su PC-PROTOCOLLO-01', detail: 'consentito dall\'operatore del protocollo, 30 min, registrato', to: { kind: 'remote', id: '' }, kind: 'access' }, // allow-italian: fixture data, shown as written
  { day: 0, time: '08:00:00', who: 'access:mcp', what: 'Accesso di Claude via MCP', detail: 'sola lettura su Dati e Conoscenza', to: { kind: 'settings', id: 'sicurezza' }, kind: 'access' }, // allow-italian: fixture data, shown as written
  { day: 0, time: '02:30:00', who: 'system:notte', what: 'Ha rigiocato i casi fissi', detail: 'tutti i flussi attivi, nessuna differenza', to: { kind: 'testAll', id: '' }, kind: 'test' }, // allow-italian: fixture data, shown as written
  { day: 1, time: '17:40:12', who: 'robot:prunes', what: 'Ha letto il contribuente', subject: '2418 Ricorso CGT (esempio)', detail: 'codice C-0048213, sola lettura', to: { kind: 'record', id: '2418' }, kind: 'case' }, // allow-italian: fixture data, shown as written
  { day: 1, time: '12:41:12', who: 'ai:bozza', what: 'Ha scritto una bozza', subject: '2418 Ricorso CGT (esempio)', detail: 'incarico al legale, 2 fonti citate', to: { kind: 'record', id: '2418' }, kind: 'case' }, // allow-italian: fixture data, shown as written
  { day: 1, time: '12:41:08', who: 'protocollo', what: 'Ha corretto il fascicolo', subject: '2418 Ricorso CGT (esempio)', detail: 'fascicolo: Ricorsi 2025 / Castel San Giorgio (proposta AI: Contenzioso 2026)', to: { kind: 'record', id: '2418' }, kind: 'case' }, // allow-italian: fixture data, shown as written
  { day: 1, time: '11:58:40', who: 'direzione', what: 'Ha chiesto alla Conoscenza', detail: '«chi contesta gli scarichi abusivi», 3 fonti', to: { kind: 'knowledge', id: '' }, kind: 'knowledge' }, // allow-italian: fixture data, shown as written
  { day: 1, time: '09:12:30', who: 'ai:classifica', what: 'Ha riconosciuto una PEC', subject: '2418 Ricorso CGT (esempio)', detail: 'ricorso, ufficio Legale, fiducia 96%', to: { kind: 'record', id: '2418' }, kind: 'case' }, // allow-italian: fixture data, shown as written
  { day: 2, time: '15:20:00', who: 'attilio', what: 'Ha invitato una persona', detail: 'revisore.esterno@x.example.it, sola lettura', to: { kind: 'settings', id: 'squadra' }, kind: 'permission' }, // allow-italian: fixture data, shown as written
  { day: 2, time: '11:12:00', who: 'access:mcp', what: 'Accesso di Claude via MCP', detail: 'sola lettura su Dati e Conoscenza', to: { kind: 'settings', id: 'sicurezza' }, kind: 'access' }, // allow-italian: fixture data, shown as written
  { day: 3, time: '10:15:00', who: 'attilio', what: 'Ha avviato il collaudo della versione 5', subject: 'Flusso PEC → protocollo', detail: 'soglia 90% → 85%, nuovo blocco «accesso atti», 7 giorni', to: { kind: 'flowTest', id: 'pec' }, kind: 'test' }, // allow-italian: fixture data, shown as written
  { day: 4, time: '11:10:00', who: 'robot:prunes', what: 'Ha letto il catasto', subject: 'Flusso Richiesta irrigua → turno', detail: '12 particelle, sola lettura', to: { kind: 'flow', id: 'irrigua' }, kind: 'structure' }, // allow-italian: fixture data, shown as written
  { day: 4, time: '10:50:00', who: 'attilio', what: 'Ha segnato il collegamento Traspare da rifare', detail: 'il portale ha chiesto un nuovo accesso', to: { kind: 'settings', id: 'persone' }, kind: 'setting' }, // allow-italian: fixture data, shown as written
  { day: 5, time: '16:30:00', who: 'attilio', what: 'Ha avviato il collaudo della versione 1', subject: 'Flusso Concessione idraulica', detail: 'prima versione, 7 giorni', to: { kind: 'flowTest', id: 'concessioni' }, kind: 'test' }, // allow-italian: fixture data, shown as written
  { day: 5, time: '09:30:00', who: 'access:mcp', what: 'Accesso di Claude via MCP', detail: 'sola lettura su Dati e Conoscenza', to: { kind: 'settings', id: 'sicurezza' }, kind: 'access' }, // allow-italian: fixture data, shown as written
  { day: 6, time: '16:05:00', who: 'attilio', what: 'Ha condiviso una vista con un esterno', subject: 'Particelle del bacino Sarno', detail: 'Regione Campania, ufficio bonifica (esempio), sola lettura, fino al 30/11/2026', to: { kind: 'settings', id: 'condivisioni' }, kind: 'share' }, // allow-italian: fixture data, shown as written
  { day: 8, time: '14:00:00', who: 'direzione', what: 'Ha approvato la procedura «Concessione di attraversamento»', detail: 'seconda approvazione, versione 2', to: { kind: 'knowledge', id: '' }, kind: 'knowledge' }, // allow-italian: fixture data, shown as written
  { day: 9, time: '09:40:00', who: 'attilio', what: 'Ha dato lettura del flusso gare al Tecnico', detail: 'ruolo Sola lettura: vede i flussi, non li modifica', to: { kind: 'settings', id: 'struttura' }, kind: 'permission' }, // allow-italian: fixture data, shown as written
  { day: 12, time: '10:00:00', who: 'direzione', what: 'Ha approvato la versione 4 del flusso PEC', subject: 'Flusso PEC → protocollo', detail: 'dopo 7 giorni di collaudo', to: { kind: 'flowTest', id: 'pec' }, kind: 'test' }, // allow-italian: fixture data, shown as written
  { day: 14, time: '15:10:00', who: 'protocollo', what: 'Ha confermato la classificazione', subject: '2411 Segnalazione di allagamento (esempio)', detail: 'Canale Macchione, Castel San Giorgio', to: { kind: 'record', id: '2411' }, kind: 'case' }, // allow-italian: fixture data, shown as written
  { day: 18, time: '11:20:00', who: 'attilio', what: 'Ha attivato il collegamento con Publisys', detail: 'sola lettura, contratti a termine e certificati', to: { kind: 'settings', id: 'persone' }, kind: 'setting' }, // allow-italian: fixture data, shown as written
  { day: 21, time: '09:05:00', who: 'attilio', what: 'Ha cambiato le regole di conservazione del registro', detail: '10 anni, non modificabile', to: { kind: 'settings', id: 'registro' }, kind: 'setting' }, // allow-italian: fixture data, shown as written
  { day: 27, time: '10:30:00', who: 'attilio', what: 'Ha collegato PEC Aruba, protocollo@', detail: 'lettura e invio con conferma', to: { kind: 'settings', id: 'persone' }, kind: 'setting' }, // allow-italian: fixture data, shown as written
];
