/**
 * Fixture of x01: the Consorzio's records as a table, filtered on the legal
 * office's open appeals. Counts, codes and protocol numbers are an example;
 * parties are described, never named. Prunes and Halley are the programs the
 * Consorzio really uses (DATI-VERI.md).
 */
import type { CaseKind, CaseStatus, Office } from './org/types';

/* ------------------------------------------------------------------ */
/* The live tables of the preview (x01, x02, w04, n14).                */
/* ------------------------------------------------------------------ */

/**
 * How many rows each table has in the whole organization. These are declared
 * estimates (the numbers of the mockups), the same everywhere they appear; the
 * rows the preview can show are the example cases, and the screens say so.
 */
export const DECLARED_TOTALS = {
  pratiche: 2318,
  scadenze: 186,
  ricorsi: 48,
  fatture: 612,
  richiesteIrrigue: 1208,
  fornitori: 342,
  pecPerMonth: 1204,
  allegati: 3870,
} as const;

/** The type letter and name of a case, as the Pratiche table and the schema print them. */
export const KIND_TYPE: Partial<Record<CaseKind, { letter: string; label: string }>> = {
  ricorso: { letter: 'A', label: 'Ricorso o atto giudiziario' }, // allow-italian: fixture data, shown as written
  sgravio: { letter: 'B', label: 'Istanza di sgravio o rimborso' }, // allow-italian: fixture data, shown as written
  concessione: { letter: 'C', label: 'Concessione su canale consortile' }, // allow-italian: fixture data, shown as written
  accesso: { letter: 'D', label: 'Accesso agli atti' }, // allow-italian: fixture data, shown as written
  segnalazione: { letter: 'E', label: 'Segnalazione dal territorio' }, // allow-italian: fixture data, shown as written
  fattura: { letter: 'F', label: 'Fattura passiva' }, // allow-italian: fixture data, shown as written
  verbale: { letter: 'G', label: 'Verbale di polizia idraulica' }, // allow-italian: fixture data, shown as written
  irrigazione: { letter: 'H', label: 'Richiesta irrigua' }, // allow-italian: fixture data, shown as written
  regione: { letter: 'I', label: 'Comunicazione della Regione' }, // allow-italian: fixture data, shown as written
  send: { letter: 'L', label: 'Notifica SEND' }, // allow-italian: fixture data, shown as written
};

export const STATUS_LABEL: Record<CaseStatus, string> = {
  'da-confermare': 'Da confermare', // allow-italian: fixture data, shown as written
  'in-lavorazione': 'In lavorazione', // allow-italian: fixture data, shown as written
  'in-attesa': 'In attesa', // allow-italian: fixture data, shown as written
  chiusa: 'Chiusa', // allow-italian: fixture data, shown as written
};

/** The kinds each case-based table is made of. */
export const TABLE_KINDS: Record<string, CaseKind[] | undefined> = {
  pratiche: undefined,
  ricorsi: ['ricorso'],
  fatture: ['fattura'],
  'richieste-irrigue': ['irrigazione'],
  concessioni: ['concessione'],
};

export interface TableMeta {
  id: string;
  label: string;
  /** Where the rows live: Topics itself or a program that Topics only reads. */
  home: 'topics' | 'prunes' | 'halley' | 'teamsystem';
  /** Rows in the whole organization when declared; otherwise the table counts what it shows. */
  total?: number;
  /** A line under the table name in the list of tables. */
  summary: string;
}

export const TABLE_METAS: TableMeta[] = [
  { id: 'pratiche', label: 'Pratiche', home: 'topics', total: DECLARED_TOTALS.pratiche, summary: 'Ogni PEC e ogni richiesta diventa una pratica.' }, // allow-italian: fixture data, shown as written
  { id: 'ricorsi', label: 'Ricorsi', home: 'topics', total: DECLARED_TOTALS.ricorsi, summary: 'Le pratiche di tipo A, con autorità e scadenze di giudizio.' }, // allow-italian: fixture data, shown as written
  { id: 'fatture', label: 'Fatture', home: 'topics', total: DECLARED_TOTALS.fatture, summary: 'Fatture passive arrivate dallo SdI, in attesa di registrazione e pagamento.' }, // allow-italian: fixture data, shown as written
  { id: 'richieste-irrigue', label: 'Richieste irrigue', home: 'topics', total: DECLARED_TOTALS.richiesteIrrigue, summary: 'Turni irrigui chiesti nei 7 bacini di irrigazione collettiva.' }, // allow-italian: fixture data, shown as written
  { id: 'concessioni', label: 'Concessioni', home: 'topics', summary: 'Attraversamenti e scarichi in canali consortili.' }, // allow-italian: fixture data, shown as written
  { id: 'contribuenti', label: 'Contribuenti', home: 'prunes', summary: 'Si leggono da Prunes: qui compaiono solo quelli che hanno una pratica.' }, // allow-italian: fixture data, shown as written
  { id: 'canali', label: 'Canali e opere', home: 'topics', summary: 'Le aste e i canali del comprensorio, con le pratiche che li riguardano.' }, // allow-italian: fixture data, shown as written
  { id: 'fornitori', label: 'Fornitori', home: 'teamsystem', total: DECLARED_TOTALS.fornitori, summary: 'Anagrafica fornitori di TeamSystem, con l\'IBAN usato per i pagamenti.' }, // allow-italian: fixture data, shown as written
];

/** Where the programs of the Consorzio open: ids of `P.program()`. */
export const PROGRAM_OF_HOME: Record<string, string> = { prunes: 'prunes', halley: 'halley', teamsystem: 'teamsystem' };

