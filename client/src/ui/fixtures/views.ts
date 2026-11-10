/**
 * Fixture of a02: the appeal's parcels checked on the contribution perimeter.
 * True: the farm is in Castel San Giorgio, the Canale Macchione and the Canale
 * Torello run there (DATI-VERI.md, the Consorzio's 2025 yearbook), the Consorzio works
 * in QGIS and the perimeter is the Piano di Classifica 1996. Example: sheet and
 * parcel numbers, positions, the 72 m and the height, as the caption says.
 */
import type { BlockId, CadEntity, CadRuleModel, CadSheetModel, ParcelMapModel, ParcelModel, ParcelViewModel } from '../views/model';
import type { CaseKind } from './org/types';
import type { Tone } from '../types';

/** The cadastral sheet is drawn 3 degrees off the map grid, as the layers come out of QGIS. */
const ANGLE = (-3 * Math.PI) / 180;
const CENTER: [number, number] = [520, 330];

const turn = (x: number, y: number): [number, number] => {
  const dx = x - CENTER[0];
  const dy = y - CENTER[1];
  return [
    Math.round(CENTER[0] + dx * Math.cos(ANGLE) - dy * Math.sin(ANGLE)),
    Math.round(CENTER[1] + dx * Math.sin(ANGLE) + dy * Math.cos(ANGLE)),
  ];
};

const parcel = (id: string, x: number, y: number, w: number, h: number, label?: { text: string; size?: 'lg' | 'sm' }): ParcelModel => ({
  id,
  points: [turn(x, y), turn(x + w, y), turn(x + w, y + h), turn(x, y + h)],
  target: Boolean(label),
  label: label && { ...label, at: turn(x + w / 2, y + h / 2 + 6) },
});

export const PARCEL_CHECK: ParcelViewModel = {
  crumbs: [{ label: 'Viste' }, { label: 'Verifica della particella', detail: 'pratica 2418, azienda agricola' }], // allow-italian: fixture data, shown as written
  confirmLabel: 'Confermo: nel perimetro', // allow-italian: fixture data, shown as written
  rejectLabel: 'Non è nel perimetro', // allow-italian: fixture data, shown as written
  layers: [
    { id: 'l-perimetro', label: 'Perimetro', on: true, part: 'perimeter' }, // allow-italian: fixture data, shown as written
    { id: 'l-canali', label: 'Canali', on: true, part: 'canals' },
    { id: 'l-opere', label: 'Opere', on: true, part: 'works' }, // allow-italian: fixture data, shown as written
    { id: 'l-ortofoto', label: 'Ortofoto', on: false, part: 'ortho' },
  ],
  caption: ['QGIS via MCP · tavola 12 · ', { strong: 'posizione e misure di esempio' }], // allow-italian: fixture data, shown as written
  map: {
    size: [820, 820],
    perimeter: {
      area: 'M0 92 L820 70 L820 770 L0 792 Z',
      edges: ['M0 92 L820 70', 'M0 792 L820 770'],
      label: { at: [12, 128], text: 'Perimetro di contribuenza · Castel San Giorgio' }, // allow-italian: fixture data, shown as written
    },
    canals: [
      {
        id: 'c-torello', name: 'Canale Torello', width: 7,
        path: 'M62 0 C 120 180, 150 300, 205 420 S 300 640, 268 820',
        label: { at: [176, 318], rotate: -66, text: 'Canale Torello' },
      },
      {
        id: 'c-macchione', name: 'Canale Macchione', width: 16,
        path: 'M0 650 C 180 640, 330 615, 470 585 S 700 548, 820 548',
        label: { at: [652, 534], text: 'Canale Macchione' },
      },
    ],
    parcels: [
      parcel('p-1', 268, 205, 145, 140),
      parcel('p-2', 425, 195, 160, 140),
      parcel('p-3', 600, 185, 150, 135),
      parcel('p-4', 280, 355, 150, 135),
      parcel('p-210', 442, 350, 146, 135, { text: 'F.14 p.210' }),
      parcel('p-214', 590, 348, 42, 135, { text: '214', size: 'sm' }),
      parcel('p-6', 642, 345, 128, 135),
    ],
    works: [{ id: 'o-paratoia', at: [452, 590], label: 'Paratoia' }], // allow-italian: fixture data, shown as written
    measure: { from: turn(515, 485), to: [540, 574], label: { at: [550, 602], text: '72 m dal Canale Macchione' } }, // allow-italian: fixture data, shown as written
  },
  panel: {
    title: 'Il fondo è nel perimetro?', // allow-italian: fixture data, shown as written
    claim: ['Il ricorso dice che il fondo non trae beneficio dalle opere ', { source: { id: 'd-ricorso', label: 'ricorso', page: 5 } }, '.'], // allow-italian: fixture data, shown as written
    checks: [
      { label: 'Particelle 210 e 214 nel perimetro', value: 'sì', tone: 'green' }, // allow-italian: fixture data, shown as written
      { label: 'Distanza dal Canale Macchione', value: '72 m' }, // allow-italian: fixture data, shown as written
      { label: 'Scolo verso opere del consorzio', value: 'sì, Canale Macchione', tone: 'green' }, // allow-italian: fixture data, shown as written
      { label: 'Quota rispetto al canale', value: '+1,8 m, da verificare', tone: 'amber' }, // allow-italian: fixture data, shown as written
    ],
    originals: [
      { id: 'o-visura', label: 'Visura catastale F.14' },
      { id: 'o-piano', label: 'Piano di Classifica 1996' }, // allow-italian: fixture data, shown as written
      { id: 'o-perizia', label: 'Perizia del ricorrente, doc. 4' }, // allow-italian: fixture data, shown as written
    ],
    outcomeLabel: 'Cosa entra nella pratica', // allow-italian: fixture data, shown as written
    outcome: 'Esito, misure, schermata della mappa e chi ha deciso. Le controdeduzioni li citano al punto 1.', // allow-italian: fixture data, shown as written
  },
};

