/**
 * Fixture of w07, s03 and s04: SARIM, the second example organization.
 * Facts come from the training questionnaire of 26-28/10 (14 answers): the
 * areas (Contabilità, Personale, Customer service, Tecnica), the programs (allow-italian: quotes the Italian interface)
 * (Excel, Word, PEC, SAP, Enviro, WinWaste, Zucchetti, the tender portals) and
 * the repetitive activities (AMA and private-user reports, FIR/RENTRI, the
 * leaves service report, supplier invoices, fixed-term deadlines, tender
 * screening). Volumes, addresses, callers and times are examples; volumes say
 * «stima». Counts that other screens print are computed from these lists.
 */
import type { FlowModel, FlowPathModel, FlowStepModel } from '../flows/model';
import type { CollectedDataModel } from '../flows/model';

/* ---------- flows ---------- */

export interface SarimFlowSeed {
  id: string;
  name: string;
  /** The area of the questionnaire that owns it. */
  area: string;
  /** What starts it, in plain words. */
  trigger: string;
  version: number;
  /** Items per month, an estimate. For the report flow it is the sum of its paths. */
  perMonth: number;
  /** Share decided by a person, 0..100, an estimate. */
  toPerson: number;
  errors: number;
  /** Minutes a person spent by hand per item, declared in the questionnaire: an estimate. */
  manualMinutes: number;
  /** Items waiting for a person in a place that is not the call center queue. */
  stuck?: { place: string; count: number };
}

/** The five paths of the report flow with their monthly volumes (they sum to the flow's volume). */
export const REPORTS_PATH_VOLUMES: Record<string, number> = { pA: 540, pB: 310, pC: 220, pD: 190, pE: 152 };

/** Thousands with a dot, as Italian writes them. */
const dots = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const sumPaths = Object.values(REPORTS_PATH_VOLUMES).reduce((a, b) => a + b, 0);

export const SARIM_FLOWS: SarimFlowSeed[] = [
  { id: 'sarim-segnalazioni', name: 'Segnalazioni AMA e utenze → intervento', area: 'Customer service', trigger: 'arriva una segnalazione (mail AMA, portale utenze, telefonata)', version: 2, perMonth: sumPaths, toPerson: 31, errors: 3, manualMinutes: 4 }, // allow-italian: fixture data, shown as written
  { id: 'sarim-fatture', name: 'Fattura passiva → riconciliazione', area: 'Contabilità', trigger: 'arriva una fattura dal fornitore', version: 1, perMonth: 240, toPerson: 7, errors: 1, manualMinutes: 9, stuck: { place: 'Contabilità', count: 3 } }, // allow-italian: fixture data, shown as written
  { id: 'sarim-fir', name: 'Formulario FIR → registrazione', area: 'Customer service', trigger: 'si chiude un ritiro con formulario', version: 1, perMonth: 180, toPerson: 4, errors: 0, manualMinutes: 6 }, // allow-italian: fixture data, shown as written
  { id: 'sarim-scadenze', name: 'Scadenze tempi determinati', area: 'Personale', trigger: 'ogni lunedì mattina', version: 1, perMonth: 48, toPerson: 100, errors: 0, manualMinutes: 15 }, // allow-italian: fixture data, shown as written
  { id: 'sarim-foglie', name: 'Rendiconto servizio foglie', area: 'Customer service', trigger: 'a fine mese', version: 1, perMonth: 1, toPerson: 0, errors: 0, manualMinutes: 240 }, // allow-italian: fixture data, shown as written
  { id: 'sarim-gara', name: 'Gara → valutazione preliminare', area: 'Tecnica', trigger: 'una nuova gara sul portale', version: 1, perMonth: 6, toPerson: 100, errors: 0, manualMinutes: 160, stuck: { place: 'Tecnica', count: 1 } }, // allow-italian: fixture data, shown as written
];

/** The flow whose paths the overview counts as «doppioni evitati». */
export const DUPLICATE_PATH_ID = 'pE';

/* ---------- the report flow, as steps and paths (w07) ---------- */