/** Canals and works that DATI-VERI.md names; `kind` is what the source calls them. */
export const CANALS: Array<{ id: string; name: string; kind: string; comune?: string; source: string; match: string }> = [
  { id: 'fiume-sarno', name: 'Fiume Sarno', kind: 'Asta principale', source: 'Libro dell\'anno 2025', match: 'sarno' }, // allow-italian: fixture data, shown as written
  { id: 'torrente-solofrana', name: 'Torrente Solofrana', kind: 'Asta principale', source: 'Libro dell\'anno 2025', match: 'solofrana' }, // allow-italian: fixture data, shown as written
  { id: 'torrente-cavaiola', name: 'Torrente Cavaiola', kind: 'Asta principale', source: 'Libro dell\'anno 2025', match: 'cavaiola' }, // allow-italian: fixture data, shown as written
  { id: 'alveo-comune-nocerino', name: 'Alveo Comune Nocerino', kind: 'Asta principale', source: 'Libro dell\'anno 2025', match: 'nocerino' }, // allow-italian: fixture data, shown as written
  { id: 'canale-dei-mulini', name: 'Canale dei Mulini', kind: 'Canale', source: 'Lavori 2025', match: 'mulini' }, // allow-italian: fixture data, shown as written
  { id: 'canale-lauro', name: 'Canale Lauro', kind: 'Canale', source: 'Lavori 2025', match: 'lauro' }, // allow-italian: fixture data, shown as written
  { id: 'canale-macchione', name: 'Canale Macchione', kind: 'Canale', comune: 'Castel San Giorgio', source: 'Lavori 2025', match: 'macchione' }, // allow-italian: fixture data, shown as written
  { id: 'torrente-lavinaio', name: 'Torrente Lavinaio', kind: 'Torrente', comune: 'Bracigliano', source: 'Lavori 2025', match: 'lavinaio' }, // allow-italian: fixture data, shown as written
];

/** Suppliers of the invoices (examples). The first two are the pair of the quarantined IBAN (q02). */
export interface SupplierSeed {
  id: string;
  name: string;
  /** Masked IBAN, never a full one. */
  iban: string;
  since: number;
  invoices: number;
  note?: string;
}

export const SUPPLIERS: SupplierSeed[] = [
  { id: 'idraulica-sud', name: 'Idraulica Sud srl', iban: 'IT…7781', since: 2023, invoices: 14, note: 'IBAN nuovo in fattura 1201: in quarantena' }, // allow-italian: fixture data, shown as written
  { id: 'pompe-campania', name: 'Pompe Campania snc', iban: 'IT…3456', since: 2019, invoices: 41 }, // allow-italian: fixture data, shown as written
  { id: 'elettrica-agro', name: 'Elettrica dell\'Agro srl', iban: 'IT…2204', since: 2021, invoices: 29 }, // allow-italian: fixture data, shown as written
  { id: 'ricambi-nocerino', name: 'Ricambi Nocerino snc', iban: 'IT…9018', since: 2020, invoices: 22 }, // allow-italian: fixture data, shown as written
  { id: 'carburanti-sele', name: 'Carburanti del Sele spa', iban: 'IT…4410', since: 2018, invoices: 63 }, // allow-italian: fixture data, shown as written
];

/** A saved view: the filters, grouping and order of a table under a name. */
export interface FilterSeed {
  col: string;
  op: 'is' | 'not' | 'within';
  value: string;
}

export interface ViewSeed {
  id: string;
  label: string;
  table: string;
  filters: FilterSeed[];
  q?: string;
  group?: string;
  sort?: { col: string; dir: 'asc' | 'desc' };
  /** A rule that cannot be written as filters: `mine` is the rows of the current person, `corrected` the rows a person corrected. */
  rule?: 'mine' | 'corrected';
}

export const VIEW_SEEDS: ViewSeed[] = [
  { id: 'legale-aperte', label: 'Legale, aperte', table: 'pratiche', filters: [{ col: 'ufficio', op: 'is', value: 'legale' }, { col: 'stato', op: 'not', value: 'chiusa' }], group: 'tipo', sort: { col: 'scadenza', dir: 'asc' } }, // allow-italian: fixture data, shown as written
  { id: 'scadono-30', label: 'Scadono in 30 giorni', table: 'pratiche', filters: [{ col: 'scadenza', op: 'within', value: '30' }], sort: { col: 'scadenza', dir: 'asc' } }, // allow-italian: fixture data, shown as written
  { id: 'corrette', label: 'Corrette dalle persone', table: 'pratiche', filters: [], rule: 'corrected' }, // allow-italian: fixture data, shown as written
  { id: 'mie', label: 'Mie', table: 'pratiche', filters: [], rule: 'mine' }, // allow-italian: fixture data, shown as written
];

/** Deadlines that no case writes: other flows, the schedule, a person. The preview adds them to the cases' own. */
export interface ExtraDeadline {
  id: string;
  date: string;
  label: string;
  office: Office;
  /** What the row of the schedule says it concerns. */
  about: string;
  writer: 'flow' | 'schedule' | 'person' | 'knowledge';
  writerLabel: string;
  note?: string;
  example?: boolean;
  /** `scheduled`: the act is already arranged (a payment on its order), so the row waits for its date without asking for anything. */
  state?: 'scheduled';
}

