/**
 * Case 2386: a request for a concession to cross the Canale Macchione with a
 * small road bridge. Flow `concessioni`, office Tecnico. The term was
 * suspended once for missing documents and runs again from their arrival.
 *
 * Real: the Canale Macchione in Castel San Giorgio, R.D. 368/1904 and the
 * Consorzio's own hydraulic police regulation, art. 2 c.2 and c.7 L.
 * 241/1990, the stamp duty on a request to a public body. An example: the
 * company, the parcel, the project and its measures, every number.
 */
import type { CaseSeed } from '../types';
import { original } from './originals';

export const CASE_2386: CaseSeed = {
  id: '2386',
  org: 'nocera',
  kind: 'concessione',
  title: 'Concessione, ponticello sul Canale Macchione', // allow-italian: fixture data, shown as written
  subject: 'Domanda di concessione per un attraversamento del Canale Macchione con ponticello carrabile', // allow-italian: fixture data, shown as written
  office: 'tecnico',
  flow: 'concessioni',
  channel: 'pec',
  arrivedAt: '2026-10-14T10:22:00+02:00',
  protocol: { number: '2026/0017488', date: '2026-10-14' },
  counterpart: 'Società agricola (esempio) S.r.l.', // allow-italian: fixture data, shown as written
  status: 'in-lavorazione',
  assignee: 'direzione',
  comune: 'Castel San Giorgio',
  parcel: { comune: 'Castel San Giorgio', foglio: '9', particella: '512', canale: 'Canale Macchione' },
  proposal: 'Tecnico · decisione entro 25/11', // allow-italian: fixture data, shown as written
  fields: [
    {
      id: 'opera', label: 'Opera', value: 'Ponticello carrabile in c.a., luce 4,00 m, larghezza 5,00 m', confidence: 95, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-istanza', page: 1, before: 'un attraversamento con ', highlight: 'ponticello carrabile in calcestruzzo armato, di luce netta 4,00 m e larghezza 5,00 m', after: ", per l'accesso dei mezzi agricoli al fondo" }, // allow-italian: fixture data, shown as written
      reasoning: ['Attraversamento ', { strong: 'aereo' }, ', non in subalveo: le spalle stanno fuori dalla sezione del canale', { source: { id: 'd-sezione', label: 'Tavola 3', page: 1 } }, '.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'canale', label: 'Canale', value: 'Canale Macchione', confidence: 99, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-istanza', page: 1, before: 'realizzare sul ', highlight: 'Canale Macchione', after: ' un attraversamento' }, // allow-italian: fixture data, shown as written
      reasoning: ["È un canale di bonifica del Consorzio: vale il R.D. 368/1904, non il R.D. 523/1904 dei corsi d'acqua pubblici."], // allow-italian: fixture data, shown as written
    },
    {
      id: 'particella', label: 'Particella', value: 'Castel San Giorgio, foglio 9, particella 512', confidence: 97, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-istanza', page: 1, before: 'Comune di Castel San Giorgio al ', highlight: 'foglio 9, particella 512', after: ',' }, // allow-italian: fixture data, shown as written
      reasoning: ['La particella confina con il canale in QGIS. Il titolo di disponibilità di entrambe le sponde è arrivato con l\'integrazione del 03/11.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'franco', label: 'Franco sul ciglio', value: '0,60 m', confidence: 86, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-sezione', page: 1, before: 'con un franco di ', highlight: '0,60 m', after: " tra l'intradosso e il ciglio della sponda" }, // allow-italian: fixture data, shown as written
      reasoning: ['È il dato che mancava', { source: { id: 'd-integrazione', label: 'richiesta di integrazione', page: 1 } }, '. Il valore minimo lo fissa il Regolamento di Polizia Idraulica del Consorzio: lo conferma il tecnico al sopralluogo.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'sospensione', label: 'Sospensione del termine', value: 'dal 22/10 al 03/11, 12 giorni', confidence: 92, consulted: 3, // allow-italian: fixture data, shown as written
      source: { doc: 'd-integrazione', page: 1, before: 'il termine del procedimento ', highlight: 'resta sospeso dalla data della presente fino al ricevimento delle integrazioni', after: ', e comunque per non più di 30 giorni' }, // allow-italian: fixture data, shown as written
      reasoning: ['Richiesta del 22/10, integrazione protocollata il 03/11', { source: { id: 'd-sezione', label: 'Tavola 3', page: 1 } }, ": 12 giorni, una sola volta, come consente l'art. 2 c.7 L. 241/1990."], // allow-italian: fixture data, shown as written
    },
    {
      id: 'scadenza', label: 'Scadenza', value: '25/11/2026 · provvedimento', short: '25/11', confidence: 90, consulted: 3, // allow-italian: fixture data, shown as written
      source: { doc: 'd-istanza', page: 1, before: '', highlight: 'Prot. n. 2026/0017488 del 14/10/2026', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ['30 giorni dal 14/10, più i 12 di sospensione: ', { strong: '25/11/2026' }, '. Se il regolamento del Consorzio fissa un termine diverso, vale quello.'], // allow-italian: fixture data, shown as written
    },
  ],
  deadlines: [
    {
      id: 'provvedimento', label: 'Provvedimento sulla domanda', // allow-italian: fixture data, shown as written
      from: '2026-10-14', days: 42, date: '2026-11-25', rollsOver: false,
      rule: 'art. 2 c.2 e c.7 L. 241/1990',
      calc: '30 giorni dal ricevimento della domanda, il 14/10/2026, sospesi una sola volta dal 22/10 al 03/11 per l\'integrazione: 8 giorni erano già trascorsi, i 22 restanti ripartono dal 03/11. In tutto 42 giorni dal 14/10: mercoledì 25/11/2026. Termine amministrativo, non si sposta.', // allow-italian: fixture data, shown as written
      office: 'tecnico',
    },
  ],
  steps: [
    { id: 'arrivata', label: 'Domanda arrivata', flowStep: 's1', state: 'done', at: '2026-10-14 10:22', by: 'Flusso PEC' }, // allow-italian: fixture data, shown as written
    { id: 'completezza', label: 'Verifica di completezza', flowStep: 's2', state: 'done', at: '2026-10-21 12:10', by: 'Tecnico' }, // allow-italian: fixture data, shown as written
    { id: 'integrazione', label: 'Integrazione', flowStep: 's3', state: 'done', at: '2026-11-03 09:48', by: 'Flusso PEC' }, // allow-italian: fixture data, shown as written
    { id: 'sopralluogo', label: 'Sopralluogo e parere', flowStep: 's4', state: 'current' }, // allow-italian: fixture data, shown as written
    { id: 'concessione', label: 'Concessione', flowStep: 's5', state: 'todo' }, // allow-italian: fixture data, shown as written
    { id: 'disciplinare', label: 'Disciplinare e canone', flowStep: 's6', state: 'todo' }, // allow-italian: fixture data, shown as written
  ],
  documents: [
    {
      id: 'd-istanza', name: 'domanda-concessione.pdf.p7m', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: '2 pagine · firmata · bollo assolto', // allow-italian: fixture data, shown as written
      from: 'Società agricola (esempio) S.r.l., PEC', receivedAt: '2026-10-14T10:22:00+02:00', signed: true, // allow-italian: fixture data, shown as written
      summary: [
        { text: 'Chiede la concessione per un ponticello carrabile di luce 4,00 m sul Canale Macchione.', page: 1 }, // allow-italian: fixture data, shown as written
        { text: 'Accetta il disciplinare e la manutenzione a suo carico; quattro allegati, senza sezione quotata.', page: 2 }, // allow-italian: fixture data, shown as written
      ],
      ...original('2386', 'd-istanza', 2),
    },
    {
      id: 'd-integrazione', name: 'richiesta-integrazione.pdf', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: 'in partenza · 1 pagina · firmata', // allow-italian: fixture data, shown as written
      from: 'Area Tecnica del Consorzio', receivedAt: '2026-10-22T11:30:00+02:00', signed: true, // allow-italian: fixture data, shown as written
      summary: [{ text: 'Chiede sezione quotata, verifica idraulica e titolo sulle due sponde; il termine resta sospeso.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2386', 'd-integrazione', 1),
    },
    {
      id: 'd-sezione', name: 'tavola-3-sezione.pdf', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: 'integrazione del 03/11 · 1 pagina', // allow-italian: fixture data, shown as written
      from: 'Società agricola (esempio) S.r.l., PEC', receivedAt: '2026-11-03T09:48:00+01:00', // allow-italian: fixture data, shown as written
      summary: [{ text: 'Sezione in scala 1:50: luce netta 4,00 m, franco 0,60 m sul ciglio, spalle fuori dal canale.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2386', 'd-sezione', 1),
    },
  ],
  history: [
    { at: '2026-10-14 10:22', who: 'Flusso PEC', what: 'PEC consegnata su protocollo@ con 5 allegati', doc: 'd-istanza' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-14 10:24', who: 'AI', what: 'Riconosciuta come domanda di concessione: passa al flusso Concessioni' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-14 11:02', who: 'Operatore del protocollo (esempio)', what: 'Protocollata: 2026/0017488' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-21 12:10', who: 'Tecnico', what: 'Completezza: mancano sezione quotata, verifica idraulica, titolo sulle due sponde' }, // allow-italian: fixture data, shown as written
    { at: '2026-10-22 11:30', who: 'Halley', what: 'Richiesta di integrazione inviata, prot. 2026/0017819: termine sospeso', doc: 'd-integrazione' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-03 09:48', who: 'Flusso PEC', what: 'Integrazione arrivata, prot. 2026/0018315: il termine riparte', doc: 'd-sezione' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-03 09:51', who: 'AI', what: 'Integrazione completa: sezione, verifica idraulica e titolo ci sono' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 15:20', who: 'Tecnico', what: 'Sopralluogo proposto per martedì 10/11 alle 9:30' }, // allow-italian: fixture data, shown as written
  ],
  draft: {
    file: 'concessione-2386.docx',
    meta: 'preparata 04/11 · da completare dopo il sopralluogo', // allow-italian: fixture data, shown as written
    blocks: [
      { kind: 'heading', lines: ['Consorzio di Bonifica Integrale Comprensorio Sarno', 'Concessione per attraversamento del Canale Macchione'] }, // allow-italian: fixture data, shown as written
      {
        kind: 'paragraph',
        text: ['Vista la domanda della Società agricola (esempio) S.r.l., prot. n. 2026/0017488 del 14/10/2026', { source: { id: 'd-istanza', label: 'domanda', page: 1 } }, ", e l'integrazione del 03/11/2026", { source: { id: 'd-sezione', label: 'Tavola 3', page: 1 } }, ';'], // allow-italian: fixture data, shown as written
      },
      {
        kind: 'paragraph',
        lead: 'si concede', // allow-italian: fixture data, shown as written
        text: ["di realizzare sul Canale Macchione, in Comune di Castel San Giorgio, foglio 9, particella 512, un ponticello carrabile in calcestruzzo armato di luce netta 4,00 m, alle condizioni del disciplinare: intradosso con franco non inferiore a 0,60 m sul ciglio; manutenzione a carico del concessionario; revoca per sopravvenute esigenze idrauliche, senza indennizzo."], // allow-italian: fixture data, shown as written
      },
      { kind: 'proposal', text: 'Aggiungere al disciplinare che la fascia di rispetto lungo le sponde resti libera per il transito dei mezzi del Consorzio, come prevede il Regolamento di Polizia Idraulica.' }, // allow-italian: fixture data, shown as written
      { kind: 'paragraph', muted: true, lead: 'Canone annuo.', text: ['…'] }, // allow-italian: fixture data, shown as written
    ],
  },
  assistant: {
    description: 'Vede solo questa pratica, i suoi documenti e la Conoscenza.', // allow-italian: fixture data, shown as written
    turns: [
      { role: 'user', text: ["L'integrazione risponde a tutte e tre le richieste?"] }, // allow-italian: fixture data, shown as written
      { role: 'assistant', text: ['Sì: sezione quotata con franco di 0,60 m e verifica idraulica sulla Tavola 3', { source: { id: 'd-sezione', page: 1 } }, ', titolo di proprietà delle due sponde nella PEC del 03/11. Il termine riparte e scade il 25/11.'] }, // allow-italian: fixture data, shown as written
      { role: 'user', text: ['Fissa il sopralluogo.'] }, // allow-italian: fixture data, shown as written
      { role: 'assistant', text: ['Proposto martedì 10/11 alle 9:30, in calendario del Tecnico; ho scritto alla società per la conferma. Il canone lo calcola il Tecnico con il regolamento: non lo invento.'] }, // allow-italian: fixture data, shown as written
    ],
    checklist: [
      { id: 'c1', text: 'Verifica di completezza', done: true }, // allow-italian: fixture data, shown as written
      { id: 'c2', text: 'Richiesta di integrazione', done: true }, // allow-italian: fixture data, shown as written
      { id: 'c3', text: 'Integrazione ricevuta e letta', done: true }, // allow-italian: fixture data, shown as written
      { id: 'c4', text: 'Sopralluogo del 10/11', done: false }, // allow-italian: fixture data, shown as written
      { id: 'c5', text: 'Parere tecnico e canone', done: false }, // allow-italian: fixture data, shown as written
      { id: 'c6', text: 'Concessione firmata entro il 25/11', done: false }, // allow-italian: fixture data, shown as written
    ],
  },
  norms: ['rd-368', 'l-241-1990/a2'],
  primaryAction: {
    label: 'Rilascia la concessione', // allow-italian: fixture data, shown as written
    kind: 'grant',
    receipt: {
      title: 'Concessione rilasciata', // allow-italian: fixture data, shown as written
      lines: [
        'Concessione n. 41/2026 (esempio), firmata dal Dirigente dell\'Area Tecnica', // allow-italian: fixture data, shown as written
        'Protocollo in partenza n. 2026/0018503 (esempio)', // allow-italian: fixture data, shown as written
        'Inviata via PEC a societa.agricola@pec.esempio.it: consegnata il 06/11/2026 alle 10:32', // allow-italian: fixture data, shown as written
        'Registro delle concessioni aggiornato · canone in Prunes', // allow-italian: fixture data, shown as written
      ],
    },
  },
  example: true,
};
