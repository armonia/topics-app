/**
 * Fixture of n17: the tasks that live only on the Board, next to the cases
 * that the Board draws from the example cases. Each task belongs to one
 * organization and names where it leads. Organizations, areas and titles are
 * the mockup's, rewritten without personal names; the dates are relative to
 * the demo clock (`org/clock.ts`).
 *
 * Counts on the Board are always computed from these tasks and from the
 * cases, never typed: a count printed anywhere else must come from the same
 * lists.
 */
import type { Tone } from '../types';
import type { OrgKey } from './org/types';

export type BoardColumn = 'backlog' | 'todo' | 'progress' | 'review' | 'done';

export const BOARD_COLUMNS: BoardColumn[] = ['backlog', 'todo', 'progress', 'review', 'done'];

/** Where a card leads. The screens file turns it into an address (`paths.ts`). */
export type BoardTarget =
  | { kind: 'procedure'; id: string }
  | { kind: 'flowTest'; flow: string }
  | { kind: 'caseKind'; caseKind: string }
  | { kind: 'data' }
  | { kind: 'deadlines' }
  | { kind: 'quality' }
  | { kind: 'programs' }
  | { kind: 'settings'; section: string }
  | { kind: 'orbitCallCenter' }
  | { kind: 'orbitFlow'; flow: string }
  | { kind: 'org'; org: OrgKey };

export interface BoardChipSeed {
  text: string;
  tone: Tone;
  /** A glyph name from the screens file's small table. */
  icon?: 'sparkles' | 'check' | 'alert';
}

export interface BoardTaskSeed {
  id: string;
  org: OrgKey;
  /** The kind of work, after the organization: «PEC → protocollo», «assistenza». */
  area: string;
  title: string;
  column: BoardColumn;
  /** YYYY-MM-DD; shown as a date chip. */
  due?: string;
  chips?: BoardChipSeed[];
  target: BoardTarget;
}