export const EXTRA_DEADLINES: ExtraDeadline[] = [
  { id: 'x-pagamento-1187', date: '2026-11-30', label: 'Pagamento fattura 1187', office: 'ragioneria', about: 'Enel ottobre', writer: 'flow', writerLabel: 'flusso fatture', note: 'Programmata sul mandato di pagamento.', state: 'scheduled' }, // allow-italian: fixture data, shown as written
  { id: 'x-fine-contratto', date: '2026-12-02', label: 'Fine contratto a termine', office: 'amministrazione', about: 'operaio stagionale', writer: 'schedule', writerLabel: 'scadenzario', note: 'Avviso inviato il 02/11.', example: true }, // allow-italian: fixture data, shown as written
  { id: 'x-relazione-ruoli', date: '2026-12-15', label: 'Relazione sui ruoli', office: 'direzione', about: '', writer: 'person', writerLabel: 'a mano', example: true }, // allow-italian: fixture data, shown as written
  { id: 'x-piano-comprensoriale', date: '2026-12-31', label: 'Piano comprensoriale, avvio dei lavori', office: 'tecnico', about: 'L.R. 7/2025 art. 5', writer: 'knowledge', writerLabel: 'Conoscenza', example: true }, // allow-italian: fixture data, shown as written
];

/** The columns of each table, with the words of the sector («Contrib.», «Prot.»). */
export interface ColumnSeed {
  id: string;
  label: string;
  width?: number;
  sortable?: boolean;
  /** Read in the row's side panel, not as a column: the grid beside the panel has no room for it. Export keeps it. */
  panelOnly?: boolean;
}

// Deadline before taxpayer: the table is sorted by it and the last columns are the first to scroll out of a narrow place.
const CASE_COLUMNS: ColumnSeed[] = [
  { id: 'oggetto', label: 'Oggetto', sortable: true }, // allow-italian: fixture data, shown as written
  { id: 'tipo', label: 'Tipo', width: 56, sortable: true }, // allow-italian: fixture data, shown as written
  { id: 'stato', label: 'Stato', width: 120, sortable: true }, // allow-italian: fixture data, shown as written
  { id: 'ufficio', label: 'Ufficio', width: 108, sortable: true, panelOnly: true }, // allow-italian: fixture data, shown as written
  { id: 'scadenza', label: 'Scadenza', width: 92, sortable: true }, // allow-italian: fixture data, shown as written
  { id: 'contribuente', label: 'Contrib.', width: 116, sortable: true }, // allow-italian: fixture data, shown as written
  { id: 'protocollo', label: 'Prot.', width: 76, sortable: true }, // allow-italian: fixture data, shown as written
];

export const TABLE_COLUMNS: Record<string, ColumnSeed[]> = {
  pratiche: CASE_COLUMNS,
  ricorsi: CASE_COLUMNS,
  fatture: CASE_COLUMNS,
  'richieste-irrigue': CASE_COLUMNS,
  concessioni: CASE_COLUMNS,
  contribuenti: [
    { id: 'nome', label: 'Contribuente', sortable: true }, // allow-italian: fixture data, shown as written
    { id: 'codice', label: 'Codice', width: 120, sortable: true }, // allow-italian: fixture data, shown as written
    { id: 'comune', label: 'Comune', width: 168, sortable: true }, // allow-italian: fixture data, shown as written
    { id: 'pratiche', label: 'Pratiche', width: 88, sortable: true }, // allow-italian: fixture data, shown as written
    { id: 'ultima', label: 'Ultima pratica', width: 116, sortable: true }, // allow-italian: fixture data, shown as written
  ],
  canali: [
    { id: 'nome', label: 'Canale o asta', sortable: true }, // allow-italian: fixture data, shown as written
    { id: 'tipo', label: 'Tipo', width: 140, sortable: true }, // allow-italian: fixture data, shown as written
    { id: 'comune', label: 'Comune citato', width: 168, sortable: true }, // allow-italian: fixture data, shown as written
    { id: 'pratiche', label: 'Pratiche', width: 88, sortable: true }, // allow-italian: fixture data, shown as written
    { id: 'fonte', label: 'Fonte', width: 168 }, // allow-italian: fixture data, shown as written
  ],
  fornitori: [
    { id: 'nome', label: 'Fornitore', sortable: true }, // allow-italian: fixture data, shown as written
    { id: 'programma', label: 'Programma', width: 124 }, // allow-italian: fixture data, shown as written
    { id: 'iban', label: 'IBAN', width: 104 },
    { id: 'dal', label: 'Dal', width: 72, sortable: true }, // allow-italian: fixture data, shown as written
    { id: 'fatture', label: 'Fatture', width: 84, sortable: true }, // allow-italian: fixture data, shown as written
    { id: 'anagrafica', label: 'Anagrafica', width: 128, sortable: true }, // allow-italian: fixture data, shown as written
  ],
};

/** The program that holds a taxpayer, a protocol or a supplier, as the cell of the table names it. */
export const PROGRAM_NAME: Record<string, string> = { prunes: 'Prunes', halley: 'Halley', teamsystem: 'TeamSystem' };

export const SUPPLIER_STATE_LABEL = { ok: 'In regola', hold: 'In quarantena' } as const; // allow-italian: fixture data, shown as written

/* ------------------------------------------------------------------ */
/* Fields, rules and calculations (x02)                                 */
/* ------------------------------------------------------------------ */

export type FieldType = 'text' | 'choice' | 'date' | 'computedDate' | 'money' | 'link' | 'person' | 'yesNo' | 'number';
export type FilledBy = 'ai' | 'rule' | 'program' | 'person' | 'pec' | 'flow';
export type RuleKind = 'none' | 'required' | 'format' | 'list' | 'range' | 'notFuture' | 'exists' | 'calc';

