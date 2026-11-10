/**
 * Case 2409: a supplier invoice received through SdI for the overhaul of the
 * electric pumps of the irrigation wells. Flow `fatture`, office Ragioneria.
 * Accepted on SdI within its 15 days, now to pay within 30 days of receipt.
 *
 * Real: the Consorzio's wells (DATI-VERI.md: 55 wells feed the irrigation
 * network), TeamSystem for the accounts, split payment (art. 17-ter DPR
 * 633/1972), the 15 days before SdI closes an invoice by default (D.M.
 * 55/2013), the 30 days of art. 4 D.Lgs. 231/2002, the 120-day DURC, the CIG
 * in the transfer (art. 3 L. 136/2010). An example: the supplier, the order,
 * the CIG, the codes, the IBAN (the standard example IBAN), every amount.
 * Arithmetic: 2.700,00 + 1.480,00 + 680,00 = 4.860,00; IVA 22% = 1.069,20;
 * total 5.929,20; the supplier is paid 4.860,00.
 */
import type { CaseSeed } from '../types';
import { original } from './originals';

export const CASE_2409: CaseSeed = {
  id: '2409',
  org: 'nocera',
  kind: 'fattura',
  title: 'Fattura 318/PA, elettropompe dei pozzi', // allow-italian: fixture data, shown as written
  subject: 'Fattura n. 318/PA del 26/10/2026, revisione delle elettropompe dei pozzi irrigui', // allow-italian: fixture data, shown as written
  office: 'ragioneria',
  flow: 'fatture',
  channel: 'sdi',
  arrivedAt: '2026-10-27T11:05:00+01:00',
  protocol: { number: '2026/0018040', date: '2026-10-27' },
  counterpart: 'Fornitore (esempio) S.r.l.', // allow-italian: fixture data, shown as written
  status: 'in-lavorazione',
  assignee: 'direzione',
  amount: 5929.2,
  proposal: 'Ragioneria · pagamento entro 26/11', // allow-italian: fixture data, shown as written
  fields: [
    {
      id: 'fornitore', label: 'Fornitore', value: 'Fornitore (esempio) S.r.l., P.IVA IT09876543210', confidence: 99, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fattura', page: 1, before: 'Identificativo fiscale ai fini IVA: ', highlight: 'IT09876543210', after: ' Codice fiscale: 09876543210 Denominazione: FORNITORE ESEMPIO S.R.L.' }, // allow-italian: fixture data, shown as written
      reasoning: ['In anagrafica TeamSystem con lo stesso IBAN della dichiarazione di conto dedicato.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'numero', label: 'Numero e data', value: '318/PA del 26/10/2026', confidence: 99, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fattura', page: 1, before: 'TD01 fattura ', highlight: '318/PA 26-10-2026', after: ' UF4K2Q' }, // allow-italian: fixture data, shown as written
      reasoning: ['Fattura ordinaria (TD01), non nota di credito.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'imponibile', label: 'Imponibile', value: '4.860,00 €', confidence: 99, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fattura', page: 1, before: 'art. 17-ter DPR 633/1972 22,00 ', highlight: '4.860,00', after: ' 1.069,20' }, // allow-italian: fixture data, shown as written
      reasoning: ['Somma delle tre righe: 2.700,00 + 1.480,00 + 680,00 = ', { strong: '4.860,00 €' }, '.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'iva', label: 'IVA in scissione', value: '1.069,20 € · split payment', confidence: 97, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fattura', page: 1, before: '', highlight: 'S (scissione dei pagamenti) · art. 17-ter DPR 633/1972', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ['22% di 4.860,00 = 1.069,20 €: esatta. Esigibilità «S»: il Consorzio paga al fornitore solo l\'imponibile e versa l\'IVA all\'Erario con F24 entro il 16 del mese dopo il pagamento.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'totale', label: 'Totale documento', value: '5.929,20 €', confidence: 99, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fattura', page: 1, before: 'Totale documento ', highlight: '5.929,20', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ['4.860,00 + 1.069,20 = 5.929,20 €. Al fornitore vanno ', { strong: '4.860,00 €' }, ', come l\'importo del pagamento in fattura.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'cig', label: 'CIG', value: 'B4F7A20C9E', confidence: 98, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fattura', page: 1, before: 'Ordine n. 2026/0187 02-10-2026 ', highlight: 'B4F7A20C9E', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ["Coincide con il CIG dell'ordine 2026/0187 in TeamSystem. Senza CIG la fattura andrebbe rifiutata e non si potrebbe pagare."], // allow-italian: fixture data, shown as written
    },
    {
      id: 'destinatario', label: 'Codice destinatario', value: 'UF4K2Q · Ragioneria', confidence: 96, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fattura', page: 1, before: '318/PA 26-10-2026 ', highlight: 'UF4K2Q', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ['È il codice univoco ufficio della Ragioneria (codice di esempio).'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'durc', label: 'DURC', value: 'Regolare, valido fino al 25/02/2027', short: '25/02/2027', confidence: 99, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-durc', page: 1, before: 'Scadenza validità ', highlight: '25/02/2027', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ['Richiesto il 28/10, vale 120 giorni: copre il pagamento del 26/11.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'scadenza', label: 'Scadenza del pagamento', value: '26/11/2026', short: '26/11', confidence: 91, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fattura', page: 1, before: 'consegnato dal Sistema di Interscambio il ', highlight: '27/10/2026 alle 11:05', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ['30 giorni dal ricevimento della fattura, cioè dalla consegna di SdI, non dalla data del documento: ', { strong: '26/11/2026' }, ' (art. 4 D.Lgs. 231/2002).'], // allow-italian: fixture data, shown as written
    },
  ],
  deadlines: [
    {
      id: 'esito-sdi', label: 'Esito su SdI: accettazione o rifiuto', // allow-italian: fixture data, shown as written
      from: '2026-10-27', days: 15, date: '2026-11-11', rollsOver: false,
      rule: 'D.M. 55/2013 e specifiche tecniche SdI', // allow-italian: fixture data, shown as written
      calc: '15 giorni dalla consegna del 27/10/2026: mercoledì 11/11/2026; dopo, SdI chiude la fattura per decorrenza termini. Esito inviato il 03/11: accettata.', // allow-italian: fixture data, shown as written
      office: 'ragioneria',
    },
    {
      id: 'pagamento', label: 'Pagamento al fornitore', // allow-italian: fixture data, shown as written
      from: '2026-10-27', days: 30, date: '2026-11-26', rollsOver: true,
      rule: 'art. 4 c.2 lett. a) D.Lgs. 231/2002',
      calc: '30 giorni dal ricevimento della fattura, il 27/10/2026: giovedì 26/11/2026, lavorativo. Se cadesse di festivo slitterebbe al primo giorno lavorativo dopo (art. 1187 e 2963 c.c.).', // allow-italian: fixture data, shown as written
      office: 'ragioneria',
    },
  ],
  steps: [
    { id: 'ricevuta', label: 'Ricevuta da SdI', flowStep: 's1', state: 'done', at: '2026-10-27 11:05', by: 'SdI' }, // allow-italian: fixture data, shown as written
    { id: 'controlli', label: 'Controlli', flowStep: 's2', state: 'done', at: '2026-10-28 09:40', by: 'AI' }, // allow-italian: fixture data, shown as written
    { id: 'esito', label: 'Accettata su SdI', flowStep: 's3', state: 'done', at: '2026-11-03 10:12', by: 'Ragioneria' }, // allow-italian: fixture data, shown as written
    { id: 'liquidazione', label: 'Liquidazione', flowStep: 's4', state: 'current' }, // allow-italian: fixture data, shown as written
    { id: 'pagamento', label: 'Pagamento', flowStep: 's5', state: 'todo' }, // allow-italian: fixture data, shown as written
  ],
  documents: [
    {
      id: 'd-fattura', name: 'IT09876543210_00318.xml', kind: 'xml',
      detail: 'FatturaPA FPA12 · 1 pagina nel foglio di stile', // allow-italian: fixture data, shown as written
      from: 'Sistema di Interscambio', receivedAt: '2026-10-27T11:05:00+01:00', // allow-italian: fixture data, shown as written
      summary: [
        { text: 'Tre righe per la revisione delle elettropompe dei pozzi irrigui: imponibile 4.860,00 €.', page: 1 }, // allow-italian: fixture data, shown as written
        { text: 'IVA 22% di 1.069,20 € in scissione dei pagamenti; totale 5.929,20 €, al fornitore 4.860,00 €.', page: 1 }, // allow-italian: fixture data, shown as written
        { text: 'CIG B4F7A20C9E e ordine 2026/0187; bonifico a 30 giorni.', page: 1 }, // allow-italian: fixture data, shown as written
      ],
      ...original('2409', 'd-fattura', 1),
    },
    {
      id: 'd-durc', name: 'DURC_INAIL_51234567.pdf', kind: 'pdf',
      detail: 'Durc On Line · regolare · 1 pagina', // allow-italian: fixture data, shown as written
      from: 'Durc On Line, INAIL e INPS', receivedAt: '2026-10-28T09:38:00+01:00', // allow-italian: fixture data, shown as written
      summary: [{ text: 'Regolare verso INPS e INAIL, richiesto il 28/10/2026, valido fino al 25/02/2027.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2409', 'd-durc', 1),
    },
  ],
  history: [
    { at: '2026-10-27 11:05', who: 'SdI', what: 'Fattura consegnata al codice UF4K2Q', doc: 'd-fattura' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-27 11:06', who: 'AI', what: 'Letta: CIG presente, IVA 22% esatta, esigibilità in scissione dei pagamenti' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-27 11:07', who: 'TeamSystem', what: 'Ordine 2026/0187 trovato con lo stesso CIG; fattura registrata' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-28 09:38', who: 'Durc On Line', what: 'DURC regolare, valido fino al 25/02/2027', doc: 'd-durc' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-02 16:20', who: 'Area Tecnica', what: 'Regolare esecuzione attestata: pompe revisionate e in servizio' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-03 10:12', who: 'Ragioneria', what: 'Esito su SdI: accettata' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 11:30', who: 'Assistente della pratica', what: 'Bozza della determina di liquidazione preparata' }, // allow-italian: fixture data, shown as written
  ],
  draft: {
    file: 'liquidazione-318PA.docx',
    meta: 'preparata 05/11 · da firmare', // allow-italian: fixture data, shown as written
    blocks: [
      { kind: 'heading', lines: ['Consorzio di Bonifica Integrale Comprensorio Sarno', 'Determinazione di liquidazione'] }, // allow-italian: fixture data, shown as written
      {
        kind: 'paragraph',
        text: ['Vista la fattura n. 318/PA del 26/10/2026 della Fornitore (esempio) S.r.l., consegnata da SdI il 27/10/2026', { source: { id: 'd-fattura', label: 'fattura', page: 1 } }, ', relativa all\'ordine n. 2026/0187, CIG B4F7A20C9E;'], // allow-italian: fixture data, shown as written
      },
      {
        kind: 'paragraph',
        text: ['accertata la regolarità contributiva', { source: { id: 'd-durc', label: 'DURC', page: 1 } }, " e attestata dall'Area Tecnica la regolare esecuzione;"], // allow-italian: fixture data, shown as written
      },
      {
        kind: 'paragraph',
        lead: 'si liquida', // allow-italian: fixture data, shown as written
        text: ["al fornitore l'imponibile di euro 4.860,00 e si trattiene l'IVA di euro 1.069,20, da versare all'Erario in scissione dei pagamenti (art. 17-ter DPR 633/1972), per un totale di euro 5.929,20."], // allow-italian: fixture data, shown as written
      },
      { kind: 'proposal', text: 'Nel mandato riportare il CIG B4F7A20C9E nella causale del bonifico: lo chiede la tracciabilità dei flussi finanziari (art. 3 L. 136/2010).' }, // allow-italian: fixture data, shown as written
    ],
  },
  assistant: {
    description: 'Vede solo questa pratica, i suoi documenti e la Conoscenza.', // allow-italian: fixture data, shown as written
    turns: [
      { role: 'user', text: ['Il DURC copre anche il pagamento?'] }, // allow-italian: fixture data, shown as written
      { role: 'assistant', text: ['Sì: richiesto il 28/10, vale 120 giorni, fino al 25/02/2027', { source: { id: 'd-durc', page: 1 } }, '. Il pagamento scade il 26/11.'] }, // allow-italian: fixture data, shown as written
      { role: 'user', text: ["L'IBAN è quello del conto dedicato?"] }, // allow-italian: fixture data, shown as written
      { role: 'assistant', text: ["Sì, l'IBAN in fattura", { source: { id: 'd-fattura', page: 1 } }, ' è lo stesso della dichiarazione di conto dedicato in anagrafica TeamSystem.'] }, // allow-italian: fixture data, shown as written
    ],
    checklist: [
      { id: 'c1', text: 'CIG e ordine', done: true }, // allow-italian: fixture data, shown as written
      { id: 'c2', text: 'DURC regolare', done: true }, // allow-italian: fixture data, shown as written
      { id: 'c3', text: 'IVA e scissione dei pagamenti', done: true }, // allow-italian: fixture data, shown as written
      { id: 'c4', text: 'Regolare esecuzione dal Tecnico', done: true }, // allow-italian: fixture data, shown as written
      { id: 'c5', text: 'Determina di liquidazione firmata', done: false }, // allow-italian: fixture data, shown as written
      { id: 'c6', text: 'Mandato entro il 26/11', done: false }, // allow-italian: fixture data, shown as written
    ],
  },
  norms: ['dpr-633-1972/a17ter', 'dlgs-231-2002/a4', 'l-136-2010/a3'],
  primaryAction: {
    label: 'Emetti il mandato di pagamento', // allow-italian: fixture data, shown as written
    kind: 'pay',
    receipt: {
      title: 'Mandato di pagamento emesso', // allow-italian: fixture data, shown as written
      lines: [
        'Mandato n. 1873/2026 (esempio) · beneficiario Fornitore (esempio) S.r.l.', // allow-italian: fixture data, shown as written
        'Bonifico di 4.860,00 € su IT60X0542811101000000123456, causale con CIG B4F7A20C9E', // allow-italian: fixture data, shown as written
        "IVA 1.069,20 € trattenuta: versamento con F24 entro il 16/12/2026", // allow-italian: fixture data, shown as written
        'Trasmesso al tesoriere il 06/11/2026 alle 10:34', // allow-italian: fixture data, shown as written
      ],
    },
  },
  example: true,
};
