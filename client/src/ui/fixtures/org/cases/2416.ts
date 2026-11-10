/**
 * Case 2416: a request to cancel the 2026 contribution (istanza di sgravio)
 * because the parcel was sold before the 2026 roll was formed. PEC flow,
 * path B, office Catasto e ruoli.
 *
 * Real: the Consorzio, Mercato San Severino in its district, Prunes for the
 * consortium cadastre, the 30-day term of art. 2 c.2 L. 241/1990 counted from
 * receipt (c.6). An example: the company, the buyer, the deed, the parcel, the
 * amounts, the protocol number (the one Halley gives on confirmation).
 */
import type { CaseSeed } from '../types';
import { original } from './originals';

export const CASE_2416: CaseSeed = {
  id: '2416',
  org: 'nocera',
  kind: 'sgravio',
  title: 'Sgravio 2026, terreno venduto nel 2025', // allow-italian: fixture data, shown as written
  subject: 'Istanza di sgravio del contributo consortile 2026 e richiesta di voltura', // allow-italian: fixture data, shown as written
  office: 'catasto',
  flow: 'pec',
  channel: 'pec',
  arrivedAt: '2026-11-04T11:37:00+01:00',
  protocol: { number: '2026/0018369', date: '2026-11-04' },
  counterpart: 'Immobiliare (esempio) S.r.l.', // allow-italian: fixture data, shown as written
  status: 'da-confermare',
  assignee: 'protocollo',
  amount: 217.4,
  comune: 'Mercato San Severino',
  parcel: { comune: 'Mercato San Severino', foglio: '22', particella: '1187' },
  proposal: 'Catasto e ruoli · risposta entro 04/12', // allow-italian: fixture data, shown as written
  fields: [
    {
      id: 'ufficio', label: 'Ufficio', value: 'Catasto e ruoli', confidence: 94, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-istanza', page: 1, before: 'Consorzio di Bonifica Integrale Comprensorio Sarno ', highlight: 'Servizio Catasto e Ruoli', after: ' Nocera Inferiore (SA)' }, // allow-italian: fixture data, shown as written
      reasoning: ["L'istanza è indirizzata al Servizio Catasto e Ruoli e chiede uno sgravio con voltura: è il ", { strong: 'percorso B' }, ', istanza del contribuente.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'tipo', label: 'Tipo', value: 'Istanza di sgravio totale con voltura', confidence: 91, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-istanza', page: 1, before: 'chiede ', highlight: "lo sgravio totale dell'avviso n. 2026/0063390/01", after: ' e la voltura della partita' }, // allow-italian: fixture data, shown as written
      reasoning: ['Chiede lo sgravio ', { strong: 'totale' }, ", non un rimborso: l'avviso non risulta pagato in Prunes."], // allow-italian: fixture data, shown as written
    },
    {
      id: 'avviso', label: 'Avviso', value: '2026/0063390/01 · 217,40 €', confidence: 98, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-avviso', page: 1, before: '', highlight: 'Avviso n. 2026/0063390/01 del 30/09/2026', after: ' Codice contribuente: C-0063390' }, // allow-italian: fixture data, shown as written
      reasoning: ["Stesso numero nell'istanza", { source: { id: 'd-istanza', page: 1 } }, " e in Prunes, codice contribuente C-0063390, importo ", { strong: '217,40 €' }, '.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'particella', label: 'Particella', value: 'Mercato San Severino, foglio 22, particella 1187', confidence: 97, consulted: 3, // allow-italian: fixture data, shown as written
      source: { doc: 'd-trascrizione', page: 1, before: 'Identificativo ', highlight: 'foglio 22, particella 1187', after: ' Natura e consistenza' }, // allow-italian: fixture data, shown as written
      reasoning: ["La stessa particella è nell'avviso", { source: { id: 'd-avviso', page: 1 } }, ' e nella nota di trascrizione: 48 are e 20 centiare.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'vendita', label: 'Data della vendita', value: '12/03/2025, trascritta il 20/03/2025', short: '12/03/2025', confidence: 93, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-trascrizione', page: 1, before: "Data dell'atto ", highlight: '12/03/2025', after: ' Pubblico ufficiale' }, // allow-italian: fixture data, shown as written
      reasoning: ['La vendita è precedente al ruolo 2026: per quell\'anno il contributo spetta all\'acquirente. In Prunes la particella è ancora intestata alla società, quindi la ', { strong: 'voltura' }, ' manca.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'scadenza', label: 'Scadenza', value: '04/12/2026 · risposta', short: '04/12', confidence: 89, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-istanza', page: 2, before: '', highlight: 'Mercato San Severino, 3 novembre 2026', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ["L'istanza è datata 3 novembre ma il termine corre dal ", { strong: 'ricevimento' }, ', la PEC del 04/11/2026 (art. 2 c.6 L. 241/1990): 30 giorni, ', { strong: '04/12/2026' }, '.'], // allow-italian: fixture data, shown as written
    },
  ],
  deadlines: [
    {
      id: 'risposta', label: "Provvedimento sull'istanza", // allow-italian: fixture data, shown as written
      from: '2026-11-04', days: 30, date: '2026-12-04', rollsOver: false,
      rule: 'art. 2 c.2 e c.6 L. 241/1990',
      calc: "30 giorni dal ricevimento dell'istanza, il 04/11/2026: venerdì 04/12/2026. È un termine amministrativo: non si sposta se cade di sabato o di festivo, perché la legge non lo prevede.", // allow-italian: fixture data, shown as written
      office: 'catasto',
    },
  ],
  steps: [
    { id: 'arrivata', label: 'Arrivata', flowStep: 'trigger', state: 'done', at: '2026-11-04 11:37', by: 'Flusso PEC' }, // allow-italian: fixture data, shown as written
    { id: 'classificata', label: 'Classificata', flowStep: 's2', state: 'done', at: '2026-11-04 11:38', by: 'AI' }, // allow-italian: fixture data, shown as written
    { id: 'protocollata', label: 'Protocollata', flowStep: 'b4', state: 'current' }, // allow-italian: fixture data, shown as written
    { id: 'istruttoria', label: 'Istruttoria', flowStep: 'b5', state: 'todo' }, // allow-italian: fixture data, shown as written
    { id: 'provvedimento', label: 'Provvedimento', flowStep: 'b6', state: 'todo' }, // allow-italian: fixture data, shown as written
  ],
  documents: [
    {
      id: 'd-istanza', name: 'istanza-sgravio.pdf.p7m', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: '2 pagine · firmata', // allow-italian: fixture data, shown as written
      from: 'Immobiliare (esempio) S.r.l., PEC', receivedAt: '2026-11-04T11:37:00+01:00', signed: true, // allow-italian: fixture data, shown as written
      summary: [
        { text: "Chiede lo sgravio totale dell'avviso 2026 da 217,40 € e la voltura all'acquirente.", page: 1 }, // allow-italian: fixture data, shown as written
        { text: 'Il terreno, foglio 22 particella 1187, è stato venduto il 12/03/2025.', page: 1 }, // allow-italian: fixture data, shown as written
        { text: 'Tre allegati: avviso, nota di trascrizione, visura.', page: 2 }, // allow-italian: fixture data, shown as written
      ],
      ...original('2416', 'd-istanza', 2),
    },
    {
      id: 'd-avviso', name: 'avviso-2026.pdf', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: 'da Prunes · 217,40 €', // allow-italian: fixture data, shown as written
      from: 'Prunes, catasto consortile', // allow-italian: fixture data, shown as written
      summary: [{ text: 'Avviso del 30/09/2026 sul contributo 2026, intestato alla società venditrice.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2416', 'd-avviso', 1),
    },
    {
      id: 'd-trascrizione', name: 'nota-trascrizione.pdf', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: 'allegato 2 · 1 pagina', // allow-italian: fixture data, shown as written
      from: 'Immobiliare (esempio) S.r.l., PEC', receivedAt: '2026-11-04T11:37:00+01:00', // allow-italian: fixture data, shown as written
      summary: [{ text: 'Compravendita del 12/03/2025, trascritta il 20/03/2025: la società vende l\'intera proprietà.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2416', 'd-trascrizione', 1),
    },
  ],
  history: [
    { at: '2026-11-04 11:37', who: 'Flusso PEC', what: 'PEC consegnata su protocollo@ con 3 allegati', doc: 'd-istanza' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-04 11:38', who: 'AI', what: 'Riconosciuta come istanza del contribuente (percorso B), fiducia 91%' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-04 11:39', who: 'Prunes', what: "Trovati il contribuente C-0063390 e l'avviso 2026 da 217,40 €, non pagato", doc: 'd-avviso' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-04 11:39', who: 'AI', what: 'Letta la nota di trascrizione: vendita del 12/03/2025', doc: 'd-trascrizione' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-04 11:40', who: 'Prunes', what: 'La particella risulta ancora intestata alla società: voltura assente' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-04 11:40', who: 'Regola del flusso', what: 'Termine calcolato: 04/12/2026' }, // allow-italian: fixture data, shown as written
  ],
  draft: {
    file: 'provvedimento-sgravio.docx',
    meta: 'preparata 11:41 · da firmare', // allow-italian: fixture data, shown as written
    blocks: [
      { kind: 'heading', lines: ['Consorzio di Bonifica Integrale Comprensorio Sarno', 'Provvedimento di sgravio e voltura'] }, // allow-italian: fixture data, shown as written
      {
        kind: 'paragraph',
        text: ["Vista l'istanza della Immobiliare (esempio) S.r.l. del 3 novembre 2026, pervenuta il 04/11/2026", { source: { id: 'd-istanza', label: 'istanza', page: 1 } }, ", relativa all'avviso n. 2026/0063390/01 di euro 217,40;"], // allow-italian: fixture data, shown as written
      },
      {
        kind: 'paragraph',
        text: ['accertato che il terreno censito al foglio 22, particella 1187 del Comune di Mercato San Severino è stato venduto con atto del 12/03/2025, trascritto il 20/03/2025', { source: { id: 'd-trascrizione', label: 'nota di trascrizione', page: 1 } }, ', prima della formazione del ruolo 2026;'], // allow-italian: fixture data, shown as written
      },
      {
        kind: 'paragraph',
        lead: 'si dispone', // allow-italian: fixture data, shown as written
        text: ["lo sgravio totale dell'avviso n. 2026/0063390/01 e la voltura della partita all'acquirente, con effetto dal contributo 2026."], // allow-italian: fixture data, shown as written
      },
      { kind: 'proposal', text: "Prima di firmare, controlla in Prunes che il contributo 2025 risulti pagato: nel 2025 la società era ancora proprietaria fino al 12 marzo, quindi lo sgravio vale solo per il 2026." }, // allow-italian: fixture data, shown as written
    ],
  },
  assistant: {
    description: 'Vede solo questa pratica, i suoi documenti e la Conoscenza.', // allow-italian: fixture data, shown as written
    turns: [
      { role: 'user', text: ['La vendita è davvero prima del ruolo 2026?'] }, // allow-italian: fixture data, shown as written
      { role: 'assistant', text: ['Sì: atto del 12/03/2025, trascritto il 20/03/2025', { source: { id: 'd-trascrizione', label: 'nota di trascrizione', page: 1 } }, ". Il ruolo 2026 è stato formato con l'intestazione ancora alla società, perché in Prunes la voltura non c'è."] }, // allow-italian: fixture data, shown as written
      { role: 'user', text: ['Prepara il provvedimento.'] }, // allow-italian: fixture data, shown as written
      { role: 'assistant', text: ["Bozza pronta: sgravio totale di 217,40 € e voltura all'acquirente dal 2026. L'avviso 2026 al nuovo proprietario lo emette Prunes dopo la voltura; la firma è del Dirigente."] }, // allow-italian: fixture data, shown as written
    ],
    checklist: [
      { id: 'c1', text: 'Confermare tipo e ufficio, protocollare', done: false, closedByConfirm: true }, // allow-italian: fixture data, shown as written
      { id: 'c2', text: 'Leggere la nota di trascrizione', done: true }, // allow-italian: fixture data, shown as written
      { id: 'c3', text: 'Voltura della particella in Prunes', done: false }, // allow-italian: fixture data, shown as written
      { id: 'c4', text: 'Provvedimento firmato dal Dirigente', done: false }, // allow-italian: fixture data, shown as written
      { id: 'c5', text: 'Risposta via PEC entro il 04/12', done: false }, // allow-italian: fixture data, shown as written
    ],
  },
  norms: ['l-241-1990/a2'],
  primaryAction: {
    label: 'Firma e invia il provvedimento', // allow-italian: fixture data, shown as written
    kind: 'send-pec',
    receipt: {
      title: 'Ricevuta di avvenuta consegna', // allow-italian: fixture data, shown as written
      lines: [
        'Messaggio «Provvedimento di sgravio, avviso 2026/0063390/01»', // allow-italian: fixture data, shown as written
        'Consegnato a immobiliare.esempio@pec.esempio.it il 06/11/2026 alle 10:31', // allow-italian: fixture data, shown as written
        'Protocollo in partenza n. 2026/0018502 (esempio)', // allow-italian: fixture data, shown as written
        'Sgravio registrato in Prunes · voltura in coda al Catasto', // allow-italian: fixture data, shown as written
      ],
    },
  },
  example: true,
};