export interface FieldSeed {
  id: string;
  label: string;
  type: FieldType;
  /** For a link: the type it points to (`Pratica`, `Contribuente`). */
  linkTo?: string;
  required: boolean;
  rule: {
    kind: RuleKind;
    /** The rule in the words of the sector, as the table prints it. */
    text: string;
    pattern?: string;
    list?: string[];
    min?: number;
  };
  filledBy: FilledBy;
  /** Where in the flow, or which program: «passo a», «Prunes». */
  filledNote?: string;
  editableBy: string;
  /** For a computed date: what it counts from and how. */
  calc?: {
    /** The label of the field or event the term runs from. */
    from: string;
    days: number;
    /** After a Saturday, a Sunday or a holiday the term moves to the next working day. */
    rollsOver: boolean;
    /** The term stops from 1 to 31 August (sospensione feriale). */
    augustPause: boolean;
    /** The norm, e.g. `art. 23 D.Lgs. 546/1992`. */
    norm: string;
    /** Keyword that finds the deadline among a case's deadlines. */
    deadline: string;
    /** `-` counts backwards from the date (memorie: camera di consiglio minus 2 free days). */
    direction: 1 | -1;
  };
  /** Where a row's value comes from, for testing a rule on the example rows. */
  source: string;
}

const f = (seed: FieldSeed): FieldSeed => seed;