const F = {
  segnalazione: { kind: 'mail', name: 'Segnalazione' }, // allow-italian: fixture data, shown as written
  foto: { kind: 'file', name: 'Foto' }, // allow-italian: fixture data, shown as written
  indirizzo: { kind: 'record', name: 'Indirizzo' }, // allow-italian: fixture data, shown as written
  tipo: { kind: 'folder', name: 'Tipo di servizio' }, // allow-italian: fixture data, shown as written
  urgenza: { kind: 'folder', name: 'Urgenza' }, // allow-italian: fixture data, shown as written
  aperti: { kind: 'number', name: 'Servizi aperti' }, // allow-italian: fixture data, shown as written
  turno: { kind: 'number', name: 'Turno' }, // allow-italian: fixture data, shown as written
  mezzo: { kind: 'number', name: 'Mezzo' }, // allow-italian: fixture data, shown as written
  ordine: { kind: 'file', name: 'Ordine SAP' }, // allow-italian: fixture data, shown as written
  fir: { kind: 'legal', name: 'FIR' },
  rendiconto: { kind: 'file', name: 'Rendiconto' }, // allow-italian: fixture data, shown as written
  collegata: { kind: 'link', name: 'Segnalazione collegata' }, // allow-italian: fixture data, shown as written
} as const;

const step = (s: FlowStepModel): FlowStepModel => s;

const PATH_A: FlowPathModel = {
  id: 'pA', letter: 'A', kind: 'folder', expanded: true,
  title: 'Ingombranti', // allow-italian: fixture data, shown as written
  meta: `${REPORTS_PATH_VOLUMES.pA} al mese · Call center`, // allow-italian: fixture data, shown as written
  steps: [
    step({ id: 'a', marker: 'a', actors: [{ kind: 'rule' }], title: 'Propone turno e mezzo del cantiere di zona', produces: [F.turno, F.mezzo] }), // allow-italian: fixture data, shown as written
    step({ id: 'b', marker: 'b', actors: [{ kind: 'person' }], title: 'Il call center conferma', due: 'entro 2 h', opens: 'Call center' }), // allow-italian: fixture data, shown as written
    step({ id: 'c', marker: 'c', actors: [{ kind: 'program', name: 'SAP', tone: 'blue' }], title: "Apre l'ordine di servizio", produces: [F.ordine] }), // allow-italian: fixture data, shown as written
    step({ id: 'd', marker: 'd', actors: [{ kind: 'ai' }], title: 'Avvisa il cliente con la data' }), // allow-italian: fixture data, shown as written
  ],
};

const PATH_B: FlowPathModel = {
  id: 'pB', letter: 'B', kind: 'calendar',
  title: 'Mancato ritiro', // allow-italian: fixture data, shown as written
  meta: `${REPORTS_PATH_VOLUMES.pB} al mese · priorità alta · 4 passi`, // allow-italian: fixture data, shown as written
  steps: [
    step({ id: 'a', marker: 'a', actors: [{ kind: 'rule' }], title: 'Mette priorità alta e cerca il mezzo più vicino al giro saltato', produces: [F.turno, F.mezzo] }), // allow-italian: fixture data, shown as written
    step({ id: 'b', marker: 'b', actors: [{ kind: 'person' }], title: 'Il call center conferma il recupero', due: 'entro 1 h', opens: 'Call center' }), // allow-italian: fixture data, shown as written
    step({ id: 'c', marker: 'c', actors: [{ kind: 'program', name: 'WinWaste', tone: 'green' }], title: 'Aggiunge il giro di recupero' }), // allow-italian: fixture data, shown as written
    step({ id: 'd', marker: 'd', actors: [{ kind: 'ai' }], title: 'Avvisa il cliente con la nuova data' }), // allow-italian: fixture data, shown as written
  ],
};

const PATH_C: FlowPathModel = {
  id: 'pC', letter: 'C', kind: 'file',
  title: 'Abbandono di rifiuti', // allow-italian: fixture data, shown as written
  meta: `${REPORTS_PATH_VOLUMES.pC} al mese · foto obbligatoria · FIR`, // allow-italian: fixture data, shown as written
  steps: [
    step({ id: 'a', marker: 'a', actors: [{ kind: 'rule' }], title: 'Controlla che ci sia la foto, altrimenti la chiede', uses: [F.foto] }), // allow-italian: fixture data, shown as written
    step({ id: 'b', marker: 'b', actors: [{ kind: 'ai' }], title: 'Riconosce il tipo di rifiuto dalla foto', produces: [F.tipo] }), // allow-italian: fixture data, shown as written
    step({ id: 'c', marker: 'c', actors: [{ kind: 'program', name: 'Enviro', tone: 'green' }], title: 'Prepara il formulario di identificazione', produces: [F.fir] }), // allow-italian: fixture data, shown as written
    step({ id: 'd', marker: 'd', actors: [{ kind: 'person' }], title: 'Il responsabile controlla e firma il FIR', due: 'entro 4 h', opens: 'Call center' }), // allow-italian: fixture data, shown as written
  ],
};