/* ---------- saved views and the catalogue of blocks (a01, a05) ---------- */

export type { BlockId };

export const BLOCK_IDS: BlockId[] = ['document', 'map', 'drawing', 'table', 'compare', 'timeline', 'checks', 'decision', 'signature', 'slides', 'summary'];

/** The tone of a block's chip: the AI blocks violet, the rules blue, the human ones amber. */
export const BLOCK_TONE: Record<BlockId, Tone> = {
  document: 'neutral', map: 'neutral', drawing: 'neutral', table: 'neutral', compare: 'neutral', timeline: 'neutral',
  checks: 'blue', decision: 'amber', signature: 'amber', slides: 'neutral', summary: 'violet',
};

/** Where each block reads from: programs and sources of the example organization (data, not product words). */
export const BLOCK_READS: Record<BlockId, string> = {
  document: 'PEC, Conoscenza, SharePoint', // allow-italian: fixture data, shown as written
  map: 'QGIS via MCP, catasto', // allow-italian: fixture data, shown as written
  drawing: 'DWG, DXF, AutoCAD',
  table: 'Dati', // allow-italian: fixture data, shown as written
  compare: 'Dati, Conoscenza', // allow-italian: fixture data, shown as written
  timeline: 'Dati, Registro', // allow-italian: fixture data, shown as written
  checks: 'regole dei flussi', // allow-italian: fixture data, shown as written
  decision: 'passo Persona', // allow-italian: fixture data, shown as written
  signature: 'firma digitale, Halley', // allow-italian: fixture data, shown as written
  slides: 'qualsiasi vista o pratica', // allow-italian: fixture data, shown as written
  summary: 'originali citati', // allow-italian: fixture data, shown as written
};

/** What exists in Topics already, per block (the last column of the catalogue); absent means it is new. */
export const BLOCK_EXISTS: Partial<Record<BlockId, string>> = {
  table: 'viste generative', // allow-italian: fixture data, shown as written
  compare: 'viste generative', // allow-italian: fixture data, shown as written
  timeline: 'viste generative', // allow-italian: fixture data, shown as written
  decision: 'domande con bottoni', // allow-italian: fixture data, shown as written
  summary: 'sintesi con fonti', // allow-italian: fixture data, shown as written
};

export type ViewScope = 'org' | 'sector' | 'standard';

/** The flow step that opens a view. `step` is one id of the flow in `FLOWS`. */
export interface StepUse {
  flow: string;
  step: string;
  /** How the step reads in a list, e.g. `PEC · ricorso, passo b`. */
  label: string;
}

export interface ViewSeed {
  id: string;
  name: string;
  description: string;
  scope: ViewScope;
  blocks: BlockId[];
  /** The kinds of case it is made for. */
  kinds: CaseKind[];
  /** Steps that open it today. */
  uses: StepUse[];
  /** Opens or creations per month, a declared estimate; absent when it is not in use. */
  perMonth?: number;
  /** a05: the decision it allows, the originals next to it, what it writes in the case, what it stands on. */
  decision?: string;
  originals?: string;
  writes?: string;
  base?: string;
}