export const FIELD_SEEDS: Record<string, FieldSeed[]> = {
  ricorsi: [
    f({ id: 'pratica', label: 'pratica', type: 'link', linkTo: 'Pratica', required: true, rule: { kind: 'exists', text: 'obbligatorio, una sola' }, filledBy: 'flow', filledNote: 'PEC', editableBy: 'nessuno', source: 'case.id' }), // allow-italian: fixture data, shown as written
    f({ id: 'autorita', label: 'autorità', type: 'choice', required: true, rule: { kind: 'list', text: 'TAR · CTP/CGT · Tribunale · Corte d\'appello · Cassazione', list: ['TAR', 'CTP', 'CGT', 'Tribunale', 'Corte d\'appello', 'Cassazione'] }, filledBy: 'ai', filledNote: 'passo a', editableBy: 'Legale', source: 'case.field:autorit' }), // allow-italian: fixture data, shown as written
    f({ id: 'numero-ruolo', label: 'numero di ruolo', type: 'text', required: false, rule: { kind: 'format', text: 'formato NNNN/AAAA', pattern: '^\\d{1,5}/\\d{4}$' }, filledBy: 'ai', filledNote: 'passo a', editableBy: 'Legale', source: 'case.field:ruolo' }), // allow-italian: fixture data, shown as written
    f({ id: 'ricorrente', label: 'ricorrente', type: 'link', linkTo: 'Contribuente', required: true, rule: { kind: 'exists', text: 'se esiste in Prunes' }, filledBy: 'program', filledNote: 'Prunes', editableBy: 'Legale', source: 'case.counterpart' }), // allow-italian: fixture data, shown as written
    f({ id: 'valore-causa', label: 'valore della causa', type: 'money', required: false, rule: { kind: 'range', text: '≥ 0', min: 0 }, filledBy: 'ai', editableBy: 'Legale', source: 'case.amount' }), // allow-italian: fixture data, shown as written
    f({ id: 'notificato-il', label: 'notificato il', type: 'date', required: true, rule: { kind: 'notFuture', text: 'non nel futuro' }, filledBy: 'pec', editableBy: 'nessuno', source: 'case.notified' }), // allow-italian: fixture data, shown as written
    f({ id: 'camera-consiglio', label: 'camera di consiglio', type: 'date', required: false, rule: { kind: 'none', text: 'dal decreto di fissazione' }, filledBy: 'ai', filledNote: 'passo a', editableBy: 'Legale', source: 'case.field:camera' }), // allow-italian: fixture data, shown as written
    f({ id: 'memorie-entro', label: 'memorie entro', type: 'computedDate', required: false, rule: { kind: 'calc', text: 'camera di consiglio − 2 giorni liberi (art. 55 c.5 c.p.a.)' }, filledBy: 'rule', editableBy: 'Legale, con motivo', calc: { from: 'camera di consiglio', days: 2, rollsOver: false, augustPause: false, norm: 'art. 55 c.5 c.p.a.', deadline: 'memorie', direction: -1 }, source: 'case.deadline' }), // allow-italian: fixture data, shown as written
    f({ id: 'costituirsi-entro', label: 'costituirsi entro', type: 'computedDate', required: false, rule: { kind: 'calc', text: 'notificato + 60 gg, sospensione 1-31/8' }, filledBy: 'rule', editableBy: 'Legale, con motivo', calc: { from: 'notificato il', days: 60, rollsOver: true, augustPause: true, norm: 'art. 23 D.Lgs. 546/1992', deadline: 'costituz', direction: 1 }, source: 'case.deadline' }), // allow-italian: fixture data, shown as written
    f({ id: 'legale-incaricato', label: 'legale incaricato', type: 'person', required: false, rule: { kind: 'none', text: 'dall\'albo fornitori' }, filledBy: 'person', editableBy: 'Direzione', source: 'case.assignee' }), // allow-italian: fixture data, shown as written
    f({ id: 'esito', label: 'esito', type: 'choice', required: false, rule: { kind: 'list', text: 'in corso · accolto · respinto · transatto', list: ['in corso', 'accolto', 'respinto', 'transatto'] }, filledBy: 'person', editableBy: 'Legale', source: 'case.outcome' }), // allow-italian: fixture data, shown as written
  ],
  pratiche: [
    f({ id: 'oggetto', label: 'oggetto', type: 'text', required: true, rule: { kind: 'required', text: 'obbligatorio' }, filledBy: 'ai', filledNote: 'passo «Riconosce il tipo»', editableBy: 'tutti', source: 'case.subject' }), // allow-italian: fixture data, shown as written
    f({ id: 'tipo', label: 'tipo', type: 'choice', required: true, rule: { kind: 'list', text: 'uno dei tipi di pratica', list: Object.values(KIND_TYPE).map((t) => t?.letter ?? '') }, filledBy: 'ai', filledNote: 'passo «Riconosce il tipo»', editableBy: 'tutti', source: 'case.type' }), // allow-italian: fixture data, shown as written
    f({ id: 'ufficio', label: 'ufficio', type: 'choice', required: true, rule: { kind: 'required', text: 'dal titolario' }, filledBy: 'rule', filledNote: 'titolario', editableBy: 'tutti', source: 'case.office' }), // allow-italian: fixture data, shown as written
    f({ id: 'protocollo', label: 'protocollo', type: 'link', linkTo: 'Protocollo', required: true, rule: { kind: 'format', text: 'numero di Halley', pattern: '^\\d+(/\\d{4})?$' }, filledBy: 'program', filledNote: 'Halley', editableBy: 'tutti', source: 'case.protocol' }), // allow-italian: fixture data, shown as written
    f({ id: 'contribuente', label: 'contribuente', type: 'link', linkTo: 'Contribuente', required: false, rule: { kind: 'exists', text: 'se c\'è' }, filledBy: 'program', filledNote: 'Prunes', editableBy: 'Ruoli, Legale', source: 'case.counterpart' }), // allow-italian: fixture data, shown as written
    f({ id: 'scadenze', label: 'scadenze', type: 'number', linkTo: 'Scadenza', required: false, rule: { kind: 'none', text: 'regole del percorso' }, filledBy: 'rule', editableBy: 'ufficio, Direzione', source: 'case.deadlines' }), // allow-italian: fixture data, shown as written
    f({ id: 'documenti', label: 'documenti', type: 'number', linkTo: 'Allegato', required: true, rule: { kind: 'range', text: 'almeno uno', min: 1 }, filledBy: 'pec', editableBy: 'ufficio', source: 'case.documents' }), // allow-italian: fixture data, shown as written
    f({ id: 'dati-giudiziari', label: 'dati giudiziari', type: 'yesNo', required: false, rule: { kind: 'none', text: 'sì per il tipo A, cifrati' }, filledBy: 'rule', editableBy: 'Legale, Direzione', source: 'case.judicial' }), // allow-italian: fixture data, shown as written
  ],
  fatture: [
    f({ id: 'fornitore', label: 'fornitore', type: 'link', linkTo: 'Fornitore', required: true, rule: { kind: 'exists', text: 'esiste in TeamSystem' }, filledBy: 'program', filledNote: 'TeamSystem', editableBy: 'Ragioneria', source: 'case.counterpart' }), // allow-italian: fixture data, shown as written
    f({ id: 'numero', label: 'numero', type: 'text', required: true, rule: { kind: 'required', text: 'obbligatorio, unico per fornitore' }, filledBy: 'pec', filledNote: 'SdI', editableBy: 'nessuno', source: 'case.protocol' }), // allow-italian: fixture data, shown as written
    f({ id: 'importo', label: 'importo', type: 'money', required: true, rule: { kind: 'range', text: '> 0 e entro il solito del fornitore', min: 0 }, filledBy: 'pec', filledNote: 'SdI', editableBy: 'nessuno', source: 'case.amount' }), // allow-italian: fixture data, shown as written
    f({ id: 'iban', label: 'IBAN', type: 'text', required: true, rule: { kind: 'format', text: 'cifra di controllo valida, uguale a quello registrato', pattern: '^IT' }, filledBy: 'pec', filledNote: 'SdI', editableBy: 'Ragioneria', source: 'case.none' }), // allow-italian: fixture data, shown as written
    f({ id: 'scadenza-pagamento', label: 'pagamento entro', type: 'computedDate', required: false, rule: { kind: 'calc', text: 'data fattura + 30 giorni (art. 4 D.Lgs. 231/2002)' }, filledBy: 'rule', editableBy: 'Ragioneria, con motivo', calc: { from: 'data fattura', days: 30, rollsOver: false, augustPause: false, norm: 'art. 4 D.Lgs. 231/2002', deadline: 'pagamento', direction: 1 }, source: 'case.deadline' }), // allow-italian: fixture data, shown as written
    f({ id: 'stato-pagamento', label: 'stato del pagamento', type: 'choice', required: false, rule: { kind: 'list', text: 'da registrare · registrata · programmata · pagata', list: ['da registrare', 'registrata', 'programmata', 'pagata'] }, filledBy: 'flow', filledNote: 'fatture', editableBy: 'Ragioneria', source: 'case.none' }), // allow-italian: fixture data, shown as written
  ],
  fornitori: [
    f({ id: 'nome', label: 'ragione sociale', type: 'text', required: true, rule: { kind: 'required', text: 'obbligatoria' }, filledBy: 'program', filledNote: 'TeamSystem', editableBy: 'Ragioneria', source: 'supplier.name' }), // allow-italian: fixture data, shown as written
    f({ id: 'iban', label: 'IBAN', type: 'text', required: true, rule: { kind: 'format', text: 'IBAN italiano, cifra valida, mascherato qui', pattern: '^IT' }, filledBy: 'program', filledNote: 'TeamSystem', editableBy: 'Ragioneria, con motivo', source: 'supplier.iban' }), // allow-italian: fixture data, shown as written
    f({ id: 'dal', label: 'fornitore dal', type: 'number', required: false, rule: { kind: 'range', text: 'anno, dal 2000', min: 2000 }, filledBy: 'program', filledNote: 'TeamSystem', editableBy: 'nessuno', source: 'supplier.since' }), // allow-italian: fixture data, shown as written
  ],
  contribuenti: [
    f({ id: 'codice', label: 'codice', type: 'text', required: true, rule: { kind: 'format', text: 'C- e sette cifre', pattern: '^C-\\d{7}$' }, filledBy: 'program', filledNote: 'Prunes', editableBy: 'nessuno', source: 'taxpayer.code' }), // allow-italian: fixture data, shown as written
    f({ id: 'nome', label: 'contribuente', type: 'text', required: true, rule: { kind: 'required', text: 'obbligatorio' }, filledBy: 'program', filledNote: 'Prunes', editableBy: 'nessuno', source: 'taxpayer.name' }), // allow-italian: fixture data, shown as written
    f({ id: 'comune', label: 'comune', type: 'text', required: false, rule: { kind: 'none', text: 'dei comuni del comprensorio' }, filledBy: 'program', filledNote: 'Prunes', editableBy: 'nessuno', source: 'taxpayer.comune' }), // allow-italian: fixture data, shown as written
  ],
  canali: [
    f({ id: 'nome', label: 'nome', type: 'text', required: true, rule: { kind: 'required', text: 'obbligatorio, unico' }, filledBy: 'person', editableBy: 'Tecnico', source: 'canal.name' }), // allow-italian: fixture data, shown as written
    f({ id: 'tipo', label: 'tipo', type: 'choice', required: true, rule: { kind: 'list', text: 'asta principale · canale · torrente', list: ['Asta principale', 'Canale', 'Torrente'] }, filledBy: 'person', editableBy: 'Tecnico', source: 'canal.kind' }), // allow-italian: fixture data, shown as written
    f({ id: 'comune', label: 'comune citato', type: 'text', required: false, rule: { kind: 'none', text: 'dai documenti' }, filledBy: 'ai', editableBy: 'Tecnico', source: 'canal.comune' }), // allow-italian: fixture data, shown as written
  ],
  concessioni: [
    f({ id: 'richiedente', label: 'richiedente', type: 'link', linkTo: 'Contribuente', required: true, rule: { kind: 'exists', text: 'obbligatorio' }, filledBy: 'ai', editableBy: 'Tecnico', source: 'case.counterpart' }), // allow-italian: fixture data, shown as written
    f({ id: 'canale', label: 'canale', type: 'link', linkTo: 'Canale', required: true, rule: { kind: 'exists', text: 'uno dei canali consortili' }, filledBy: 'ai', filledNote: 'passo a', editableBy: 'Tecnico', source: 'case.canal' }), // allow-italian: fixture data, shown as written
    f({ id: 'ufficio', label: 'ufficio', type: 'choice', required: true, rule: { kind: 'required', text: 'dal titolario' }, filledBy: 'rule', editableBy: 'Direzione', source: 'case.office' }), // allow-italian: fixture data, shown as written
  ],
  'richieste-irrigue': [
    f({ id: 'richiedente', label: 'richiedente', type: 'link', linkTo: 'Contribuente', required: true, rule: { kind: 'exists', text: 'obbligatorio' }, filledBy: 'ai', editableBy: 'Irrigazione', source: 'case.counterpart' }), // allow-italian: fixture data, shown as written
    f({ id: 'comune', label: 'comune', type: 'text', required: false, rule: { kind: 'none', text: 'nei 7 bacini di irrigazione collettiva' }, filledBy: 'ai', editableBy: 'Irrigazione', source: 'case.comune' }), // allow-italian: fixture data, shown as written
    f({ id: 'ufficio', label: 'ufficio', type: 'choice', required: true, rule: { kind: 'required', text: 'dal titolario' }, filledBy: 'rule', editableBy: 'Direzione', source: 'case.office' }), // allow-italian: fixture data, shown as written
  ],
};