const PATH_D: FlowPathModel = {
  id: 'pD', letter: 'D', kind: 'calendar',
  title: 'Servizio foglie', // allow-italian: fixture data, shown as written
  meta: `${REPORTS_PATH_VOLUMES.pD} al mese · rendiconto ad AMA`, // allow-italian: fixture data, shown as written
  steps: [
    step({ id: 'a', marker: 'a', actors: [{ kind: 'rule' }], title: 'Assegna la zona al servizio foglie del comune', uses: [F.indirizzo] }), // allow-italian: fixture data, shown as written
    step({ id: 'b', marker: 'b', actors: [{ kind: 'person' }], title: 'Il call center conferma il passaggio', due: 'entro 4 h', opens: 'Call center' }), // allow-italian: fixture data, shown as written
    step({ id: 'c', marker: 'c', actors: [{ kind: 'program', name: 'WinWaste', tone: 'green' }], title: 'Registra il passaggio della squadra' }), // allow-italian: fixture data, shown as written
    step({ id: 'd', marker: 'd', actors: [{ kind: 'ai' }], title: 'Aggiunge la riga al rendiconto del mese', produces: [F.rendiconto] }), // allow-italian: fixture data, shown as written
  ],
};

const PATH_E: FlowPathModel = {
  id: 'pE', letter: 'E', kind: 'link',
  title: 'Doppione', // allow-italian: fixture data, shown as written
  meta: `${REPORTS_PATH_VOLUMES.pE} al mese · collega e avvisa`, // allow-italian: fixture data, shown as written
  steps: [
    step({ id: 'a', marker: 'a', actors: [{ kind: 'rule' }], title: 'Collega alla segnalazione già aperta, senza un nuovo servizio', produces: [F.collegata] }), // allow-italian: fixture data, shown as written
    step({ id: 'b', marker: 'b', actors: [{ kind: 'ai' }], title: 'Avvisa il cliente che è già in carico' }), // allow-italian: fixture data, shown as written
  ],
};

export const REPORTS_PATHS: FlowPathModel[] = [PATH_A, PATH_B, PATH_C, PATH_D, PATH_E];

