/**
 * Case 2381: a request for an irrigation turn handed in at the counter,
 * served and closed. Flow `irrigua`, office Irrigazione.
 *
 * Real: San Valentino Torio in the Consorzio's area, the collective
 * irrigation network of 7 districts fed by wells (DATI-VERI.md). An example:
 * the farm, the parcel, the district number (the sources do not name the 7
 * districts, so the form marks the number as an example), the well, the
 * 3-day rule (declared as an internal example).
 */
import type { CaseSeed } from '../types';
import { original } from './originals';

export const CASE_2381: CaseSeed = {
  id: '2381',
  org: 'nocera',
  kind: 'irrigazione',
  title: 'Turno irriguo, finocchio a San Valentino Torio', // allow-italian: fixture data, shown as written
  subject: 'Richiesta di turno irriguo per il 14 e 15 ottobre 2026', // allow-italian: fixture data, shown as written
  office: 'irrigazione',
  flow: 'irrigua',
  channel: 'sportello',
  arrivedAt: '2026-10-12T08:50:00+02:00',
  counterpart: 'Azienda ortofrutticola (esempio)', // allow-italian: fixture data, shown as written
  status: 'chiusa', // allow-italian: fixture data, shown as written
  assignee: 'direzione',
  comune: 'San Valentino Torio',
  parcel: { comune: 'San Valentino Torio', foglio: '5', particella: '318' },
  proposal: 'Irrigazione · turno 14-15/10 assegnato', // allow-italian: fixture data, shown as written
  fields: [
    {
      id: 'giorni', label: 'Giorni richiesti', value: '14 e 15 ottobre 2026, ore 6-12', confidence: 86, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-richiesta', page: 1, before: 'Giorni richiesti ', highlight: '14 e 15 ottobre 2026, dalle 6 alle 12', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ['Letto dalla scrittura a mano del modulo: per questo sotto il 90%.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'bacino', label: 'Bacino', value: 'n. 4 (numerazione di esempio)', confidence: 90, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-richiesta', page: 1, before: 'Bacino di irrigazione ', highlight: 'n. 4', after: ' (numerazione di esempio)' }, // allow-italian: fixture data, shown as written
      reasoning: ['Uno dei 7 bacini di irrigazione collettiva; la particella è servita dal pozzo n. 12 nel telecontrollo.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'superficie', label: 'Superficie', value: '1,20 ha a finocchio', confidence: 88, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-richiesta', page: 1, before: 'Superficie da irrigare ', highlight: '1,20 ha', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ['La superficie entra nel calcolo delle ore di turno.'], // allow-italian: fixture data, shown as written
    },
  ],
  deadlines: [
    {
      id: 'assegnazione', label: 'Assegnazione del turno', // allow-italian: fixture data, shown as written
      from: '2026-10-12', days: 3, date: '2026-10-15', rollsOver: false,
      rule: 'regola interna di esempio: turno assegnato entro 3 giorni', // allow-italian: fixture data, shown as written
      calc: 'Richiesta del 12/10/2026: turno da assegnare entro giovedì 15/10. Assegnato e comunicato il 13/10.', // allow-italian: fixture data, shown as written
      office: 'irrigazione',
    },
  ],
  steps: [
    { id: 'ricevuta', label: 'Richiesta ricevuta', flowStep: 's1', state: 'done', at: '2026-10-12 08:50', by: 'Sportello' }, // allow-italian: fixture data, shown as written
    { id: 'verifica', label: 'Bacino e particella', flowStep: 's2', state: 'done', at: '2026-10-12 09:20', by: 'AI' }, // allow-italian: fixture data, shown as written
    { id: 'turno', label: 'Turno assegnato', flowStep: 's3', state: 'done', at: '2026-10-13 09:10', by: 'Irrigazione' }, // allow-italian: fixture data, shown as written
    { id: 'comunicato', label: "Comunicato all'utente", flowStep: 's4', state: 'done', at: '2026-10-13 09:15', by: 'SMS' }, // allow-italian: fixture data, shown as written
    { id: 'erogazione', label: 'Erogazione e chiusura', flowStep: 's5', state: 'done', at: '2026-10-15 12:05', by: 'Telecontrollo' }, // allow-italian: fixture data, shown as written
  ],
  documents: [
    {
      id: 'd-richiesta', name: 'richiesta-turno.pdf', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: 'modulo cartaceo scansionato · 1 pagina', // allow-italian: fixture data, shown as written
      from: 'Sportello del Servizio Irrigazione', receivedAt: '2026-10-12T08:50:00+02:00', // allow-italian: fixture data, shown as written
      summary: [{ text: 'Turno per 1,20 ha di finocchio il 14 e 15 ottobre, ore 6-12; assegnato sul pozzo n. 12.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2381', 'd-richiesta', 1),
    },
  ],
  history: [
    { at: '2026-10-12 08:50', who: 'Sportello', what: 'Modulo scansionato e caricato', doc: 'd-richiesta' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-12 09:20', who: 'AI', what: 'Letto il modulo: bacino n. 4, 1,20 ha, 14 e 15 ottobre' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-13 09:10', who: 'Irrigazione', what: 'Turno assegnato: 14 e 15/10, ore 6-12, pozzo n. 12' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-13 09:15', who: 'SMS', what: "Turno comunicato all'utente" }, // allow-italian: fixture data, shown as written
    { at: '2026-10-15 12:05', who: 'Telecontrollo', what: 'Erogazione conclusa, pratica chiusa' }, // allow-italian: fixture data, shown as written
  ],
  primaryAction: {
    label: 'Comunica il turno', // allow-italian: fixture data, shown as written
    kind: 'reply',
    receipt: {
      title: 'Turno comunicato', // allow-italian: fixture data, shown as written
      lines: [
        'SMS al +39 3•• ••• ••18 del 13/10/2026 alle 09:15', // allow-italian: fixture data, shown as written
        'Turno: 14 e 15/10, ore 6-12, pozzo n. 12 (esempio)', // allow-italian: fixture data, shown as written
        'Consegnato', // allow-italian: fixture data, shown as written
      ],
    },
  },
  example: true,
};
