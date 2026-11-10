/**
 * Case 2404: a refund decision for a 2025 contribution paid twice, served on
 * the company through SEND and waiting for the notice to take effect. PEC
 * flow, path B, last steps (`b6` notice, `b7` refund), office Catasto e ruoli.
 *
 * Real: the Consorzio adopted SEND for notices with legal value in 05/2026
 * (DATI-VERI.md); a digital notice takes effect for the recipient on the
 * seventh day after delivery to its digital domicile, or when it opens SEND
 * first (art. 26 D.L. 76/2020). An example: the company, the IUN, the
 * amounts, the dates of the two payments, the protocol numbers.
 */
import type { CaseSeed } from '../types';
import { original } from './originals';

export const CASE_2404: CaseSeed = {
  id: '2404',
  org: 'nocera',
  kind: 'send',
  title: 'Rimborso notificato con SEND, contributo pagato due volte', // allow-italian: fixture data, shown as written
  subject: 'Provvedimento di rimborso del contributo consortile 2025 versato due volte', // allow-italian: fixture data, shown as written
  office: 'catasto',
  flow: 'pec',
  channel: 'pec',
  arrivedAt: '2026-10-26T10:40:00+01:00',
  protocol: { number: '2026/0017983', date: '2026-10-26' },
  counterpart: 'Impresa (esempio) S.r.l.', // allow-italian: fixture data, shown as written
  status: 'in-attesa',
  assignee: 'direzione',
  amount: 342.6,
  comune: 'Nocera Superiore',
  proposal: 'Catasto e ruoli · notifica perfezionata il 12/11', // allow-italian: fixture data, shown as written
  fields: [
    {
      id: 'iun', label: 'IUN', value: 'KQPT-WLZD-HRMV-202611-C-1', confidence: 99, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-send', page: 1, before: 'IUN ', highlight: 'KQPT-WLZD-HRMV-202611-C-1', after: ' Mittente' }, // allow-italian: fixture data, shown as written
      reasoning: ['Identificativo unico della notifica: con questo si ritrovano su SEND tutte le attestazioni.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'consegna', label: 'Consegna al domicilio digitale', value: '05/11/2026 alle 09:03', short: '05/11', confidence: 98, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-send', page: 1, before: 'Consegna al domicilio digitale ', highlight: '05/11/2026 09:03', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ['Il destinatario non è ancora entrato su SEND: la notifica si perfeziona il ', { strong: '12/11/2026' }, ', settimo giorno dopo la consegna.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'importo', label: 'Rimborso', value: '342,60 €', confidence: 97, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-provvedimento', page: 1, before: 'il rimborso di ', highlight: 'euro 342,60', after: ' a favore della Impresa Esempio S.r.l.' }, // allow-italian: fixture data, shown as written
      reasoning: ['In Prunes l\'avviso 2025/0057104/01 risulta pagato il 14/04 e il 16/04/2026, 342,60 € ogni volta: si rimborsa il secondo versamento.'], // allow-italian: fixture data, shown as written
    },
  ],
  deadlines: [
    {
      id: 'perfezionamento', label: 'Notifica perfezionata per il destinatario', // allow-italian: fixture data, shown as written
      from: '2026-11-05', days: 7, date: '2026-11-12', rollsOver: false,
      rule: 'art. 26 D.L. 76/2020',
      calc: 'Consegna al domicilio digitale il 05/11/2026: la notifica si perfeziona il settimo giorno successivo, giovedì 12/11/2026, o prima se l\'impresa accede a SEND. Da lì corrono i 30 giorni per il rimborso.', // allow-italian: fixture data, shown as written
      office: 'catasto',
    },
  ],
  steps: [
    { id: 'istanza', label: 'Istanza protocollata', flowStep: 'b4', state: 'done', at: '2026-10-26 10:52', by: 'Operatore del protocollo (esempio)' }, // allow-italian: fixture data, shown as written
    { id: 'istruttoria', label: 'Istruttoria', flowStep: 'b5', state: 'done', at: '2026-11-02 15:30', by: 'Catasto e ruoli' }, // allow-italian: fixture data, shown as written
    { id: 'notifica', label: 'Notifica con SEND', flowStep: 'b6', state: 'current' }, // allow-italian: fixture data, shown as written
    { id: 'rimborso', label: 'Rimborso', flowStep: 'b7', state: 'todo' }, // allow-italian: fixture data, shown as written
  ],
  documents: [
    {
      id: 'd-provvedimento', name: 'provvedimento-rimborso-2404.pdf.p7m', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: 'in partenza · 1 pagina · firmato', // allow-italian: fixture data, shown as written
      from: 'Servizio Catasto e Ruoli', receivedAt: '2026-11-03T12:10:00+01:00', signed: true, // allow-italian: fixture data, shown as written
      summary: [{ text: 'Rimborso di 342,60 € del contributo 2025 pagato due volte, entro 30 giorni dalla notifica.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2404', 'd-provvedimento', 1),
    },
    {
      id: 'd-send', name: 'attestazione-SEND.pdf', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: 'attestazione opponibile ai terzi · 1 pagina', // allow-italian: fixture data, shown as written
      from: 'SEND, Servizio Notifiche Digitali', receivedAt: '2026-11-05T09:03:00+01:00', // allow-italian: fixture data, shown as written
      summary: [{ text: 'Presa in carico il 04/11, consegnata al domicilio digitale il 05/11 alle 09:03; nessun accesso del destinatario.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2404', 'd-send', 1),
    },
  ],
  history: [
    { at: '2026-10-26 10:40', who: 'Flusso PEC', what: 'Istanza di rimborso arrivata via PEC' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-26 10:52', who: 'Operatore del protocollo (esempio)', what: 'Protocollata: 2026/0017983' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-02 15:30', who: 'Prunes', what: 'Due pagamenti dello stesso avviso: 14/04 e 16/04/2026' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-03 12:10', who: 'Halley', what: 'Provvedimento firmato, prot. 2026/0018318', doc: 'd-provvedimento' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-04 15:22', who: 'SEND', what: 'Notifica presa in carico, IUN KQPT-WLZD-HRMV-202611-C-1' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 09:03', who: 'SEND', what: 'Consegnata al domicilio digitale', doc: 'd-send' }, // allow-italian: fixture data, shown as written
  ],
  related: ['2395'],
  primaryAction: {
    label: 'Disponi il rimborso', // allow-italian: fixture data, shown as written
    kind: 'pay',
    receipt: {
      title: 'Mandato di pagamento emesso', // allow-italian: fixture data, shown as written
      lines: [
        'Mandato n. 1874/2026 (esempio) · beneficiario Impresa (esempio) S.r.l.', // allow-italian: fixture data, shown as written
        "Bonifico di 342,60 € sul conto indicato nell'istanza", // allow-italian: fixture data, shown as written
        'Rimborso registrato in Prunes sull\'avviso 2025/0057104/01', // allow-italian: fixture data, shown as written
      ],
    },
  },
  example: true,
};