/** What the side panel lists for each path (and for the flow before any path is open). */
export const REPORTS_COLLECTED: Record<string, CollectedDataModel> = {
  base: {
    tag: 'Dati del servizio', // allow-italian: fixture data, shown as written
    title: 'Cosa si raccoglie, prima del tipo', // allow-italian: fixture data, shown as written
    description: 'Quello che ogni segnalazione porta con sé, da qualunque canale arrivi.', // allow-italian: fixture data, shown as written
    sections: [
      { label: 'Dalla segnalazione', rows: [ // allow-italian: fixture data, shown as written
        { field: F.segnalazione, label: 'canale', value: 'mail AMA' }, // allow-italian: fixture data, shown as written
        { label: 'ricevuta', value: 'oggi 10:26' }, // allow-italian: fixture data, shown as written
      ] },
      { label: 'Passo 1', rows: [ // allow-italian: fixture data, shown as written
        { field: F.indirizzo, label: 'via', value: 'Via Roma 12, Salerno (esempio)' }, // allow-italian: fixture data, shown as written
        { field: { kind: 'folder', name: 'Tipo' }, label: 'rifiuto', value: 'ingombranti' }, // allow-italian: fixture data, shown as written
      ] },
    ],
    access: { label: 'Chi legge', value: 'Call center, Tecnica' }, // allow-italian: fixture data, shown as written
  },
  pA: {
    tag: 'Dati del servizio', // allow-italian: fixture data, shown as written
    title: 'Cosa si raccoglie, percorso A', // allow-italian: fixture data, shown as written
    description: 'Ingombranti: il turno e il mezzo si propongono da soli, il call center conferma.', // allow-italian: fixture data, shown as written
    sections: [
      { label: 'Dalla segnalazione', rows: [ // allow-italian: fixture data, shown as written
        { field: F.segnalazione, label: 'canale', value: 'mail AMA' }, // allow-italian: fixture data, shown as written
        { label: 'ricevuta', value: 'oggi 10:26' }, // allow-italian: fixture data, shown as written
      ] },
      { label: 'Passo 1', rows: [ // allow-italian: fixture data, shown as written
        { field: F.indirizzo, label: 'via', value: 'Via Roma 12, Salerno (esempio)' }, // allow-italian: fixture data, shown as written
        { field: { kind: 'folder', name: 'Tipo' }, label: 'rifiuto', value: 'ingombranti' }, // allow-italian: fixture data, shown as written
      ] },
      { label: 'Passo a', rows: [ // allow-italian: fixture data, shown as written
        { field: F.turno, label: 'giorno', value: 'giovedì 12/11' }, // allow-italian: fixture data, shown as written
        { field: F.mezzo, label: 'tipo', value: 'costipatore 7,5 t' }, // allow-italian: fixture data, shown as written
      ] },
      { label: 'Passo c', rows: [ // allow-italian: fixture data, shown as written
        { field: F.ordine, label: 'numero', value: '4500182231 (esempio)' }, // allow-italian: fixture data, shown as written
      ] },
    ],
    access: { label: 'Chi legge', value: 'Call center' }, // allow-italian: fixture data, shown as written
  },
  pB: {
    tag: 'Dati del servizio', // allow-italian: fixture data, shown as written
    title: 'Cosa si raccoglie, percorso B', // allow-italian: fixture data, shown as written
    description: 'Mancato ritiro: priorità alta, il giro saltato diventa un recupero.', // allow-italian: fixture data, shown as written
    sections: [
      { label: 'Passo a', rows: [ // allow-italian: fixture data, shown as written
        { field: { kind: 'number', name: 'Priorità' }, label: 'livello', value: 'alta' }, // allow-italian: fixture data, shown as written
        { field: F.mezzo, label: 'tipo', value: 'il mezzo del giro saltato' }, // allow-italian: fixture data, shown as written
      ] },
      { label: 'Passo c', rows: [{ field: F.turno, label: 'recupero', value: 'giorno dopo, prima mattina' }] }, // allow-italian: fixture data, shown as written
    ],
    access: { label: 'Chi legge', value: 'Call center' }, // allow-italian: fixture data, shown as written
  },
  pC: {
    tag: 'Dati del servizio', // allow-italian: fixture data, shown as written
    title: 'Cosa si raccoglie, percorso C', // allow-italian: fixture data, shown as written
    description: 'Abbandono di rifiuti: la foto è obbligatoria, il FIR segue il tipo di rifiuto.', // allow-italian: fixture data, shown as written
    sections: [
      { label: 'Passo a', rows: [{ field: F.foto, label: 'foto', value: 'obbligatoria' }] }, // allow-italian: fixture data, shown as written
      { label: 'Passo b', rows: [{ field: F.tipo, label: 'rifiuto', value: 'riconosciuto dalla foto' }] }, // allow-italian: fixture data, shown as written
      { label: 'Passo c', rows: [{ field: F.fir, label: 'formulario', value: 'caricato su RENTRI' }] }, // allow-italian: fixture data, shown as written
    ],
    access: { label: 'Chi legge', value: 'Customer service, Tecnica' }, // allow-italian: fixture data, shown as written
  },
  pD: {
    tag: 'Dati del servizio', // allow-italian: fixture data, shown as written
    title: 'Cosa si raccoglie, percorso D', // allow-italian: fixture data, shown as written
    description: 'Servizio foglie: ogni passaggio finisce nel rendiconto mensile per AMA.', // allow-italian: fixture data, shown as written
    sections: [
      { label: 'Passo a', rows: [{ field: F.indirizzo, label: 'zona', value: 'della squadra del comune' }] }, // allow-italian: fixture data, shown as written
      { label: 'Passo d', rows: [{ field: F.rendiconto, label: 'riga', value: 'una per passaggio' }] }, // allow-italian: fixture data, shown as written
    ],
    access: { label: 'Chi legge', value: 'Customer service' }, // allow-italian: fixture data, shown as written
  },
  pE: {
    tag: 'Dati del servizio', // allow-italian: fixture data, shown as written
    title: 'Cosa si raccoglie, percorso E', // allow-italian: fixture data, shown as written
    description: 'Doppione: stesso indirizzo entro 50 m negli ultimi 7 giorni, si collega e non si apre un nuovo servizio.', // allow-italian: fixture data, shown as written
    sections: [
      { label: 'Passo a', rows: [{ field: F.collegata, label: 'collegata a', value: 'la segnalazione già aperta' }] }, // allow-italian: fixture data, shown as written
    ],
    access: { label: 'Chi legge', value: 'Call center' }, // allow-italian: fixture data, shown as written
  },
};