/** Who may change a field, as the choices of its panel. */
export const EDITORS = ['nessuno', 'Legale', 'Direzione', 'Ragioneria', 'Tecnico', 'ufficio', 'tutti', 'Legale, con motivo']; // allow-italian: fixture data, shown as written

/* ------------------------------------------------------------------ */
/* Types of data and their links (w04)                                  */
/* ------------------------------------------------------------------ */

export type TypeGroup = 'incoming' | 'organization' | 'programs' | 'territory';

export interface TypeSeed {
  id: string;
  label: string;
  group: TypeGroup;
  fieldKind: 'mail' | 'file' | 'legal' | 'record' | 'number' | 'folder' | 'calendar' | 'person' | 'link' | 'bolt';
  /** What it is, one line. */
  about: string;
  /** Where its rows live: Topics itself or the program that Topics reads. */
  home: string;
  /** A table of the preview that shows its rows, when there is one. */
  table?: string;
  /** Count words as the list prints them; absent: computed or the program name. */
  countText?: string;
  /** How long it is kept, and what is encrypted: only for types that have it. */
  keep?: { period: string; sealed?: string };
  links: Array<{ to: string; how: string }>;
}

export const TYPE_SEEDS: TypeSeed[] = [
  { id: 'pec', label: 'PEC', group: 'incoming', fieldKind: 'mail', about: 'Ogni messaggio arrivato dalla casella certificata.', home: 'PEC Aruba', countText: '1.204/mese, stima', links: [{ to: 'pratica', how: '1 di origine' }, { to: 'allegato', how: 'molti' }] }, // allow-italian: fixture data, shown as written
  { id: 'allegato', label: 'Allegato', group: 'incoming', fieldKind: 'file', about: 'Un file arrivato con un messaggio o scritto da una bozza.', home: 'Topics', countText: '3.870', links: [{ to: 'pratica', how: 'uno solo' }] }, // allow-italian: fixture data, shown as written
  { id: 'pratica', label: 'Pratica', group: 'organization', fieldKind: 'folder', about: 'ogni PEC diventa una pratica', home: 'Topics', table: 'pratiche', keep: { period: '10 anni', sealed: 'cifrati' }, links: [{ to: 'pec', how: '1 di origine' }, { to: 'allegato', how: 'molti' }, { to: 'protocollo', how: '1, in Halley' }, { to: 'contribuente', how: '0 o 1, in Prunes' }, { to: 'scadenza', how: 'molte' }] }, // allow-italian: fixture data, shown as written
  { id: 'scadenza', label: 'Scadenza', group: 'organization', fieldKind: 'calendar', about: 'Un termine con la norma che lo fissa e come è calcolato.', home: 'Topics', links: [{ to: 'pratica', how: 'una sola' }] }, // allow-italian: fixture data, shown as written
  { id: 'ricorso', label: 'Ricorso', group: 'organization', fieldKind: 'legal', about: 'Una pratica di tipo A, con autorità, ruolo e termini di giudizio.', home: 'Topics', table: 'ricorsi', links: [{ to: 'pratica', how: 'è una pratica' }, { to: 'contribuente', how: 'il ricorrente' }] }, // allow-italian: fixture data, shown as written
  { id: 'fattura', label: 'Fattura', group: 'organization', fieldKind: 'number', about: 'Una fattura passiva arrivata dallo SdI.', home: 'Topics', table: 'fatture', links: [{ to: 'fornitore', how: '1' }, { to: 'pratica', how: 'è una pratica' }] }, // allow-italian: fixture data, shown as written
  { id: 'contribuente', label: 'Contribuente', group: 'programs', fieldKind: 'record', about: 'Chi paga il contributo di bonifica: si legge, non si copia.', home: 'Prunes', table: 'contribuenti', links: [{ to: 'pratica', how: 'molte' }, { to: 'particella', how: 'molte' }] }, // allow-italian: fixture data, shown as written
  { id: 'avviso', label: 'Avviso di pagamento', group: 'programs', fieldKind: 'record', about: 'L\'avviso di contributo emesso da Prunes.', home: 'Prunes', links: [{ to: 'contribuente', how: '1' }] }, // allow-italian: fixture data, shown as written
  { id: 'protocollo', label: 'Protocollo', group: 'programs', fieldKind: 'number', about: 'Il numero che Halley dà a ogni atto in entrata e in uscita.', home: 'Halley', links: [{ to: 'pratica', how: 'una' }] }, // allow-italian: fixture data, shown as written
  { id: 'fornitore', label: 'Fornitore', group: 'programs', fieldKind: 'record', about: 'L\'anagrafica di TeamSystem, con l\'IBAN dei pagamenti.', home: 'TeamSystem', table: 'fornitori', links: [{ to: 'fattura', how: 'molte' }] }, // allow-italian: fixture data, shown as written
  { id: 'particella', label: 'Particella', group: 'territory', fieldKind: 'folder', about: 'Foglio e particella del catasto, collegata al canale che la attraversa.', home: 'Prunes e QGIS', links: [{ to: 'contribuente', how: 'uno o più' }, { to: 'canale', how: '0 o 1' }] }, // allow-italian: fixture data, shown as written
  { id: 'canale', label: 'Canale', group: 'territory', fieldKind: 'link', about: 'Un\'asta o un canale della rete idraulica consortile.', home: 'Topics e QGIS', table: 'canali', links: [{ to: 'particella', how: 'molte' }, { to: 'documento', how: 'molti' }] }, // allow-italian: fixture data, shown as written
  { id: 'documento', label: 'Documento', group: 'territory', fieldKind: 'file', about: 'Un atto, un verbale o una tavola che parla di un canale o di una pratica.', home: 'Conoscenza', links: [{ to: 'canale', how: 'molti' }, { to: 'norma', how: 'cita' }] }, // allow-italian: fixture data, shown as written
  { id: 'norma', label: 'Norma', group: 'territory', fieldKind: 'legal', about: 'Un articolo di legge o di regolamento che una pratica o un documento cita.', home: 'Conoscenza', links: [{ to: 'documento', how: 'citata da molti' }] }, // allow-italian: fixture data, shown as written
];

