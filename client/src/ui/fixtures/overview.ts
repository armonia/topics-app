/**
 * Fixture of n18: the Consorzio's month at full speed, as an estimate. Every
 * number is a declared example; they agree with each other: the rows sum to
 * the 1.910 of the first tile, their weighted share to a person is the 22%,
 * the 5 + 1 records waiting are the ones in the last column (the 5 of the
 * protocol queue in n12), and the days of
 * October 2026 (the 1st is a Thursday) sum to 1.910 again, with weekends on
 * the 3-4, 10-11, 17-18, 24-25 and 31.
 */
import type { DayValueModel, OverviewModel } from '../overview/model';

export const WEEKDAY_SHORT = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab']; // allow-italian: fixture data, shown as written

/** Records per day, 1 to 31 October 2026. */
const OCTOBER = [78, 71, 26, 11, 88, 84, 80, 77, 66, 22, 13, 91, 80, 79, 82, 69, 28, 10, 86, 83, 78, 80, 64, 25, 14, 90, 85, 81, 76, 70, 23];

const DAYS: DayValueModel[] = OCTOBER.map((value, i) => {
  const weekday = new Date(2026, 9, i + 1).getDay();
  return { id: `d${i + 1}`, label: `${WEEKDAY_SHORT[weekday]} ${i + 1} ott`, value, weekend: weekday === 0 || weekday === 6 };
});

export const MONTH_OVERVIEW: OverviewModel = {
  crumbs: [{ label: 'Panoramica', detail: 'stima mensile a regime' }], // allow-italian: fixture data, shown as written
  tiles: [
    { id: 'k-volume', value: '1.910', label: 'Pratiche nei flussi al mese, stima', detail: 'somma delle righe sotto', icon: 'folder' }, // allow-italian: fixture data, shown as written
    { id: 'k-person', value: '22%', label: 'Decise da una persona, stima', detail: 'il resto è sopra soglia', icon: 'gauge' }, // allow-italian: fixture data, shown as written
    { id: 'k-hours', value: '214', label: 'Ore di lavoro tolte al mese, stima', detail: 'minuti a mano per pratica × pratiche', icon: 'clock' }, // allow-italian: fixture data, shown as written
    { id: 'k-stuck', value: '6', label: 'Ferme da persone adesso', detail: '5 al Protocollo, 1 al Legale', icon: 'alert', attention: true }, // allow-italian: fixture data, shown as written
  ],
  flows: [
    { id: 'f-pec', name: 'PEC in arrivo → protocollo', perMonth: '1.204', avgTime: '11 min', toPerson: 22, corrected: '3,1%', errors: '1', stuck: 'Protocollo · 5' }, // allow-italian: fixture data, shown as written
    { id: 'f-fatture', name: 'Fattura passiva → pagamento', perMonth: '204', avgTime: '2,4 gg', toPerson: 35, corrected: '5,8%', errors: '2' }, // allow-italian: fixture data, shown as written
    { id: 'f-irrigua', name: 'Richiesta irrigua → turno', perMonth: '388', avgTime: '1,1 gg', toPerson: 18, corrected: '1,9%', errors: '0' }, // allow-italian: fixture data, shown as written
    { id: 'f-gara', name: 'Gara → determina', perMonth: '9', avgTime: '6 gg', toPerson: 100, errors: '0', stuck: 'Legale · 1' },
    { id: 'f-personale', name: 'Scadenzario personale', perMonth: '105', avgTime: 'subito', toPerson: 8, corrected: '0%', errors: '0' }, // allow-italian: fixture data, shown as written
  ],
  insight: [
    'Le fatture in split payment vengono corrette nel ', // allow-italian: fixture data, shown as written
    { strong: '41% dei casi' }, // allow-italian: fixture data, shown as written
    ": una regola fissa prima dell'AI le toglie. Il robot su Halley ha sbagliato ", // allow-italian: fixture data, shown as written
    { strong: '1 volta su 412' }, // allow-italian: fixture data, shown as written
    " in 30 giorni: la soglia all'85% è già in collaudo nella versione 5, giorno 4 di 7.", // allow-italian: fixture data, shown as written
  ],
  chart: {
    title: 'Pratiche per giorno', // allow-italian: fixture data, shown as written
    note: 'esempio', // allow-italian: fixture data, shown as written
    days: DAYS,
    max: 100,
    axis: [{ index: 0, label: '1 ott' }, { index: 7, label: '8' }, { index: 14, label: '15' }, { index: 21, label: '22' }, { index: 30, label: '31 ott' }],
  },
};

/* ------------------------------------------------------------------------
 * The live overview (the connected preview computes everything below from the
 * flows of `org/flows.ts` and the cases; nothing here is a total).
 * ------------------------------------------------------------------------ */

/** What the example says about one flow's month besides its volume (an estimate, all of it). */
export interface FlowStatSeed {
  avgTime: string;
  /** Share decided by a person, 0..100. */
  toPerson: number;
  /** Missing when every record goes to a person anyway. */
  corrected?: string;
  /** Mistakes in a month. */
  errors: number;
  /** Minutes a person spent by hand per item before the flow: «ore tolte» = items × this. */
  manualMinutes: number;
}