/** The views the organization uses (a01 «Dell'organizzazione»), then the sector's and the standard ones. */
export const VIEW_LIBRARY: ViewSeed[] = [
  {
    id: 'particella', name: 'Verifica della particella', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'Particella sulla mappa del comprensorio, perimetro di contribuenza, visura accanto. Per ricorsi e istanze di sgravio.', // allow-italian: fixture data, shown as written
    blocks: ['map', 'document', 'decision'], kinds: ['ricorso', 'sgravio', 'verbale'],
    uses: [
      { flow: 'pec', step: 'b', label: 'PEC · ricorso, passo b' }, // allow-italian: fixture data, shown as written
      { flow: 'concessioni', step: 's2', label: 'Concessione · passo 2' }, // allow-italian: fixture data, shown as written
    ],
    perMonth: 212,
    decision: 'il fondo è nel perimetro e scola in opere dell\'organizzazione?', // allow-italian: fixture data, shown as written
    originals: 'visura, Piano di Classifica 1996, cartografia', // allow-italian: fixture data, shown as written
    writes: 'esito, distanze, immagine della mappa', // allow-italian: fixture data, shown as written
    base: 'QGIS via MCP',
  },
  {
    id: 'tavola', name: 'Verifica della tavola di progetto', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'Tavola DWG con le misure lette, confrontate con il regolamento delle concessioni. Per attraversamenti e scarichi.', // allow-italian: fixture data, shown as written
    blocks: ['drawing', 'checks', 'decision'], kinds: ['concessione', 'verbale'],
    uses: [{ flow: 'concessioni', step: 's3', label: 'Concessione · passo 3' }], // allow-italian: fixture data, shown as written
    perMonth: 27,
    decision: 'il progetto rispetta le prescrizioni?', // allow-italian: fixture data, shown as written
    originals: 'DWG firmato, relazione, regolamento', // allow-italian: fixture data, shown as written
    writes: 'misure, controlli, bozza di integrazione', // allow-italian: fixture data, shown as written
    base: 'file del progetto', // allow-italian: fixture data, shown as written
  },
  {
    id: 'fattura-ordine', name: 'Fattura contro ordine', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'Fattura e ordine affiancati riga per riga, dentro la conferma della Ragioneria.', // allow-italian: fixture data, shown as written
    blocks: ['document', 'document', 'checks'], kinds: ['fattura'],
    uses: [{ flow: 'fatture', step: 's4', label: 'Fattura · passo 4' }], // allow-italian: fixture data, shown as written
    perMonth: 43,
    decision: 'accettare la differenza?', // allow-italian: fixture data, shown as written
    originals: 'fattura SdI, ordine', // allow-italian: fixture data, shown as written
    writes: 'esito e motivo', // allow-italian: fixture data, shown as written
    base: 'tabella delle viste', // allow-italian: fixture data, shown as written
  },
  {
    id: 'presentazione', name: 'Presentazione', scope: 'standard', // allow-italian: fixture data, shown as written
    description: 'Si genera da qualsiasi vista o pratica, con le fonti cliccabili, per chi è fuori dall\'organizzazione.', // allow-italian: fixture data, shown as written
    blocks: ['slides', 'document', 'summary'], kinds: ['ricorso', 'sgravio', 'concessione', 'verbale'],
    uses: [{ flow: 'pec', step: 'f', label: 'PEC · ricorso, passo f' }], // allow-italian: fixture data, shown as written
    perMonth: 9,
    decision: 'condividere con un esterno', // allow-italian: fixture data, shown as written
    originals: 'fonti cliccabili', // allow-italian: fixture data, shown as written
    writes: 'la versione inviata, nel Registro', // allow-italian: fixture data, shown as written
    base: 'pagina delle viste generative', // allow-italian: fixture data, shown as written
  },
  {
    id: 'turni-irrigui', name: 'Turni irrigui dei 7 bacini', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'Calendario dei turni con i campi sulla mappa, per l\'ufficio tecnico e i guardiani.', // allow-italian: fixture data, shown as written
    blocks: ['table', 'map'], kinds: ['irrigazione'],
    uses: [{ flow: 'irrigua', step: 's5', label: 'Richiesta irrigua · assegna turno' }], // allow-italian: fixture data, shown as written
    perMonth: 96,
    decision: 'quale turno nei 7 bacini', // allow-italian: fixture data, shown as written
    originals: 'richiesta, catasto irriguo', // allow-italian: fixture data, shown as written
    writes: 'turno assegnato', // allow-italian: fixture data, shown as written
    base: 'tabella, cronologia', // allow-italian: fixture data, shown as written
  },
  {
    id: 'conferma-originali', name: 'Conferma con originali', scope: 'standard', // allow-italian: fixture data, shown as written
    description: 'Il valore letto dall\'AI accanto all\'originale: conferma, correggi o rifiuta, con il motivo.', // allow-italian: fixture data, shown as written
    blocks: ['document', 'summary', 'decision'], kinds: ['ricorso', 'sgravio', 'concessione', 'accesso', 'segnalazione', 'fattura', 'verbale', 'irrigazione', 'regione'],
    uses: [{ flow: 'pec', step: 'd', label: 'ogni passo Persona' }], // allow-italian: fixture data, shown as written
    decision: 'conferma, correggi, rifiuta', // allow-italian: fixture data, shown as written
    originals: 'PEC, allegati firmati', // allow-italian: fixture data, shown as written
    writes: 'valori confermati, correzioni, chi e quando', // allow-italian: fixture data, shown as written
    base: 'domande con bottoni', // allow-italian: fixture data, shown as written
  },
  {
    id: 'tabella', name: 'Tabella', scope: 'standard', // allow-italian: fixture data, shown as written
    description: 'Righe e colonne dei Dati, con filtri e ordine.', // allow-italian: fixture data, shown as written
    blocks: ['table'], kinds: [], uses: [],
  },
  {
    id: 'confronto', name: 'Confronto di due documenti', scope: 'standard', // allow-italian: fixture data, shown as written
    description: 'Due documenti o due versioni affiancati, con le differenze evidenziate.', // allow-italian: fixture data, shown as written
    blocks: ['compare', 'document'], kinds: [], uses: [],
  },
  {
    id: 'cronologia', name: 'Cronologia', scope: 'standard', // allow-italian: fixture data, shown as written
    description: 'Le tappe di una pratica in ordine, con chi e quando.', // allow-italian: fixture data, shown as written
    blocks: ['timeline'], kinds: [], uses: [],
  },
  {
    id: 'verbale-luogo', name: 'Verbale di polizia idraulica sul luogo', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'Fascia di rispetto, occupazione e foto sul tratto di canale, con il regolamento accanto.', // allow-italian: fixture data, shown as written
    blocks: ['map', 'document', 'decision'], kinds: ['verbale'], uses: [],
  },
  {
    id: 'sgravio-avviso', name: 'Istanza di sgravio con l\'avviso accanto', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'L\'istanza e l\'avviso di pagamento contestato affiancati, con gli importi a confronto.', // allow-italian: fixture data, shown as written
    blocks: ['document', 'document', 'checks'], kinds: ['sgravio'], uses: [],
  },
  {
    id: 'scadenze-ricorso', name: 'Scadenze del ricorso', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'I termini con la norma che li fissa e il calcolo, in ordine di data.', // allow-italian: fixture data, shown as written
    blocks: ['timeline', 'checks'], kinds: ['ricorso'], uses: [],
  },
  {
    id: 'concessioni-reticolo', name: 'Concessioni sul reticolo', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'Attraversamenti e scarichi autorizzati sulla mappa dei canali, con scadenza e canone.', // allow-italian: fixture data, shown as written
    blocks: ['map', 'table'], kinds: ['concessione'], uses: [],
  },
  {
    id: 'allagamento-mappa', name: 'Segnalazione di allagamento sulla mappa', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'Il punto segnalato sul canale, le segnalazioni vicine e la squadra assegnata.', // allow-italian: fixture data, shown as written
    blocks: ['map', 'timeline', 'decision'], kinds: ['segnalazione'], uses: [],
  },
  {
    id: 'variazione-catasto', name: 'Variazione di intestazione catastale', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'Intestatario nel ruolo e nella visura a confronto, con la decisione di aggiornare.', // allow-italian: fixture data, shown as written
    blocks: ['table', 'compare', 'decision'], kinds: ['sgravio'], uses: [],
  },
  {
    id: 'accesso-oscuramenti', name: 'Accesso agli atti con oscuramenti', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'I documenti richiesti con i dati personali da oscurare e i controinteressati.', // allow-italian: fixture data, shown as written
    blocks: ['document', 'checks', 'decision'], kinds: ['accesso'], uses: [],
  },
  {
    id: 'regione-norma', name: 'Comunicazione della Regione e norma', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'La comunicazione accanto agli articoli della L.R. 7/2025 che richiama.', // allow-italian: fixture data, shown as written
    blocks: ['document', 'compare'], kinds: ['regione'], uses: [],
  },
  {
    id: 'tagli-vegetazione', name: 'Tagli di vegetazione per tratto', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'I tratti di canale tagliati nell\'anno sulla mappa, con i metri quadrati e la squadra.', // allow-italian: fixture data, shown as written
    blocks: ['map', 'table'], kinds: ['segnalazione'], uses: [],
  },
  {
    id: 'vasche-laminanti', name: 'Vasche laminanti e livelli', scope: 'sector', // allow-italian: fixture data, shown as written
    description: 'Le 24 vasche assorbenti laminanti sulla mappa, con l\'ultima lettura di livello.', // allow-italian: fixture data, shown as written
    blocks: ['map', 'timeline'], kinds: [], uses: [],
  },
];