export const REPORTS_FLOW: FlowModel = {
  crumbs: [{ label: 'Flussi' }, { label: 'Quando arriva una segnalazione di servizio' }], // allow-italian: fixture data, shown as written
  status: { text: 'Attivo · v2', tone: 'green' }, // allow-italian: fixture data, shown as written
  trigger: {
    id: 'trigger', actors: [{ kind: 'trigger' }],
    title: 'Arriva una segnalazione', // allow-italian: fixture data, shown as written
    note: `${dots(sumPaths)} al mese, stima · mail AMA · portale utenze · telefonata`, // allow-italian: fixture data, shown as written
    produces: [F.segnalazione, F.foto],
  },
  steps: [
    step({ id: 's1', marker: '1', actors: [{ kind: 'ai' }], title: 'Estrae indirizzo, tipo di rifiuto, urgenza', produces: [F.indirizzo, F.tipo, F.urgenza] }), // allow-italian: fixture data, shown as written
    step({ id: 's2', marker: '2', actors: [{ kind: 'rule' }], title: 'Cerca doppioni negli ultimi 7 giorni', note: 'stesso indirizzo entro 50 m', uses: [F.indirizzo, F.aperti] }), // allow-italian: fixture data, shown as written
  ],
  branch: { marker: '3', count: 5, paths: REPORTS_PATHS },
  collected: REPORTS_COLLECTED.base,
};

/** The step after the branch: it runs for every report, whatever the type. */
export const REPORTS_AFTER = {
  marker: '4',
  title: 'Foglio cantieri aggiornato, Registro, rendiconto mensile', // allow-italian: fixture data, shown as written
};

/* ---------- the other flows, as steps (no branch) ---------- */

interface PlainFlow {
  model: Omit<FlowModel, 'branch'>;
}

const collected = (title: string, description: string, rows: Array<[FlowStepModel['produces'] extends infer T ? T : never, string, string]>): CollectedDataModel => ({
  tag: 'Dati del servizio', // allow-italian: fixture data, shown as written
  title,
  description,
  sections: [{ label: 'Cosa si raccoglie', rows: rows.map(([f, label, value]) => ({ field: f?.[0], label, value })) }], // allow-italian: fixture data, shown as written
  access: { label: 'Chi legge', value: 'Customer service' }, // allow-italian: fixture data, shown as written
});

export const PLAIN_FLOWS: Record<string, PlainFlow> = {
  'sarim-scadenze': {
    model: {
      crumbs: [{ label: 'Flussi' }, { label: 'Ogni lunedì: scadenze dei tempi determinati' }], // allow-italian: fixture data, shown as written
      status: { text: 'Attivo · v1', tone: 'green' }, // allow-italian: fixture data, shown as written
      trigger: { id: 'trigger', actors: [{ kind: 'trigger' }], title: 'Ogni lunedì mattina', note: '48 al mese, stima', produces: [{ kind: 'calendar', name: 'Scadenze' }] }, // allow-italian: fixture data, shown as written
      steps: [
        step({ id: 's1', marker: '1', actors: [{ kind: 'program', name: 'Zucchetti', tone: 'blue' }], title: 'Legge i contratti a tempo determinato' }), // allow-italian: fixture data, shown as written
        step({ id: 's2', marker: '2', actors: [{ kind: 'rule' }], title: 'Calcola le scadenze entro 60 giorni', produces: [{ kind: 'calendar', name: 'Scadenza' }] }), // allow-italian: fixture data, shown as written
        step({ id: 's3', marker: '3', actors: [{ kind: 'person' }], title: 'Il Personale decide: rinnovo, proroga o chiusura', due: 'entro 3 gg' }), // allow-italian: fixture data, shown as written
      ],
      collected: collected('Cosa si raccoglie', 'Le scadenze e la decisione che le chiude.', [[[{ kind: 'calendar', name: 'Scadenza' }], 'data', 'dal contratto']]), // allow-italian: fixture data, shown as written
    },
  },
  'sarim-foglie': {
    model: {
      crumbs: [{ label: 'Flussi' }, { label: 'A fine mese: rendiconto del servizio foglie' }], // allow-italian: fixture data, shown as written
      status: { text: 'Attivo · v1', tone: 'green' }, // allow-italian: fixture data, shown as written
      trigger: { id: 'trigger', actors: [{ kind: 'trigger' }], title: 'A fine mese', note: '1 al mese', produces: [{ kind: 'file', name: 'Rendiconto' }] }, // allow-italian: fixture data, shown as written
      steps: [
        step({ id: 's1', marker: '1', actors: [{ kind: 'program', name: 'WinWaste', tone: 'green' }], title: 'Raccoglie i passaggi del mese' }), // allow-italian: fixture data, shown as written
        step({ id: 's2', marker: '2', actors: [{ kind: 'ai' }], title: 'Compone il rendiconto per zona e lo confronta con i passaggi previsti' }), // allow-italian: fixture data, shown as written
        step({ id: 's3', marker: '3', actors: [{ kind: 'rule' }], title: 'Lo invia ad AMA e lo archivia' }), // allow-italian: fixture data, shown as written
      ],
      collected: collected('Cosa si raccoglie', 'Un rendiconto al mese, composto dai passaggi.', [[[{ kind: 'file', name: 'Rendiconto' }], 'rendiconto', 'uno al mese']]), // allow-italian: fixture data, shown as written
    },
  },
  'sarim-gara': {
    model: {
      crumbs: [{ label: 'Flussi' }, { label: 'Quando esce una nuova gara' }], // allow-italian: fixture data, shown as written
      status: { text: 'Attivo · v1', tone: 'green' }, // allow-italian: fixture data, shown as written
      trigger: { id: 'trigger', actors: [{ kind: 'trigger' }], title: 'Esce una nuova gara su un portale', note: '6 al mese, stima', produces: [{ kind: 'file', name: 'Bando' }] }, // allow-italian: fixture data, shown as written
      steps: [
        step({ id: 's1', marker: '1', actors: [{ kind: 'ai' }], title: 'Legge il bando: oggetto, importo, scadenza, requisiti', produces: [{ kind: 'calendar', name: 'Scadenza' }] }), // allow-italian: fixture data, shown as written
        step({ id: 's2', marker: '2', actors: [{ kind: 'person' }], title: 'La Tecnica fa la valutazione preliminare', due: 'entro 2 gg' }), // allow-italian: fixture data, shown as written
      ],
      collected: collected('Cosa si raccoglie', 'I dati del bando per decidere se partecipare.', [[[{ kind: 'calendar', name: 'Scadenza' }], 'scadenza', 'dal bando']]), // allow-italian: fixture data, shown as written
    },
  },
};