/** The chain the diagram draws, from the case to the norm. */
export const TYPE_CHAIN = ['pratica', 'contribuente', 'particella', 'canale', 'documento', 'norma'];

/** The states of a case, in order: the stepper of the type «Pratica». */
export const CASE_STATES = ['Arrivata', 'Classificata', 'Da confermare', 'Protocollata', 'In lavorazione', 'In attesa', 'Chiusa']; // allow-italian: fixture data, shown as written

/** What the side panel calls a row of the Pratiche table: «Pratica 2418». */
export const CASE_TAG = (id: string) => `Pratica ${id}`; // allow-italian: fixture data, shown as written

/** The button that adds a row to the Pratiche tables. */
export const NEW_CASE_LABEL = 'Nuova pratica'; // allow-italian: fixture data, shown as written

/** The schedule is a table of its own, with its own page. */
export const DEADLINES_TABLE = { id: 'scadenze', label: 'Scadenzario' }; // allow-italian: fixture data, shown as written

/** The offices a row can be given to. */
export const ROW_OFFICES: Office[] = ['protocollo', 'legale', 'catasto', 'tecnico', 'manutenzione', 'ragioneria', 'segreteria', 'irrigazione', 'direzione', 'amministrazione'];

/** The office that usually takes each kind of case. */
export const DEFAULT_OFFICE: Partial<Record<CaseKind, Office>> = {
  ricorso: 'legale', sgravio: 'catasto', concessione: 'tecnico', accesso: 'protocollo', segnalazione: 'manutenzione',
  fattura: 'ragioneria', verbale: 'tecnico', irrigazione: 'irrigazione', regione: 'direzione', send: 'legale',
};

