/**
 * Case 2395: a hydraulic police report on the Torrente Lavinaio in
 * Bracigliano (earth moved and material dumped inside the 4 m strip). Flow
 * `concessioni`, hydraulic police branch (steps `v1`..`v5`), office Tecnico.
 *
 * Real: the Torrente Lavinaio in Bracigliano (DATI-VERI.md), the Consorzio as
 * hydraulic police authority (L.R. 7/2025 art. 10 c.2), R.D. 523/1904,
 * sanctions per L.R. 13/1983, the 90 days to notify a report not contested on
 * the spot (art. 14 L. 689/1981), SEND for notices with legal value. An
 * example: the parcel, the company, the measures, the report number. No
 * sanction amount is written: L.R. 13/1983 is not in the knowledge base yet.
 */
import type { CaseSeed } from '../types';
import { original } from './originals';

export const CASE_2395: CaseSeed = {
  id: '2395',
  org: 'nocera',
  kind: 'verbale',
  title: 'Verbale di polizia idraulica, Torrente Lavinaio', // allow-italian: fixture data, shown as written
  subject: 'Verbale di accertamento n. 37/2026, smovimento di terreno nella fascia di 4 m', // allow-italian: fixture data, shown as written
  office: 'tecnico',
  flow: 'verbale',
  channel: 'mail',
  arrivedAt: '2026-10-21T09:15:00+02:00',
  protocol: { number: '2026/0017764', date: '2026-10-21' },
  counterpart: 'Impresa edile (esempio)', // allow-italian: fixture data, shown as written
  status: 'in-lavorazione',
  assignee: 'direzione',
  comune: 'Bracigliano',
  parcel: { comune: 'Bracigliano', foglio: '7', particella: '233', canale: 'Torrente Lavinaio' },
  proposal: 'Tecnico · notifica via SEND entro 18/01', // allow-italian: fixture data, shown as written
  fields: [
    {
      id: 'norma', label: 'Norma violata', value: 'art. 96 lett. f) R.D. 523/1904', confidence: 93, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-verbale', page: 1, before: 'Il fatto viola ', highlight: "l'art. 96, lettera f), del R.D. 523/1904", after: ', che vieta lo smovimento del terreno' }, // allow-italian: fixture data, shown as written
      reasoning: ["Il Torrente Lavinaio è un corso d'acqua del reticolo regionale: vale il R.D. 523/1904, non il R.D. 368/1904 dei canali di bonifica", { source: { id: 'rd-523', label: 'R.D. 523/1904' } }, '.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'luogo', label: 'Luogo', value: 'Bracigliano, foglio 7, particella 233, sponda destra', confidence: 95, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-verbale', page: 1, before: 'in corrispondenza del fondo censito al ', highlight: 'foglio 7, particella 233', after: ', il deposito di materiale inerte' }, // allow-italian: fixture data, shown as written
      reasoning: ['Il punto è sul Torrente Lavinaio, in Comune di Bracigliano.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'distanza', label: 'Distanza dal ciglio', value: 'circa 2 m, su 25 m di sponda', confidence: 88, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-verbale', page: 1, before: 'lo smovimento del terreno ', highlight: 'a una distanza di circa 2 metri dal ciglio della sponda', after: ', per un tratto di circa 25 metri' }, // allow-italian: fixture data, shown as written
      reasoning: ['Il limite per lo smovimento del terreno è 4 metri: la distanza misurata è la metà.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'scadenza', label: 'Notifica entro', value: '18/01/2027', short: '18/01', confidence: 92, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-verbale', page: 1, before: 'Il giorno ', highlight: '20 ottobre 2026', after: ", alle ore 10:40, l'ufficiale idraulico" }, // allow-italian: fixture data, shown as written
      reasoning: ['Violazione non contestata sul posto: notifica entro 90 giorni dall\'accertamento (art. 14 L. 689/1981), ', { strong: '18/01/2027' }, '.'], // allow-italian: fixture data, shown as written
    },
  ],
  deadlines: [
    {
      id: 'notifica', label: 'Notifica del verbale al trasgressore', // allow-italian: fixture data, shown as written
      from: '2026-10-20', days: 90, date: '2027-01-18', rollsOver: false,
      rule: 'art. 14 c.2 L. 689/1981',
      calc: "90 giorni dall'accertamento del 20/10/2026: lunedì 18/01/2027. Termine amministrativo, non si sposta; conviene inviarlo su SEND con largo anticipo.", // allow-italian: fixture data, shown as written
      office: 'tecnico',
    },
  ],
  steps: [
    { id: 'accertamento', label: 'Accertamento', flowStep: 'v1', state: 'done', at: '2026-10-20 10:40', by: "Ufficiale idraulico (esempio)" }, // allow-italian: fixture data, shown as written
    { id: 'protocollo', label: 'Protocollato', flowStep: 'v2', state: 'done', at: '2026-10-21 09:15', by: 'Halley' }, // allow-italian: fixture data, shown as written
    { id: 'notifica', label: 'Notifica via SEND', flowStep: 'v3', state: 'current' }, // allow-italian: fixture data, shown as written
    { id: 'difese', label: 'Scritti difensivi, 30 giorni', flowStep: 'v4', state: 'todo' }, // allow-italian: fixture data, shown as written
    { id: 'ordinanza', label: 'Ordinanza o archiviazione', flowStep: 'v5', state: 'todo' }, // allow-italian: fixture data, shown as written
  ],
  documents: [
    {
      id: 'd-verbale', name: 'verbale-37-2026.pdf.p7m', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: '2 pagine · firmato · 4 foto nel fascicolo', // allow-italian: fixture data, shown as written
      from: 'Ufficiale idraulico (esempio)', receivedAt: '2026-10-21T09:15:00+02:00', signed: true, // allow-italian: fixture data, shown as written
      summary: [
        { text: 'Il 20/10/2026 sul Torrente Lavinaio: inerti e terreno smosso a circa 2 m dal ciglio, per 25 m.', page: 1 }, // allow-italian: fixture data, shown as written
        { text: 'Notifica via SEND entro 90 giorni; 30 giorni per gli scritti difensivi; ripristino entro 30 giorni.', page: 2 }, // allow-italian: fixture data, shown as written
      ],
      ...original('2395', 'd-verbale', 2),
    },
  ],
  history: [
    { at: '2026-10-20 10:40', who: 'Ufficiale idraulico (esempio)', what: 'Accertamento sul Torrente Lavinaio, 4 foto' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-21 09:15', who: 'Halley', what: 'Verbale protocollato: 2026/0017764', doc: 'd-verbale' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-21 09:16', who: 'Regola del flusso', what: 'Notifica entro il 18/01/2027' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-22 12:05', who: 'AI', what: "Proprietario del fondo trovato nelle visure: domicilio digitale in INI-PEC" }, // allow-italian: fixture data, shown as written
  ],
  related: ['2419'],
  norms: ['lr-7-2025/a10c2', 'rd-523', 'lr-13-1983'],
  primaryAction: {
    label: 'Notifica il verbale con SEND', // allow-italian: fixture data, shown as written
    kind: 'send-pec',
    receipt: {
      title: 'Notifica presa in carico da SEND', // allow-italian: fixture data, shown as written
      lines: [
        'IUN MZRT-QBVN-LKDA-202611-H-1 (esempio)', // allow-italian: fixture data, shown as written
        'Destinatario: Impresa edile (esempio), domicilio digitale da INI-PEC', // allow-italian: fixture data, shown as written
        'Presa in carico il 06/11/2026 alle 10:35', // allow-italian: fixture data, shown as written
        'Scritti difensivi: 30 giorni dal perfezionamento', // allow-italian: fixture data, shown as written
      ],
    },
  },
  example: true,
};