/* ---------- the call center (s03) ---------- */

export type QueueTone = 'neutral' | 'amber' | 'red';

export interface QueueItemSeed {
  id: string;
  title: string;
  /** One line under the title. */
  summary: string;
  chip: { text: string; tone: QueueTone };
  /** Minutes since it arrived; «scaduta» when overdue. */
  ageMin: number;
  overdue?: boolean;
  /** What the customer asked, with where it came from. */
  asked: { text: string; source: string };
  /** The proposed service, each field editable. */
  service: { turn: string; site: string; vehicle: string; notice: string };
  /** What was already checked. */
  checked: string[];
  /** The receipt after confirmation (the example order). */
  order: string;
}

/** The four items of the queue (the number the overview shows as «Call center»). */
export const QUEUE: QueueItemSeed[] = [
  {
    id: 'q-ingombranti', title: 'Ingombranti, Via Roma 12, Salerno (esempio)', // allow-italian: fixture data, shown as written
    summary: 'Proposta: giovedì mattina, Salerno Est', chip: { text: 'mail AMA', tone: 'neutral' }, ageMin: 4, // allow-italian: fixture data, shown as written
    asked: { text: "Ritiro di un divano e due materassi davanti al civico 12, segnalato da AMA per conto dell'utente. Nessuna urgenza indicata.", source: 'mail AMA 10:26' }, // allow-italian: fixture data, shown as written
    service: { turn: 'giovedì 12/11, mattina', site: 'Salerno Est', vehicle: 'costipatore 7,5 t', notice: 'mail ad AMA + SMS' }, // allow-italian: fixture data, shown as written
    checked: ['Nessun doppione negli ultimi 7 giorni', 'il turno di giovedì ha ancora 6 posti', 'indirizzo trovato nello stradario'], // allow-italian: fixture data, shown as written
    order: '4500182231',
  },
  {
    id: 'q-foglie', title: 'Foglie, Viale Europa, Pontecagnano (esempio)', // allow-italian: fixture data, shown as written
    summary: 'Possibile doppione di ieri', chip: { text: 'doppione?', tone: 'amber' }, ageMin: 12, // allow-italian: fixture data, shown as written
    asked: { text: 'Foglie e ramaglie sul marciapiede di Viale Europa, davanti al civico 40. Una segnalazione simile era arrivata ieri.', source: 'portale utenze 09:33' }, // allow-italian: fixture data, shown as written
    service: { turn: 'venerdì 13/11, mattina', site: 'Pontecagnano', vehicle: 'squadra foglie', notice: 'SMS' }, // allow-italian: fixture data, shown as written
    checked: ['Un servizio aperto ieri a meno di 50 m: da collegare o no', "l'indirizzo è nello stradario"], // allow-italian: fixture data, shown as written
    order: '4500182232',
  },
  {
    id: 'q-sfalci', title: 'Utenza privata, ritiro sfalci (esempio)', // allow-italian: fixture data, shown as written
    summary: 'Indirizzo non trovato nello stradario', chip: { text: 'fiducia 62%', tone: 'amber' }, ageMin: 30, // allow-italian: fixture data, shown as written
    asked: { text: 'Sfalci di giardino da ritirare, la persona indica «la traversa dopo il ponte». Il civico non è chiaro.', source: 'telefonata 09:15' }, // allow-italian: fixture data, shown as written
    service: { turn: 'lunedì 16/11, mattina', site: 'da assegnare', vehicle: 'costipatore 7,5 t', notice: 'telefonata' }, // allow-italian: fixture data, shown as written
    checked: ['Indirizzo non trovato nello stradario: serve richiamare', 'nessun doppione negli ultimi 7 giorni'], // allow-italian: fixture data, shown as written
    order: '4500182233',
  },
  {
    id: 'q-fir', title: 'FIR mancante, cantiere Battipaglia (esempio)', // allow-italian: fixture data, shown as written
    summary: 'Formulario non caricato su RENTRI', chip: { text: 'RENTRI', tone: 'red' }, ageMin: 190, overdue: true, // allow-italian: fixture data, shown as written
    asked: { text: 'Il ritiro del cantiere è chiuso ma il formulario non risulta caricato su RENTRI.', source: 'WinWaste 06:20' }, // allow-italian: fixture data, shown as written
    service: { turn: 'oggi, entro le 14', site: 'Battipaglia', vehicle: 'nessun mezzo: carica Enviro', notice: 'mail al responsabile' }, // allow-italian: fixture data, shown as written
    checked: ['La pesata esiste in WinWaste', 'il formulario è pronto in Enviro, manca la firma'], // allow-italian: fixture data, shown as written
    order: '4500182234',
  },
];