const small = (id: string, label: string, type: FieldType, required: boolean, filledBy: FilledBy, filledNote: string | undefined, ruleText: string, editableBy: string): FieldSeed => ({
  id, label, type, required, rule: { kind: 'none', text: ruleText }, filledBy, filledNote, editableBy, source: 'none',
});

/** Fields of the types that have no table of their own in the preview (w04). */
export const TYPE_FIELDS: Record<string, FieldSeed[]> = {
  pec: [
    small('mittente', 'mittente', 'text', true, 'pec', undefined, 'indirizzo PEC', 'nessuno'), // allow-italian: fixture data, shown as written
    small('oggetto', 'oggetto', 'text', true, 'pec', undefined, 'come scritto dal mittente', 'nessuno'), // allow-italian: fixture data, shown as written
    small('ricevuta', 'ricevuta di consegna', 'date', true, 'pec', 'PEC Aruba', 'data e ora della consegna', 'nessuno'), // allow-italian: fixture data, shown as written
    small('allegati', 'allegati', 'number', false, 'pec', undefined, 'zero o più', 'nessuno'), // allow-italian: fixture data, shown as written
  ],
  allegato: [
    small('nome', 'nome del file', 'text', true, 'pec', undefined, 'come arrivato', 'nessuno'), // allow-italian: fixture data, shown as written
    small('pagine', 'pagine', 'number', false, 'rule', undefined, 'contate alla lettura', 'nessuno'), // allow-italian: fixture data, shown as written
    small('firma', 'firmato', 'yesNo', false, 'rule', undefined, 'firma digitale verificata', 'nessuno'), // allow-italian: fixture data, shown as written
  ],
  scadenza: [
    small('data', 'data', 'computedDate', true, 'rule', undefined, 'evento + giorni, spostata dopo i festivi', 'Legale, con motivo'), // allow-italian: fixture data, shown as written
    small('norma', 'norma', 'text', true, 'rule', undefined, 'l\'articolo che fissa il termine', 'nessuno'), // allow-italian: fixture data, shown as written
    small('ufficio', 'ufficio', 'choice', true, 'rule', undefined, 'dal titolario', 'Direzione'), // allow-italian: fixture data, shown as written
    small('pratica', 'pratica', 'link', true, 'flow', undefined, 'una sola', 'nessuno'), // allow-italian: fixture data, shown as written
  ],
  avviso: [
    small('numero', 'numero', 'text', true, 'program', 'Prunes', 'anno/codice/progressivo', 'nessuno'), // allow-italian: fixture data, shown as written
    small('importo', 'importo', 'money', true, 'program', 'Prunes', '≥ 0', 'nessuno'), // allow-italian: fixture data, shown as written
  ],
  protocollo: [
    small('numero', 'numero', 'text', true, 'program', 'Halley', 'anno/progressivo', 'nessuno'), // allow-italian: fixture data, shown as written
    small('data', 'data', 'date', true, 'program', 'Halley', 'non nel futuro', 'nessuno'), // allow-italian: fixture data, shown as written
    small('fascicolo', 'fascicolo', 'text', false, 'program', 'Halley', 'dal titolario', 'Protocollo'), // allow-italian: fixture data, shown as written
  ],
  particella: [
    small('comune', 'comune', 'text', true, 'program', 'Prunes', 'comune del comprensorio', 'nessuno'), // allow-italian: fixture data, shown as written
    small('foglio', 'foglio', 'text', true, 'program', 'Prunes', 'catasto', 'nessuno'), // allow-italian: fixture data, shown as written
    small('particella', 'particella', 'text', true, 'program', 'Prunes', 'catasto', 'nessuno'), // allow-italian: fixture data, shown as written
  ],
  documento: [
    small('titolo', 'titolo', 'text', true, 'person', undefined, 'obbligatorio', 'Segreteria'), // allow-italian: fixture data, shown as written
    small('tipo', 'tipo di atto', 'choice', true, 'ai', undefined, 'verbale, tavola, delibera, contratto', 'Segreteria'), // allow-italian: fixture data, shown as written
  ],
  norma: [
    small('riferimento', 'riferimento', 'text', true, 'person', undefined, 'legge e articolo', 'Legale'), // allow-italian: fixture data, shown as written
    small('vigente', 'in vigore', 'yesNo', true, 'person', undefined, 'sì finché non è abrogata', 'Legale'), // allow-italian: fixture data, shown as written
  ],
};
