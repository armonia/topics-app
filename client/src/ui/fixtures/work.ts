/**
 * The sector package of the `work` area: the words a customer's staff use for
 * what the product shows generically (a «pratica», a «PEC», the program that
 * holds the protocol), and the few figures of «La mia giornata» that are
 * declared examples. The labels of the screens come from the catalogue
 * (`copy/work.ts`); everything here is data, shown as written.
 *
 * Programs are the real ones of the Consorzio (DATI-VERI.md): Halley for the
 * protocol, Prunes for the cadastre and the taxpayers, TeamSystem for the
 * accounting, SharePoint for the drafts.
 */
import type { CaseKind, CaseSeed, Channel, Office } from './org/types';

/** How a case is named: «Pratica 2418». */
export const recordName = (id: string) => `Pratica ${id}`; // allow-italian: fixture data, shown as written

export const SECTOR_WORK = {
  myRecords: 'Le mie pratiche', // allow-italian: fixture data, shown as written
  reviewKind: 'Controllo protocollo', // allow-italian: fixture data, shown as written
  confirmLabel: 'Conferma e protocolla', // allow-italian: fixture data, shown as written
  relatedLabel: 'Pratiche simili', // allow-italian: fixture data, shown as written
  assistantTag: 'Assistente della pratica', // allow-italian: fixture data, shown as written
  assistantDescription: 'Vede solo questa pratica, i suoi documenti e la Conoscenza.', // allow-italian: fixture data, shown as written
  exampleTag: 'caso di esempio', // allow-italian: fixture data, shown as written
} as const;

/**
 * Attachments the message itself carried, when the original files opened in the
 * preview are fewer or more than that: the PEC of case 2418 had 3 (its delivery
 * receipt says so), the preview opens the appeal and the receipt.
 */
const CHANNEL_ATTACHMENTS: Record<string, number> = { '2418': 3 };

/** How many files arrived with the message: never the drafts or files the Consorzio added later. */
export const channelAttachments = (c: CaseSeed): number => CHANNEL_ATTACHMENTS[c.id] ?? c.documents.filter((d) => !d.draft).length;

export const CHANNEL_LABEL: Record<Channel, string> = {
  pec: 'PEC',
  mail: 'Mail',
  whatsapp: 'WhatsApp',
  telefono: 'Telefono', // allow-italian: fixture data, shown as written
  sdi: 'SDI',
  sportello: 'Sportello', // allow-italian: fixture data, shown as written
  teams: 'Teams',
  portale: 'Portale', // allow-italian: fixture data, shown as written
};

/** The type of a case, short, for the chip over its title. */
export const KIND_LABEL: Record<CaseKind, string> = {
  ricorso: 'Ricorso', // allow-italian: fixture data, shown as written
  sgravio: 'Sgravio', // allow-italian: fixture data, shown as written
  concessione: 'Concessione', // allow-italian: fixture data, shown as written
  accesso: 'Accesso agli atti', // allow-italian: fixture data, shown as written
  segnalazione: 'Segnalazione', // allow-italian: fixture data, shown as written
  fattura: 'Fattura', // allow-italian: fixture data, shown as written
  verbale: 'Verbale', // allow-italian: fixture data, shown as written
  irrigazione: 'Turno irriguo', // allow-italian: fixture data, shown as written
  regione: 'Regione', // allow-italian: fixture data, shown as written
  send: 'Notifica SEND', // allow-italian: fixture data, shown as written
  rifiuti: 'Rifiuti', // allow-italian: fixture data, shown as written
  foglie: 'Servizio foglie', // allow-italian: fixture data, shown as written
  fir: 'FIR', // allow-italian: fixture data, shown as written
};

/** The types that always go to a person, whatever the confidence: the reason the queue tag gives. */
export const HUMAN_ALWAYS: Partial<Record<CaseKind, string>> = {
  ricorso: 'atto giudiziario', // allow-italian: fixture data, shown as written
  verbale: 'atto sanzionatorio', // allow-italian: fixture data, shown as written
  regione: 'Regione',
};

/** Where the facts of a case live, by program: the right column of the full sheet. */
export interface SystemRow {
  /** What lives there: «Protocollo e fascicolo». */
  what: string;
  /** The program that holds it. */
  where: string;
}

const COMMON_SYSTEMS: SystemRow[] = [
  { what: 'Scadenze e pratica', where: 'Topics' }, // allow-italian: fixture data, shown as written
];