/** Turns a person can pick for «Cambia turno». */
export const TURN_CHOICES = ['giovedì 12/11, mattina', 'giovedì 12/11, pomeriggio', 'venerdì 13/11, mattina', 'lunedì 16/11, mattina']; // allow-italian: fixture data, shown as written

/** The street index the address check searches (an example: the real one is the municipality's). */
export const STREET_INDEX: Array<{ street: string; city: string; max: number }> = [
  { street: 'Via Roma', city: 'Salerno', max: 120 },
  { street: 'Via dei Mille', city: 'Salerno', max: 64 }, // allow-italian: fixture data, shown as written
  { street: 'Viale Europa', city: 'Pontecagnano', max: 90 }, // allow-italian: fixture data, shown as written
  { street: 'Via Verdi', city: 'Battipaglia', max: 48 }, // allow-italian: fixture data, shown as written
  { street: 'Via Mazzini', city: 'Salerno', max: 80 }, // allow-italian: fixture data, shown as written
];

export type CallField = 'kind' | 'street' | 'number' | 'city' | 'urgency' | 'contact';

export interface TranscriptLine {
  who: 'operator' | 'caller';
  text: string;
  /** What the AI fills in the form once this line is heard. */
  fills?: Partial<Record<CallField, string>>;
}

export interface CallSeed {
  id: string;
  /** Always an example, and labelled so. */
  caller: string;
  /** «oggi 10:21». */
  at: string;
  seconds: number;
  transcript: TranscriptLine[];
  /** The ticket it ended in, for a call already handled. */
  ticket?: string;
}

/** The call ringing now: the one the screen lets the operator answer. */
export const INCOMING_CALL: CallSeed = {
  id: 'c-incoming', caller: 'Utente privato (esempio)', at: 'ora', seconds: 0, // allow-italian: fixture data, shown as written
  transcript: [
    { who: 'operator', text: 'Buongiorno, servizio ambiente, come posso aiutarla?' }, // allow-italian: fixture data, shown as written
    { who: 'caller', text: 'Buongiorno, avrei un divano da far ritirare, ingombranti.', fills: { kind: 'Ingombranti' } }, // allow-italian: fixture data, shown as written
    { who: 'operator', text: 'Certo. Mi dice via e numero civico?' }, // allow-italian: fixture data, shown as written
    { who: 'caller', text: 'Via dei Mille 8, a Salerno.', fills: { street: 'Via dei Mille', number: '8', city: 'Salerno' } }, // allow-italian: fixture data, shown as written
    { who: 'operator', text: 'Il divano è già fuori dal portone?' }, // allow-italian: fixture data, shown as written
    { who: 'caller', text: 'Sì, da stamattina, sul marciapiede. Se potete passare presto meglio.', fills: { urgency: 'normale, entro la settimana' } }, // allow-italian: fixture data, shown as written
    { who: 'operator', text: 'Un recapito per avvisarla del giorno?' }, // allow-italian: fixture data, shown as written
    { who: 'caller', text: 'Mandate pure un SMS a questo numero.', fills: { contact: 'SMS al numero della chiamata' } }, // allow-italian: fixture data, shown as written
  ],
};