/** The ids the organization uses to begin with: 5. The reader adds more from the sector and the standard ones. */
export const ORG_VIEW_IDS = ['particella', 'tavola', 'fattura-ordine', 'presentazione', 'turni-irrigui'];

/** Who may open a view, by role id (`people.ts`): the starting point of «Per chi» in a05. */
export const VIEW_ROLES: Record<string, string[]> = {
  particella: ['operatore', 'direzione', 'legale'],
  tavola: ['operatore', 'direzione'],
  'fattura-ordine': ['operatore', 'direzione'],
  presentazione: ['operatore', 'direzione', 'legale'],
  'turni-irrigui': ['operatore', 'direzione'],
  'conferma-originali': ['operatore', 'direzione', 'legale', 'protocollo'],
};

/* ---------- the map of any case with a parcel (a02) ---------- */

const hashOf = (text: string): number => {
  let h = 7;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) % 100003;
  return h;
};

/** Where the big canal runs, as a polyline, to read its height at any x. */
const CANAL_Y: Array<[number, number]> = [[0, 650], [250, 626], [470, 585], [700, 556], [820, 548]];
const canalAt = (x: number): number => {
  for (let i = 1; i < CANAL_Y.length; i += 1) {
    const [x1, y1] = CANAL_Y[i - 1];
    const [x2, y2] = CANAL_Y[i];
    if (x <= x2) return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
  }
  return CANAL_Y[CANAL_Y.length - 1][1];
};