export const BOARD_TASKS: BoardTaskSeed[] = [
  // Backlog
  { id: 'bt-fornitori', org: 'nocera', area: 'da chat', title: 'Sistemare elenco fornitori doppi', column: 'backlog', chips: [{ text: 'manca priorità', tone: 'amber' }], target: { kind: 'data' } }, // allow-italian: fixture data, shown as written
  { id: 'bt-foglie-teams', org: 'orbit', area: 'da Teams', title: 'Segnalazione foglie senza indirizzo', column: 'backlog', target: { kind: 'orbitCallCenter' } }, // allow-italian: fixture data, shown as written
  { id: 'bt-diffida', org: 'armonia', area: 'assistenza', title: 'Regola «diffida» nel pacchetto di settore', column: 'backlog', target: { kind: 'settings', section: 'settore' } }, // allow-italian: fixture data, shown as written
  { id: 'bt-tempi-det', org: 'orbit', area: 'scadenzario', title: 'Tempi determinati in scadenza a dicembre', column: 'backlog', target: { kind: 'orbitFlow', flow: 'orbit-scadenze' } }, // allow-italian: fixture data, shown as written
  // Todo
  { id: 'bt-memorie-tar', org: 'nocera', area: 'PEC → protocollo', title: 'Memorie TAR, ricorrente (esempio)', column: 'todo', due: '2026-11-30', chips: [{ text: 'Legale', tone: 'neutral' }], target: { kind: 'caseKind', caseKind: 'ricorso' } }, // allow-italian: fixture data, shown as written
  { id: 'bt-accesso-atti', org: 'nocera', area: 'PEC → protocollo', title: 'Risposta accesso agli atti', column: 'todo', due: '2026-11-28', chips: [{ text: 'Protocollo', tone: 'neutral' }], target: { kind: 'caseKind', caseKind: 'accesso' } }, // allow-italian: fixture data, shown as written
  { id: 'bt-enel', org: 'nocera', area: 'Fatture', title: 'Pagamento Enel ottobre', column: 'todo', due: '2026-11-30', target: { kind: 'caseKind', caseKind: 'fattura' } }, // allow-italian: fixture data, shown as written
  { id: 'bt-winwaste', org: 'orbit', area: 'Programmi', title: 'WinWaste: agente da installare sul PC pesate', column: 'todo', due: '2026-11-07', target: { kind: 'programs' } }, // allow-italian: fixture data, shown as written
  // In progress
  { id: 'bt-nota-regione', org: 'nocera', area: 'PEC → protocollo', title: 'Nota Regione su L.R. 7/2025', column: 'progress', chips: [{ text: 'bozza pronta', tone: 'pink', icon: 'sparkles' }, { text: 'DIR', tone: 'neutral' }], target: { kind: 'caseKind', caseKind: 'regione' } }, // allow-italian: fixture data, shown as written
  { id: 'bt-collaudo-v5', org: 'nocera', area: 'Flussi', title: 'Collaudo della versione 5 del flusso PEC', column: 'progress', chips: [{ text: 'giorno 4 di 7', tone: 'amber' }, { text: 'ok del direttore a collaudo finito', tone: 'neutral', icon: 'check' }], target: { kind: 'flowTest', flow: 'pec' } }, // allow-italian: fixture data, shown as written
  { id: 'bt-robot-halley', org: 'armonia', area: 'assistenza', title: 'Robot Halley: password scaduta, poi nuovo collaudo', column: 'progress', chips: [{ text: 'da rifare', tone: 'amber', icon: 'alert' }], target: { kind: 'programs' } }, // allow-italian: fixture data, shown as written
  { id: 'bt-acn', org: 'armonia', area: 'assistenza', title: 'Richiesta della qualificazione cloud ACN', column: 'progress', due: '2026-11-15', target: { kind: 'settings', section: 'conformita' } }, // allow-italian: fixture data, shown as written
  // Review
  { id: 'bt-proc-attraversamento', org: 'nocera', area: 'Conoscenza', title: 'Procedura «Concessione di attraversamento»', column: 'review', chips: [{ text: 'Tecnico', tone: 'amber' }], target: { kind: 'procedure', id: 'concessione-attraversamento' } }, // allow-italian: fixture data, shown as written
  { id: 'bt-proc-giudizio', org: 'nocera', area: 'Conoscenza', title: 'Procedura «Costituzione in giudizio»', column: 'review', chips: [{ text: 'Legale', tone: 'amber' }], target: { kind: 'procedure', id: 'costituzione-in-giudizio' } }, // allow-italian: fixture data, shown as written
  { id: 'bt-proc-turno', org: 'nocera', area: 'Conoscenza', title: "Procedura «Turno irriguo d'emergenza»", column: 'review', chips: [{ text: 'controllo fonti', tone: 'pink', icon: 'sparkles' }], target: { kind: 'procedure', id: 'turno-irriguo-emergenza' } }, // allow-italian: fixture data, shown as written
  { id: 'bt-iva-orbit', org: 'orbit', area: 'Fatture', title: 'Differenza IVA su 3 fatture', column: 'review', chips: [{ text: 'quarantena', tone: 'amber', icon: 'alert' }], target: { kind: 'quality' } }, // allow-italian: fixture data, shown as written
  // Done
  { id: 'bt-fatture-ott', org: 'nocera', area: 'Fatture', title: 'Fatture di ottobre riconciliate (esempio)', column: 'done', target: { kind: 'caseKind', caseKind: 'fattura' } }, // allow-italian: fixture data, shown as written
  { id: 'bt-rendiconto-foglie', org: 'orbit', area: 'Customer service', title: 'Rendiconto servizio foglie di ottobre inviato ad AMA', column: 'done', target: { kind: 'orbitFlow', flow: 'orbit-foglie' } }, // allow-italian: fixture data, shown as written
];

/** The label of a Board-only area for an organization with no flows: shown after the name. */
export const BOARD_NEW_AREA: Record<OrgKey, string> = {
  nocera: 'da Board', // allow-italian: fixture data, shown as written
  orbit: 'da Board', // allow-italian: fixture data, shown as written
  armonia: 'assistenza', // allow-italian: fixture data, shown as written
  euro: 'avvio', // allow-italian: fixture data, shown as written
};

/** One line on who the organization is. Alfa Impianti has none: the scenario says nothing more than that it is starting. */
export const ORG_SUMMARY: Partial<Record<OrgKey, string>> = {
  armonia: 'Chi configura e assiste: flussi, dati e programmi delle altre organizzazioni.', // allow-italian: fixture data, shown as written
};