export const FIELD_ORDER: CallField[] = ['kind', 'street', 'number', 'city', 'urgency', 'contact'];

/** Calls already handled, newest first. The ticket points at a queue item or a created ticket. */
export const RECENT_CALLS: CallSeed[] = [
  {
    id: 'c-1', caller: 'Utente privato (esempio)', at: 'oggi 10:02', seconds: 140, ticket: 'q-sfalci', // allow-italian: fixture data, shown as written
    transcript: [
      { who: 'caller', text: 'Devo far ritirare degli sfalci, abito nella traversa dopo il ponte.', fills: { kind: 'Sfalci' } }, // allow-italian: fixture data, shown as written
      { who: 'operator', text: 'Mi dice il civico?' }, // allow-italian: fixture data, shown as written
      { who: 'caller', text: 'Non ricordo il numero, ma conosco il vicino.', fills: { urgency: 'non indicata' } }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'c-2', caller: 'Cantiere di Battipaglia (esempio)', at: 'oggi 09:48', seconds: 95, ticket: 'q-fir', // allow-italian: fixture data, shown as written
    transcript: [
      { who: 'caller', text: 'Il camion è ripartito ma il formulario non è partito per RENTRI.', fills: { kind: 'FIR mancante' } }, // allow-italian: fixture data, shown as written
      { who: 'operator', text: 'Controllo subito la pesata.' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'c-3', caller: 'Utente privato (esempio)', at: 'ieri 16:40', seconds: 70, // allow-italian: fixture data, shown as written
    transcript: [
      { who: 'caller', text: 'Volevo sapere quando passate per le foglie in Viale Europa.', fills: { kind: 'Informazione' } }, // allow-italian: fixture data, shown as written
      { who: 'operator', text: 'Passiamo il venerdì mattina, le mando un SMS.' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'c-4', caller: 'Utente privato (esempio)', at: 'ieri 11:15', seconds: 180, // allow-italian: fixture data, shown as written
    transcript: [
      { who: 'caller', text: 'Il cassonetto davanti a casa non è stato svuotato.', fills: { kind: 'Mancato ritiro' } }, // allow-italian: fixture data, shown as written
      { who: 'operator', text: 'Apro una segnalazione con priorità alta.' }, // allow-italian: fixture data, shown as written
    ],
  },
];

/* ---------- the overview (s04) ---------- */

/** The service a rule proposes for a new report: the site follows the town, the vehicle the kind of waste. */
export function defaultService(kind: string, city: string): QueueItemSeed['service'] {
  const bulky = kind.toLowerCase().startsWith('ingombranti'); // allow-italian: fixture data, shown as written
  return {
    turn: TURN_CHOICES[0],
    site: city === 'Salerno' ? 'Salerno Est' : city || 'da assegnare', // allow-italian: fixture data, shown as written
    vehicle: bulky ? 'costipatore 7,5 t' : 'squadra di zona', // allow-italian: fixture data, shown as written
    notice: 'SMS',
  };
}

/** The example order number of the nth report opened in the preview (after the four of the queue). */
export const orderNumber = (n: number) => `45001822${34 + n}`;

/** The words of the four tiles of s04: what is counted is SARIM's own vocabulary. */
export const SARIM_OVERVIEW_WORDS = {
  reports: { label: 'Segnalazioni al mese, stima', detail: 'da mail, telefono e portale' }, // allow-italian: fixture data, shown as written
  duplicates: { label: 'Doppioni evitati, stima', detail: 'uscite di mezzi risparmiate' }, // allow-italian: fixture data, shown as written
  invoices: { label: 'Fatture controllate, stima', detail: (pct: number) => `${pct}% con differenze` }, // allow-italian: fixture data, shown as written
  hours: { label: 'Ore tolte al mese, stima', detail: 'minuti a mano per voce × volume, stima' }, // allow-italian: fixture data, shown as written
};