/** The slots of the cadastral sheet a parcel under verification can take (the narrow one stays free). */
const SLOTS: Array<[number, number, number, number]> = [
  [268, 205, 145, 140], [425, 195, 160, 140], [600, 185, 150, 135], [280, 355, 150, 135], [442, 350, 146, 135], [642, 345, 128, 135],
];

/** The narrow plot beside the fifth slot, never a target. */
const NARROW_SLOT: [number, number, number, number] = [590, 348, 42, 135];

/** The metres one map unit stands for (the 72 m of the example are 92 units). */
const METERS_PER_UNIT = 0.78;

export interface ParcelCase {
  id: string;
  title: string;
  counterpart: string;
  documents: Array<{ id: string; name: string }>;
  parcel: { comune: string; foglio: string; particella: string; canale?: string };
}

/**
 * The map check of a case, from its parcel: the example sheet with the case's
 * parcel in red, the canal it names, and the distance measured on the map
 * itself. Case 2418 keeps the hand-drawn one above, so its picture never changes.
 */
export function parcelViewFor(c: ParcelCase): ParcelViewModel {
  if (c.id === '2418') return PARCEL_CHECK;
  const h = hashOf(`${c.id}-${c.parcel.foglio}-${c.parcel.particella}`);
  const [x, y, w, hh] = SLOTS[h % SLOTS.length];
  const canal = c.parcel.canale ?? 'Canale Macchione'; // allow-italian: fixture data, shown as written
  const other = canal === 'Canale Torello' ? 'Canale Lauro' : 'Canale Torello'; // allow-italian: fixture data, shown as written
  const base = PARCEL_CHECK.map;
  const from = turn(x + w / 2, y + hh);
  const toX = from[0] + 18;
  const to: [number, number] = [toX, Math.round(canalAt(toX)) - 9];
  const meters = Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) * METERS_PER_UNIT);
  const cutHeight = `+${(1 + (h % 18) / 10).toFixed(1).replace('.', ',')} m, da verificare`; // allow-italian: fixture data, shown as written
  const drains = meters <= 120;
  const target = `F.${c.parcel.foglio} p.${c.parcel.particella}`;
  const doc = c.documents[0];
  const map: ParcelMapModel = {
    ...base,
    perimeter: { ...base.perimeter, label: { ...base.perimeter.label, text: `Perimetro di contribuenza · ${c.parcel.comune}` } }, // allow-italian: fixture data, shown as written
    canals: base.canals.map((k) => (k.id === 'c-macchione'
      ? { ...k, name: canal, label: { ...k.label, text: canal } }
      : { ...k, name: other, label: { ...k.label, text: other } })),
    parcels: [...SLOTS, NARROW_SLOT].map((slot, i) => (slot === SLOTS[h % SLOTS.length]
      ? parcel('p-target', x, y, w, hh, { text: target, size: w > 140 ? 'lg' : 'sm' })
      : parcel(`p-${i}`, slot[0], slot[1], slot[2], slot[3]))),
    works: [{ id: 'o-paratoia', at: [Math.round(from[0] - 70), Math.round(canalAt(from[0] - 70))], label: 'Paratoia' }], // allow-italian: fixture data, shown as written
    measure: { from, to, label: { at: [to[0] + 8, to[1] + 30], text: `${meters} m dal ${canal}` } }, // allow-italian: fixture data, shown as written
  };
  return {
    crumbs: [{ label: 'Viste' }, { label: 'Verifica della particella', detail: `${c.id}, ${c.counterpart}` }], // allow-italian: fixture data, shown as written
    confirmLabel: PARCEL_CHECK.confirmLabel,
    rejectLabel: PARCEL_CHECK.rejectLabel,
    layers: PARCEL_CHECK.layers,
    caption: ['QGIS via MCP · tavola 12 · ', { strong: 'posizione e misure di esempio' }], // allow-italian: fixture data, shown as written
    map,
    panel: {
      title: 'La particella è nel perimetro?', // allow-italian: fixture data, shown as written
      claim: doc ? [`${c.title}: la particella è ${target}. `, { source: { id: doc.id, label: doc.name, page: 1 } }, '.'] : [`${c.title}: la particella è ${target}.`], // allow-italian: fixture data, shown as written
      checks: [
        { label: `Particella ${target} nel perimetro`, value: 'sì', tone: 'green' }, // allow-italian: fixture data, shown as written
        { label: `Distanza dal ${canal}`, value: `${meters} m` }, // allow-italian: fixture data, shown as written
        { label: 'Scolo verso opere del consorzio', value: drains ? `sì, ${canal}` : 'da verificare', tone: drains ? 'green' : 'amber' }, // allow-italian: fixture data, shown as written
        { label: 'Quota rispetto al canale', value: cutHeight, tone: 'amber' }, // allow-italian: fixture data, shown as written
      ],
      originals: [
        { id: 'o-visura', label: `Visura catastale F.${c.parcel.foglio}` }, // allow-italian: fixture data, shown as written
        { id: 'o-piano', label: 'Piano di Classifica 1996' }, // allow-italian: fixture data, shown as written
        ...(doc ? [{ id: doc.id, label: doc.name }] : []),
      ],
      outcomeLabel: 'Cosa entra nella pratica', // allow-italian: fixture data, shown as written
      outcome: 'Esito, misure, schermata della mappa e chi ha deciso. Le controdeduzioni li citano.', // allow-italian: fixture data, shown as written
    },
  };
}