export function systemsOf(kind: CaseKind): SystemRow[] {
  switch (kind) {
    case 'fattura':
      return [
        { what: 'Fattura e registrazione', where: 'TeamSystem' }, // allow-italian: fixture data, shown as written
        { what: 'Protocollo e fascicolo', where: 'Halley' }, // allow-italian: fixture data, shown as written
        ...COMMON_SYSTEMS,
      ];
    case 'segnalazione':
    case 'irrigazione':
    case 'verbale':
      return [
        { what: 'Protocollo e fascicolo', where: 'Halley' }, // allow-italian: fixture data, shown as written
        { what: 'Reticolo e particelle', where: 'QGIS' }, // allow-italian: fixture data, shown as written
        ...COMMON_SYSTEMS,
      ];
    case 'rifiuti':
    case 'foglie':
    case 'fir':
      return [
        { what: 'Moduli e registri', where: 'WinWaste' }, // allow-italian: fixture data, shown as written
        { what: 'Segnalazioni e ticket', where: 'Topics' }, // allow-italian: fixture data, shown as written
      ];
    default:
      return [
        { what: 'Protocollo e fascicolo', where: 'Halley' }, // allow-italian: fixture data, shown as written
        { what: 'Contribuente e avviso', where: 'Prunes' }, // allow-italian: fixture data, shown as written
        ...COMMON_SYSTEMS,
        { what: 'Bozze', where: 'SharePoint Legale' }, // allow-italian: fixture data, shown as written
      ];
  }
}

/** The program the protocol card of the sheet names, by type. */
export function protocolProgram(kind: CaseKind): string {
  return kind === 'fattura' ? 'TeamSystem' : kind === 'rifiuti' || kind === 'foglie' || kind === 'fir' ? 'WinWaste' : 'Halley';
}

/** The program the counterpart card of the sheet names, by type. */
export function counterpartProgram(kind: CaseKind): string {
  return kind === 'fattura' ? 'TeamSystem' : kind === 'rifiuti' || kind === 'foglie' || kind === 'fir' ? 'WinWaste' : 'Prunes';
}

/** The label of an office filter value that is not an office. */
export const OFFICE_ORDER: Office[] = ['protocollo', 'legale', 'catasto', 'tecnico', 'manutenzione', 'ragioneria', 'segreteria', 'irrigazione', 'direzione', 'call-center', 'amministrazione', 'servizi'];

/**
 * «Fatto ieri»: the figures of the day before in the example, a declared (allow-italian: quotes the Italian interface)
 * estimate of the same order as the queue's volume (the screen says so).
 */
export const DONE_YESTERDAY: Array<{ id: string; label: string; value: number }> = [
  { id: 'pec', label: 'PEC confermate', value: 6 }, // allow-italian: fixture data, shown as written
  { id: 'drafts', label: 'Bozze firmate', value: 2 }, // allow-italian: fixture data, shown as written
  { id: 'fixes', label: "Correzioni all'AI", value: 1 }, // allow-italian: fixture data, shown as written
];

/** The meetings of the day in the example: a short agenda next to the deadlines. */
export const AGENDA: Array<{ id: string; time: string; label: string; detail: string; office?: Office }> = [
  { id: 'a1', time: '11:00', label: 'Revisione delle bozze con il legale esterno', detail: 'Teams · 30 minuti', office: 'legale' }, // allow-italian: fixture data, shown as written
  { id: 'a2', time: '14:30', label: 'Riunione sul passaggio a SEND', detail: 'Sala riunioni · sede di Nocera Inferiore', office: 'direzione' }, // allow-italian: fixture data, shown as written
  { id: 'a3', time: '16:30', label: 'Controllo del robot su Halley', detail: 'Programmi · 10 minuti', office: 'protocollo' }, // allow-italian: fixture data, shown as written
];

/** The procedure the day card sends to review (a written-by-AI procedure waiting for approval). */
export const PROCEDURE_REVIEW = {
  id: 'costituzione-in-giudizio',
  title: 'Rivedere la procedura «Costituzione in giudizio»', // allow-italian: fixture data, shown as written
  detail: 'Scritta dall\'AI da 48 ricorsi, 5 passi.', // allow-italian: fixture data, shown as written
  tag: 'procedura', // allow-italian: fixture data, shown as written
};

/** The knowledge items the cases cite, as their norms are written. */
const NORM_ITEM_LABEL: Record<string, string> = {
  'lr-7-2025': 'L.R. 7/2025',
  'dlgs-546-1992': 'D.Lgs. 546/1992',
  'rd-368': 'R.D. 368/1904',
  'rd-523': 'R.D. 523/1904',
  'lr-13-1983': 'L.R. 13/1983',
  'piano-classifica-1996': 'Piano di Classifica 1996', // allow-italian: fixture data, shown as written
};

/** `dlgs-546-1992/a23c1` as `D.Lgs. 546/1992, art. 23 c.1`. */
export function normLabel(id: string): string {
  const [item, article] = id.split('/');
  const base = NORM_ITEM_LABEL[item] ?? item;
  if (!article) return base;
  const m = /^a(\d+)(?:c(\d+))?$/.exec(article);
  if (!m) return `${base}, ${article}`;
  return `${base}, art. ${m[1]}${m[2] ? ` c.${m[2]}` : ''}`;
}

/**
 * Source ids the old fixtures use for things that are not documents of the
 * case but pages of the knowledge base: `[item, article]` of that page.
 */
export const KNOWLEDGE_ALIAS: Record<string, [string, string?]> = {
  'd-classifica': ['piano-classifica-1996', 'riparto'],
};
