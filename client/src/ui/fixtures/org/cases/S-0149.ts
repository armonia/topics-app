/**
 * Case S-0149: a supplier invoice for a refuse truck repair, waiting for the
 * order match. SARIM, flow `sarim-fatture`, office Amministrazione.
 *
 * Real: SARIM's repetitive work includes supplier invoices and their
 * reconciliation, in SAP (training questionnaire, DATI-VERI.md). An example:
 * the workshop, the order, the codes, the amounts. Arithmetic: 1.690,00 +
 * 660,00 = 2.350,00; IVA 22% = 517,00; total 2.867,00. Between companies a
 * 60-day term must be agreed expressly (art. 4 c.4 D.Lgs. 231/2002).
 */
import type { CaseSeed } from '../types';
import { original } from './originals';

export const CASE_S0149: CaseSeed = {
  id: 'S-0149',
  org: 'sarim',
  kind: 'fattura',
  title: 'Fattura 1107/26, riparazione autocompattatore', // allow-italian: fixture data, shown as written
  subject: 'Fattura n. 1107/26 del 22/10/2026, sostituzione pompa idraulica', // allow-italian: fixture data, shown as written
  office: 'amministrazione',
  flow: 'sarim-fatture',
  channel: 'sdi',
  arrivedAt: '2026-10-22T15:41:00+02:00',
  counterpart: 'Officina (esempio) S.r.l.', // allow-italian: fixture data, shown as written
  status: 'in-attesa',
  assignee: 'attilio',
  amount: 2867,
  proposal: 'Amministrazione · in attesa del benestare sulle ore', // allow-italian: fixture data, shown as written
  fields: [
    {
      id: 'totale', label: 'Totale documento', value: '2.867,00 €', confidence: 99, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fattura', page: 1, before: 'Totale documento ', highlight: '2.867,00', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ['2.350,00 di imponibile più IVA 22% di 517,00: esatto.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'ordine', label: 'Ordine', value: '4500012345 del 08/10/2026', confidence: 95, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fattura', page: 1, before: '', highlight: 'Ordine n. 4500012345', after: ' 08-10-2026' }, // allow-italian: fixture data, shown as written
      reasoning: ["In SAP l'ordine copre il ricambio da 1.690,00 € ma non le 12 ore di manodopera: serve il benestare del responsabile mezzi."], // allow-italian: fixture data, shown as written
    },
    {
      id: 'giorni', label: 'Termine di pagamento', value: '60 giorni', confidence: 90, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fattura', page: 1, before: 'IT60X0542811101000000123456 ', highlight: '60', after: ' 2.867,00' }, // allow-italian: fixture data, shown as written
      reasoning: ['60 giorni come da contratto con l\'officina, dal ricevimento del 22/10: ', { strong: '21/12/2026' }, '.'], // allow-italian: fixture data, shown as written
    },
  ],
  deadlines: [
    {
      id: 'pagamento', label: "Pagamento all'officina", // allow-italian: fixture data, shown as written
      from: '2026-10-22', days: 60, date: '2026-12-21', rollsOver: true,
      rule: 'art. 4 c.4 D.Lgs. 231/2002, termine pattuito', // allow-italian: fixture data, shown as written
      calc: '60 giorni dal ricevimento della fattura, il 22/10/2026: lunedì 21/12/2026, lavorativo.', // allow-italian: fixture data, shown as written
      office: 'amministrazione',
    },
  ],
  steps: [
    { id: 'ricevuta', label: 'Ricevuta da SdI', flowStep: 's1', state: 'done', at: '2026-10-22 15:41', by: 'SdI' }, // allow-italian: fixture data, shown as written
    { id: 'registrata', label: 'Registrata', flowStep: 's2', state: 'done', at: '2026-10-23 09:30', by: 'SAP' }, // allow-italian: fixture data, shown as written
    { id: 'riconciliazione', label: "Riconciliazione con l'ordine", flowStep: 's3', state: 'current' }, // allow-italian: fixture data, shown as written
    { id: 'benestare', label: 'Benestare', flowStep: 's4', state: 'todo' }, // allow-italian: fixture data, shown as written
    { id: 'pagamento', label: 'Pagamento', flowStep: 's5', state: 'todo' }, // allow-italian: fixture data, shown as written
  ],
  documents: [
    {
      id: 'd-fattura', name: 'IT07654321090_01107.xml', kind: 'xml',
      detail: 'FatturaPA FPR12 · 1 pagina nel foglio di stile', // allow-italian: fixture data, shown as written
      from: 'Sistema di Interscambio', receivedAt: '2026-10-22T15:41:00+02:00', // allow-italian: fixture data, shown as written
      summary: [{ text: 'Pompa idraulica 1.690,00 € e 12 ore di officina 660,00 €; totale 2.867,00 € a 60 giorni.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('S-0149', 'd-fattura', 1),
    },
  ],
  history: [
    { at: '2026-10-22 15:41', who: 'SdI', what: 'Fattura consegnata', doc: 'd-fattura' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-23 09:30', who: 'SAP', what: 'Registrata in contabilità' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-23 09:31', who: 'AI', what: "Riconciliazione: l'ordine 4500012345 non copre le 12 ore di manodopera" }, // allow-italian: fixture data, shown as written
    { at: '2026-10-26 11:00', who: 'Amministrazione', what: 'Chiesto il benestare al responsabile mezzi' }, // allow-italian: fixture data, shown as written
  ],
  primaryAction: {
    label: 'Paga la fattura', // allow-italian: fixture data, shown as written
    kind: 'pay',
    receipt: {
      title: 'Bonifico disposto', // allow-italian: fixture data, shown as written
      lines: [
        'Beneficiario: Officina (esempio) S.r.l.', // allow-italian: fixture data, shown as written
        'Importo 2.867,00 € su IT60X0542811101000000123456', // allow-italian: fixture data, shown as written
        'Partita chiusa in SAP', // allow-italian: fixture data, shown as written
      ],
    },
  },
  example: true,
};