/* ---------- the CAD sheet of a concession (a03) ---------- */

/** One metre is 40 sheet units: a grid square is a metre, so a dimension is read, not typed. */
export const CAD_UNITS_PER_METER = 40;

const COLOR = { river: '#5aa9ff', pipe: '#f0a64a', limit: '#9aa0a8', bad: '#e5484d', ok: '#4cc77f', text: '#c8cbd2' };

const gridLines = (): CadEntity[] => {
  const out: CadEntity[] = [];
  for (let x = 0; x <= 900; x += 40) out.push({ kind: 'line', layer: 'griglia', a: [x, 0], b: [x, 760], width: 1, color: '#2a2d33' });
  for (let y = 0; y <= 760; y += 40) out.push({ kind: 'line', layer: 'griglia', a: [0, y], b: [900, y], width: 1, color: '#2a2d33' });
  return out;
};

/**
 * Section A-A of a pipe crossing the canal, drawn at 1:100 with a grid of one
 * metre. The three rules below read their values from the dimension lines.
 */
export const CAD_SHEET: CadSheetModel = {
  size: [900, 760],
  unitsPerMetre: CAD_UNITS_PER_METER,
  layers: [
    { id: 'griglia', label: 'GRIGLIA', color: '#2a2d33' },
    { id: 'alveo', label: 'ALVEO', color: COLOR.river },
    { id: 'fascia', label: 'FASCIA', color: COLOR.limit },
    { id: 'condotta', label: 'CONDOTTA', color: COLOR.pipe },
    { id: 'quote', label: 'QUOTE', color: COLOR.ok },
    { id: 'testi', label: 'TESTI', color: COLOR.text },
    { id: 'cartiglio', label: 'CARTIGLIO', color: '#6b7078' },
  ],
  entities: [
    ...gridLines(),
    { kind: 'line', layer: 'alveo', a: [0, 300], b: [200, 300], width: 1.5, color: '#6b7078' },
    { kind: 'line', layer: 'alveo', a: [680, 300], b: [900, 300], width: 1.5, color: '#6b7078' },
    { kind: 'rect', layer: 'alveo', at: [200, 300], size: [480, 120], width: 2, color: COLOR.river },
    { kind: 'text', layer: 'testi', at: [210, 292], text: 'ALVEO COMUNE NOCERINO · L=12,00', size: 12, color: COLOR.river }, // allow-italian: fixture data, shown as written
    { kind: 'line', layer: 'fascia', a: [40, 200], b: [40, 400], dash: true, color: COLOR.limit },
    { kind: 'line', layer: 'fascia', a: [840, 200], b: [840, 400], dash: true, color: COLOR.limit },
    { kind: 'text', layer: 'testi', at: [48, 192], text: 'FASCIA DI RISPETTO 4,00 m', size: 13, color: COLOR.text }, // allow-italian: fixture data, shown as written
    { kind: 'dim', layer: 'quote', id: 'fascia', a: [40, 270], b: [200, 270], label: '4,00 m ✓', ok: true, color: COLOR.ok },
    { kind: 'rect', layer: 'condotta', at: [370, 462], size: [60, 40], width: 2, color: COLOR.pipe, fill: 'rgba(240,166,74,.15)' },
    { kind: 'circle', layer: 'condotta', at: [400, 480], r: 12, color: COLOR.pipe, fill: 'rgba(240,166,74,.4)' },
    { kind: 'text', layer: 'testi', at: [440, 486], text: 'CONDOTTA DN 300 · posa in subalveo', size: 12, color: COLOR.pipe }, // allow-italian: fixture data, shown as written
    { kind: 'line', layer: 'quote', a: [340, 468], b: [460, 468], dash: true, width: 1, color: COLOR.ok },
    { kind: 'text', layer: 'testi', at: [466, 464], text: 'minimo 1,50 m', size: 11, color: COLOR.ok }, // allow-italian: fixture data, shown as written
    { kind: 'dim', layer: 'quote', id: 'ricoprimento', a: [300, 420], b: [300, 468], label: '1,20 m', ok: false, color: COLOR.bad },
    { kind: 'text', layer: 'testi', at: [96, 478], text: 'ricoprimento sotto fondo', size: 13, color: '#ff8a8f' }, // allow-italian: fixture data, shown as written
    { kind: 'rect', layer: 'cartiglio', at: [620, 620], size: [230, 110], width: 1, color: '#6b7078' },
    { kind: 'text', layer: 'cartiglio', at: [632, 646], text: 'TAV. 3 · SEZIONE A-A', size: 13, color: COLOR.text }, // allow-italian: fixture data, shown as written
    { kind: 'text', layer: 'cartiglio', at: [632, 666], text: 'Studio tecnico · esempio', size: 12, color: COLOR.text }, // allow-italian: fixture data, shown as written
    { kind: 'text', layer: 'cartiglio', at: [632, 684], text: 'scala 1:100 · rev. 2', size: 12, color: COLOR.text }, // allow-italian: fixture data, shown as written
    { kind: 'text', layer: 'cartiglio', at: [632, 702], text: 'attraversamento_v2.dwg', size: 12, color: COLOR.text },
  ],
};