/** By flow id (`org/flows.ts`). A flow missing here has no stats and is left out of the overview. */
export const FLOW_STATS: Record<string, FlowStatSeed> = {
  pec: { avgTime: '11 min', toPerson: 22, corrected: '3,1%', errors: 1, manualMinutes: 7 }, // allow-italian: fixture data, shown as written
  fatture: { avgTime: '2,4 gg', toPerson: 35, corrected: '5,8%', errors: 2, manualMinutes: 14 }, // allow-italian: fixture data, shown as written
  irrigua: { avgTime: '1,1 gg', toPerson: 18, corrected: '1,9%', errors: 0, manualMinutes: 3 }, // allow-italian: fixture data, shown as written
  gara: { avgTime: '6 gg', toPerson: 100, errors: 0, manualMinutes: 30 }, // allow-italian: fixture data, shown as written
  personale: { avgTime: 'subito', toPerson: 8, corrected: '0%', errors: 0, manualMinutes: 1 }, // allow-italian: fixture data, shown as written
  segnalazioni: { avgTime: '3,2 h', toPerson: 45, corrected: '4,0%', errors: 1, manualMinutes: 20 }, // allow-italian: fixture data, shown as written
  concessioni: { avgTime: '4 gg', toPerson: 100, errors: 0, manualMinutes: 90 }, // allow-italian: fixture data, shown as written
  verbale: { avgTime: '30 gg', toPerson: 100, errors: 0, manualMinutes: 45 }, // allow-italian: fixture data, shown as written; ends at the 30-day term for the defence, an officer and the Direction decide
};

/** Records per day in October 2026 as a shape: the month total is spread over these weights. */
export const MONTH_SHAPE = [78, 71, 26, 11, 88, 84, 80, 77, 66, 22, 13, 91, 80, 79, 82, 69, 28, 10, 86, 83, 78, 80, 64, 25, 14, 90, 85, 81, 76, 70, 23];

/** The twelve months ending in October 2026 with their volume relative to October (October = 1). */
export const YEAR_MONTHS: Array<{ id: string; label: string; factor: number }> = [
  { id: 'm-2025-11', label: 'nov', factor: 0.96 }, // allow-italian: fixture data, shown as written
  { id: 'm-2025-12', label: 'dic', factor: 0.78 }, // allow-italian: fixture data, shown as written
  { id: 'm-2026-01', label: 'gen', factor: 0.92 }, // allow-italian: fixture data, shown as written
  { id: 'm-2026-02', label: 'feb', factor: 0.97 },
  { id: 'm-2026-03', label: 'mar', factor: 1.02 },
  { id: 'm-2026-04', label: 'apr', factor: 1.01 },
  { id: 'm-2026-05', label: 'mag', factor: 1.04 }, // allow-italian: fixture data, shown as written
  { id: 'm-2026-06', label: 'giu', factor: 0.99 }, // allow-italian: fixture data, shown as written
  { id: 'm-2026-07', label: 'lug', factor: 0.94 }, // allow-italian: fixture data, shown as written
  { id: 'm-2026-08', label: 'ago', factor: 0.58 }, // allow-italian: fixture data, shown as written
  { id: 'm-2026-09', label: 'set', factor: 0.93 }, // allow-italian: fixture data, shown as written
  { id: 'm-2026-10', label: 'ott', factor: 1 }, // allow-italian: fixture data, shown as written
];

/** What the week is: the last seven days of the month series (Sunday 25 to Saturday 31 October). */
export const WEEK_START_INDEX = 24;

/** The words of the four tiles and of the table's volume column, per period. */
export const OVERVIEW_WORDS = {
  week: {
    detail: 'ultimi 7 giorni del mese, stima', // allow-italian: fixture data, shown as written
    volume: 'Pratiche nei flussi nella settimana, stima', // allow-italian: fixture data, shown as written
    hours: 'Ore di lavoro tolte nella settimana, stima', // allow-italian: fixture data, shown as written
    chart: 'Pratiche per giorno', // allow-italian: fixture data, shown as written
    volumeColumn: 'Nella settimana, stima', // allow-italian: fixture data, shown as written
  },
  month: {
    detail: 'stima mensile a regime', // allow-italian: fixture data, shown as written
    volume: 'Pratiche nei flussi al mese, stima', // allow-italian: fixture data, shown as written
    hours: 'Ore di lavoro tolte al mese, stima', // allow-italian: fixture data, shown as written
    chart: 'Pratiche per giorno', // allow-italian: fixture data, shown as written
    volumeColumn: 'Al mese, stima', // allow-italian: fixture data, shown as written
  },
  year: {
    detail: 'ultimi 12 mesi, stima a regime', // allow-italian: fixture data, shown as written
    volume: 'Pratiche nei flussi in 12 mesi, stima', // allow-italian: fixture data, shown as written
    hours: 'Ore di lavoro tolte in 12 mesi, stima', // allow-italian: fixture data, shown as written
    chart: 'Pratiche per mese', // allow-italian: fixture data, shown as written
    volumeColumn: 'In 12 mesi, stima', // allow-italian: fixture data, shown as written
  },
} as const;

export const OVERVIEW_TILE_WORDS = {
  person: { label: 'Decise da una persona, stima', detail: 'il resto è sopra soglia' }, // allow-italian: fixture data, shown as written
  stuck: { label: 'Ferme da persone adesso' }, // allow-italian: fixture data, shown as written
  volumeDetail: 'somma delle righe sotto', // allow-italian: fixture data, shown as written
  hoursDetail: 'minuti a mano per pratica × pratiche', // allow-italian: fixture data, shown as written
  chartNote: 'esempio', // allow-italian: fixture data, shown as written
  rootLabel: 'Panoramica', // allow-italian: fixture data, shown as written
};

/** The short name of October, for the axis labels of the day bars. */
export const OCTOBER_SHORT = 'ott'; // allow-italian: fixture data, shown as written

export const OVERVIEW_INSIGHT = MONTH_OVERVIEW.insight;