/** Crossing rules from the consortium regulation; each names the drawn dimension it is read from. */
export const CAD_RULES: Array<{ id: string; label: string; dim?: string; min?: number; material?: string[] }> = [
  { id: 'fascia', label: 'Fascia di rispetto', dim: 'fascia', min: 4 }, // allow-italian: fixture data, shown as written
  { id: 'ricoprimento', label: 'Ricoprimento sotto fondo', dim: 'ricoprimento', min: 1.5 }, // allow-italian: fixture data, shown as written
  { id: 'materiale', label: 'Materiale condotta', material: ['acciaio', 'PEAD'] }, // allow-italian: fixture data, shown as written
];

/** The material the sheet declares for the pipe. */
export const CAD_MATERIAL = 'PEAD PN16';

export const formatMeters = (m: number): string => `${m.toFixed(2).replace('.', ',')} m`;

/** Length in metres between two sheet points. */
export const metersBetween = (sheet: CadSheetModel, a: [number, number], b: [number, number]): number =>
  Math.hypot(b[0] - a[0], b[1] - a[1]) / sheet.unitsPerMetre;

/** The rules checked against the sheet: every value is measured on the drawing. */
export function cadRulesOf(sheet: CadSheetModel): CadRuleModel[] {
  return CAD_RULES.map((r) => {
    if (r.material) {
      const ok = r.material.some((m) => CAD_MATERIAL.startsWith(m));
      return { id: r.id, label: r.label, required: r.material.join(' o '), found: CAD_MATERIAL, ok }; // allow-italian: fixture data, shown as written
    }
    const dim = sheet.entities.find((e) => e.kind === 'dim' && e.id === r.dim);
    const found = dim && dim.kind === 'dim' ? metersBetween(sheet, dim.a, dim.b) : 0;
    const min = r.min ?? 0;
    return { id: r.id, label: r.label, required: `≥ ${formatMeters(min)}`, found: formatMeters(found), ok: found + 1e-9 >= min };
  });
}

/** The draft of the integration request the view prepares when a rule fails. */
export const CAD_DRAFT = 'Si chiede di adeguare il ricoprimento della condotta ad almeno 1,50 m sotto il fondo dell\'alveo, come previsto dalle prescrizioni del Regolamento per la gestione e la conservazione delle opere di bonifica (delibera del Consiglio dei Delegati 2/2023).'; // allow-italian: fixture data, shown as written

export const CAD_ORIGINALS: Array<{ id: string; label: string; note?: string }> = [
  { id: 'dwg', label: 'attraversamento_v2.dwg', note: 'firmato' }, // allow-italian: fixture data, shown as written
  { id: 'relazione', label: 'Relazione tecnica, p.7' }, // allow-italian: fixture data, shown as written
  { id: 'regolamento', label: 'Regolamento opere di bonifica, delibera del Consiglio dei Delegati 2/2023' }, // allow-italian: fixture data, shown as written
];

/* ---------- words of the sector the screens need as data ---------- */

/** The kinds of record a view can be made for, as the sector names them. */
export const KIND_LABEL: Record<CaseKind, string> = {
  ricorso: 'Ricorso', // allow-italian: fixture data, shown as written
  sgravio: 'Istanza di sgravio', // allow-italian: fixture data, shown as written
  concessione: 'Concessione', // allow-italian: fixture data, shown as written
  accesso: 'Accesso agli atti', // allow-italian: fixture data, shown as written
  segnalazione: 'Segnalazione', // allow-italian: fixture data, shown as written
  fattura: 'Fattura', // allow-italian: fixture data, shown as written
  verbale: 'Verbale di polizia idraulica', // allow-italian: fixture data, shown as written
  irrigazione: 'Richiesta irrigua', // allow-italian: fixture data, shown as written
  regione: 'Comunicazione della Regione', // allow-italian: fixture data, shown as written
  send: 'Notifica SEND', // allow-italian: fixture data, shown as written
  rifiuti: 'Rifiuti', // allow-italian: fixture data, shown as written
  foglie: 'Foglie', // allow-italian: fixture data, shown as written
  fir: 'FIR',
};

/** The words that make the description of a view propose a block (a sentence like "show it on the map"). */
export const BLOCK_WORDS: Record<BlockId, string[]> = {
  document: ['documento', 'pdf', 'atto', 'originale', 'allegato'], // allow-italian: fixture data, shown as written
  map: ['mappa', 'particella', 'perimetro', 'canale', 'scarico', 'qgis'], // allow-italian: fixture data, shown as written
  drawing: ['tavola', 'disegno', 'progetto', 'dwg', 'cad', 'sezione'], // allow-italian: fixture data, shown as written
  table: ['tabella', 'elenco', 'righe', 'calendario'], // allow-italian: fixture data, shown as written
  compare: ['confronto', 'confronta', 'affianca', 'differenza'], // allow-italian: fixture data, shown as written
  timeline: ['cronologia', 'storia', 'tappe', 'scadenze'], // allow-italian: fixture data, shown as written
  checks: ['controlli', 'controllo', 'regole', 'regolamento', 'distanza', 'misure'], // allow-italian: fixture data, shown as written
  decision: ['decisione', 'decidere', 'conferma', 'approva', 'rifiuta'], // allow-italian: fixture data, shown as written
  signature: ['firma', 'firmare', 'firmato'], // allow-italian: fixture data, shown as written
  slides: ['presentazione', 'diapositive', 'condividere'], // allow-italian: fixture data, shown as written
  summary: ['sintesi', 'riassunto', 'riassumi'], // allow-italian: fixture data, shown as written
};

const NORM_ITEM: Record<string, string> = {
  'lr-7-2025': 'L.R. Campania 7/2025',
  'dlgs-546-1992': 'D.Lgs. 546/1992', // allow-italian: fixture data, shown as written
  'rd-368': 'R.D. 368/1904',
  'rd-523': 'R.D. 523/1904',
  'lr-13-1983': 'L.R. Campania 13/1983',
};

/** `lr-7-2025/a9c3` becomes `L.R. Campania 7/2025, art. 9 c.3`. */
export function normLabel(id: string): string {
  const [item, article] = id.split('/');
  const base = NORM_ITEM[item] ?? item;
  const m = article?.match(/^a(\d+)(?:c(\d+))?$/);
  if (!m) return base;
  return `${base}, art. ${m[1]}${m[2] ? ` c.${m[2]}` : ''}`;
}

/** The starting point of a share: who it goes to and until when (the demo's year end). */
export const DECK_DEFAULTS = {
  to: 'Studio legale (esempio)', // allow-italian: fixture data, shown as written
  expires: '2026-12-31',
};

/** What a decision on the map says in the record, and the reasons offered for «not in the perimeter». */
export const PARCEL_TEXT = {
  decidedIn: 'Nel perimetro', // allow-italian: fixture data, shown as written
  decidedOut: 'Fuori dal perimetro', // allow-italian: fixture data, shown as written
  eventIn: 'Verificata sulla mappa: il fondo è nel perimetro', // allow-italian: fixture data, shown as written
  eventOut: (reason: string) => `Verificata sulla mappa: il fondo non è nel perimetro (${reason})`, // allow-italian: fixture data, shown as written
  reasons: [
    'La particella è fuori dal perimetro del Piano di Classifica', // allow-italian: fixture data, shown as written
    'Il fondo non scola in opere del consorzio', // allow-italian: fixture data, shown as written
    'La visura indica un\'altra particella', // allow-italian: fixture data, shown as written
    'Altro motivo', // allow-italian: fixture data, shown as written
  ],
};
