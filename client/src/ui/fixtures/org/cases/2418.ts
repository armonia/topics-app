/**
 * Case 2418: an appeal to the first-instance tax court of Salerno against the
 * 2025 contribution notice, served on the Consorzio by certified mail on
 * 05/11/2026. The same case as `../../inbox.ts`, `../../record.ts`,
 * `../../views.ts`, `../../data.ts` and `../../flows.ts`, with their facts.
 *
 * Real: the court, the 60-day term to enter an appearance (art. 23 D.Lgs.
 * 546/1992), the Piano di Classifica 1996 approved by D.G.R. 0403/AC of
 * 18/03/1997, the Canale Macchione in Castel San Giorgio, L.R. Campania
 * 7/2025 art. 9 c.3, the programs. An example: the farm, its lawyer, the
 * notice, the parcels, the amounts, the protocol number (the one Halley
 * gives when the protocol office confirms; the originals carry no stamp yet).
 */
import type { CaseSeed } from '../types';
import { original } from './originals';

export const CASE_2418: CaseSeed = {
  id: '2418',
  org: 'nocera',
  kind: 'ricorso',
  title: 'Ricorso CGT, azienda agricola', // allow-italian: fixture data, shown as written
  subject: 'Ricorso avverso avviso di pagamento 2025', // allow-italian: fixture data, shown as written
  office: 'legale',
  flow: 'pec',
  channel: 'pec',
  arrivedAt: '2026-11-05T09:12:04+01:00',
  protocol: { number: '2026/0018421', date: '2026-11-05' },
  counterpart: 'Azienda agricola (esempio)', // allow-italian: fixture data, shown as written
  status: 'da-confermare',
  urgent: true,
  assignee: 'protocollo',
  amount: 1248,
  comune: 'Castel San Giorgio',
  parcel: { comune: 'Castel San Giorgio', foglio: '14', particella: '210, 214', canale: 'Canale Macchione' },
  proposal: 'Legale · costituzione 04/01', // allow-italian: fixture data, shown as written
  fields: [
    {
      id: 'ufficio', label: 'Ufficio', value: 'Legale', confidence: 96, consulted: 3, // allow-italian: fixture data, shown as written
      source: { doc: 'd-ricorso', page: 1, before: '', highlight: 'CORTE DI GIUSTIZIA TRIBUTARIA DI PRIMO GRADO DI SALERNO', after: ' RICORSO' }, // allow-italian: fixture data, shown as written
      reasoning: ["È un ricorso alla Corte di giustizia tributaria contro un atto del Consorzio", { source: { id: 'd-ricorso', label: 'ricorso.pdf.p7m', page: 1 } }, ": per il titolario va al ", { strong: 'Legale' }, ", e un atto giudiziario lo conferma sempre una persona."], // allow-italian: fixture data, shown as written
    },
    {
      id: 'titolario', label: 'Titolario', value: 'Contenzioso', confidence: 93, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-ricorso', page: 1, before: 'PRIMO GRADO DI SALERNO ', highlight: 'RICORSO', after: " con istanza di sospensione dell'atto impugnato" }, // allow-italian: fixture data, shown as written
      reasoning: ['Il documento si intitola ', { strong: 'ricorso' }, " e chiede anche la sospensione dell'atto: la voce del titolario è Contenzioso, non Istanze dei contribuenti."], // allow-italian: fixture data, shown as written
    },
    {
      id: 'scadenza', label: 'Scadenza', value: '04/01/2027 · costituzione', short: '04/01', confidence: 71, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'ricevuta', page: 1, before: 'Il giorno ', highlight: '05/11/2026 alle ore 09:12:04', after: ' il messaggio «Ricorso avverso avviso di pagamento 2025» è stato consegnato nella casella di destinazione' }, // allow-italian: fixture data, shown as written
      reasoning: ['È la data della ', { strong: 'notifica' }, '. Il Consorzio si costituisce depositando le controdeduzioni entro 60 giorni: ', { strong: '04/01/2027' }, " (art. 23 D.Lgs. 546/1992), regola del flusso. L'udienza la fissa la Corte dopo il deposito."], // allow-italian: fixture data, shown as written
    },
    {
      id: 'fascicolo', label: 'Fascicolo', value: 'Ricorsi 2025 / Castel San Giorgio', confidence: 64, consulted: 4, // allow-italian: fixture data, shown as written
      source: { doc: 'd-ricorso', page: 1, before: 'relativo al contributo consortile per ', highlight: "l'anno 2025", after: ' di euro 1.248,00' }, // allow-italian: fixture data, shown as written
      reasoning: ["L'avviso contestato è del contributo ", { strong: '2025' }, " e il fondo è a Castel San Giorgio", { source: { id: 'd-ricorso', page: 2 } }, ". L'AI aveva proposto «Contenzioso 2026», il Protocollo l'ha corretto alle 12:41."], // allow-italian: fixture data, shown as written
    },
    {
      id: 'ricorrente', label: 'Ricorrente', value: 'Azienda agricola (esempio), Castel San Giorgio', confidence: 98, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-ricorso', page: 1, before: 'per ', highlight: 'AZIENDA AGRICOLA ESEMPIO s.s.', after: ', con sede in Castel San Giorgio (SA)' }, // allow-italian: fixture data, shown as written
      reasoning: ["Il ricorso è proposto dall'azienda, in persona del legale rappresentante, con un avvocato del Foro di Salerno", { source: { id: 'd-ricorso', page: 1 } }, '.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'avviso', label: 'Atto impugnato', value: 'Avviso 2025/0048213/01 · 1.248,00\u00a0€', confidence: 97, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-ricorso', page: 1, before: "avverso l'avviso di pagamento ", highlight: 'n. 2025/0048213/01 del 31/08/2026', after: ', relativo al contributo consortile' }, // allow-italian: fixture data, shown as written
      reasoning: ['Lo stesso numero è in Prunes, codice contribuente C-0048213, importo ', { strong: '1.248,00 €' }, { source: { id: 'd-avviso', label: 'avviso-2025.pdf', page: 1 } }, '.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'contribuente', label: 'Codice contribuente', value: 'C-0048213', confidence: 99, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-avviso', page: 1, before: 'Codice contribuente: ', highlight: 'C-0048213', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ["Trovato in Prunes dal numero dell'avviso: stesso codice nel ricorso", { source: { id: 'd-ricorso', page: 1 } }, " e nell'avviso."], // allow-italian: fixture data, shown as written
    },
    {
      id: 'particelle', label: 'Particelle', value: 'Castel San Giorgio, foglio 14, particelle 210 e 214', confidence: 95, consulted: 3, // allow-italian: fixture data, shown as written
      source: { doc: 'd-ricorso', page: 2, before: 'Castel San Giorgio al ', highlight: 'foglio 14, particelle 210 e 214', after: ', della superficie' }, // allow-italian: fixture data, shown as written
      reasoning: ['Le stesse particelle sono sulla Tavola 12, dentro il perimetro di contribuenza del bacino del Sarno', { source: { id: 'd-tavola', label: 'Tavola 12', page: 1 } }, '.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'motivo', label: 'Motivo principale', value: 'Difetto di beneficio: il fondo non trarrebbe vantaggio dalle opere', confidence: 88, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-ricorso', page: 5, before: 'Il fondo della ricorrente ', highlight: 'non trae alcun beneficio diretto e specifico dalle opere del Consorzio', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ['Primo dei tre motivi, il più lungo (pagine 4-6). Gli altri due: difetto di motivazione', { source: { id: 'd-ricorso', page: 7 } }, ' e superficie errata', { source: { id: 'd-ricorso', page: 9 } }, '.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'richieste', label: 'Richieste', value: "Annullamento e sospensione dell'avviso", confidence: 94, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-ricorso', page: 12, before: 'la ricorrente ', highlight: "chiede la sospensione dell'avviso", after: ' impugnato' }, // allow-italian: fixture data, shown as written
      reasoning: ["La sospensione (art. 47 D.Lgs. 546/1992) la decide la Corte in camera di consiglio: conviene che le controdeduzioni rispondano anche su quella."], // allow-italian: fixture data, shown as written
    },
  ],
  deadlines: [
    {
      id: 'costituzione', label: 'Costituzione in giudizio con le controdeduzioni', // allow-italian: fixture data, shown as written
      from: '2026-11-05', days: 60, date: '2027-01-04', rollsOver: true,
      rule: 'art. 23 D.Lgs. 546/1992',
      calc: "60 giorni dalla consegna della PEC del 05/11/2026: il sessantesimo giorno è lunedì 04/01/2027, lavorativo, quindi non si sposta (art. 155 c.p.c.).", // allow-italian: fixture data, shown as written
      office: 'legale',
    },
    {
      id: 'avviso-20', label: 'Avviso al Legale, 20 giorni prima', // allow-italian: fixture data, shown as written
      from: '2026-11-05', days: 40, date: '2026-12-15', rollsOver: false,
      rule: 'regola del flusso PEC, percorso A', // allow-italian: fixture data, shown as written
      calc: '40 giorni dalla consegna del 05/11/2026, cioè 20 giorni prima del 04/01/2027.', // allow-italian: fixture data, shown as written
      office: 'legale',
    },
    {
      id: 'avviso-5', label: 'Avviso al Legale, 5 giorni prima', // allow-italian: fixture data, shown as written
      from: '2026-11-05', days: 55, date: '2026-12-30', rollsOver: false,
      rule: 'regola del flusso PEC, percorso A', // allow-italian: fixture data, shown as written
      calc: '55 giorni dalla consegna del 05/11/2026, cioè 5 giorni prima del 04/01/2027.', // allow-italian: fixture data, shown as written
      office: 'legale',
    },
  ],
  steps: [
    { id: 'arrivata', label: 'Arrivata', flowStep: 'trigger', state: 'done', at: '2026-11-05 09:12', by: 'Flusso PEC' }, // allow-italian: fixture data, shown as written
    { id: 'protocollata', label: 'Protocollata', flowStep: 'e', state: 'current' }, // allow-italian: fixture data, shown as written
    { id: 'controdeduzioni', label: 'Controdeduzioni', flowStep: 'f', state: 'todo' }, // allow-italian: fixture data, shown as written
    { id: 'costituzione', label: 'Costituzione', flowStep: 'c', state: 'todo' }, // allow-italian: fixture data, shown as written
    { id: 'udienza', label: 'Udienza', state: 'todo' }, // allow-italian: fixture data, shown as written
    { id: 'esito', label: 'Esito', state: 'todo' },
  ],
  documents: [
    {
      id: 'ricevuta', name: 'ricevuta-consegna.pdf', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: 'Ricevuta di avvenuta consegna · 1 pagina', // allow-italian: fixture data, shown as written
      from: 'Gestore PEC del Consorzio', receivedAt: '2026-11-05T09:12:04+01:00', // allow-italian: fixture data, shown as written
      summary: [{ text: 'Consegna della PEC il 05/11/2026 alle 09:12:04: da qui corrono i 60 giorni.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2418', 'ricevuta', 1),
    },
    {
      id: 'd-ricorso', name: 'ricorso.pdf.p7m', kind: 'pdf',
      detail: '14 pagine · motivo a p.5 · firmato', // allow-italian: fixture data, shown as written
      from: 'Studio legale della ricorrente (esempio)', receivedAt: '2026-11-05T09:12:04+01:00', signed: true, // allow-italian: fixture data, shown as written
      summary: [
        { text: "Ricorso contro l'avviso di pagamento del contributo 2025, 1.248,00 €.", page: 1 }, // allow-italian: fixture data, shown as written
        { text: 'Il fondo è a Castel San Giorgio, foglio 14, particelle 210 e 214.', page: 2 }, // allow-italian: fixture data, shown as written
        { text: 'Primo motivo: il fondo non trarrebbe beneficio dalle opere del Consorzio.', page: 5 }, // allow-italian: fixture data, shown as written
        { text: "Secondo motivo: l'avviso non indicherebbe opere e criteri di riparto.", page: 7 }, // allow-italian: fixture data, shown as written
        { text: 'Terzo motivo: superficie tassata maggiore di quella agricola.', page: 9 }, // allow-italian: fixture data, shown as written
        { text: "Chiede la sospensione dell'avviso fino alla decisione.", page: 12 }, // allow-italian: fixture data, shown as written
        { text: 'Procura alle liti e relata di notifica via PEC.', page: 13 }, // allow-italian: fixture data, shown as written
      ],
      ...original('2418', 'd-ricorso', 14),
    },
    {
      id: 'd-avviso', name: 'avviso-2025.pdf', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: 'da Prunes · 1.248 €', // allow-italian: fixture data, shown as written
      from: 'Prunes, catasto consortile', // allow-italian: fixture data, shown as written
      summary: [{ text: 'Avviso del 31/08/2026 sul contributo 2025: particelle 210 e 214, bacino del Sarno, 1.248,00 €.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2418', 'd-avviso', 1),
    },
    {
      id: 'd-tavola', name: 'Tavola 12, bacino Sarno', kind: 'image', // allow-italian: fixture data, shown as written
      detail: 'da QGIS · il fondo è nel perimetro', // allow-italian: fixture data, shown as written
      from: 'QGIS',
      summary: [{ text: 'Le particelle 210 e 214 sono dentro il perimetro di contribuenza, a 72 m dal Canale Macchione (misure di esempio).', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2418', 'd-tavola', 1),
    },
    {
      id: 'd-controdeduzioni', name: 'controdeduzioni.docx', kind: 'pdf', draft: true, // allow-italian: fixture data, shown as written
      detail: 'salvata 12:58 · SharePoint Legale', // allow-italian: fixture data, shown as written
      from: 'Assistente della pratica', // allow-italian: fixture data, shown as written
      summary: [{ text: 'Bozza: intestazione, parti e primo punto sul beneficio; il punto sulla sospensione è da scrivere.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2418', 'd-controdeduzioni', 1),
    },
  ],
  history: [
    { at: '2026-11-05 09:12', who: 'Flusso PEC', what: 'PEC consegnata su protocollo@ con 3 allegati', doc: 'ricevuta' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 09:13', who: 'AI', what: 'Firme digitali verificate: 3 valide', doc: 'd-ricorso' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 09:14', who: 'AI', what: 'Riconosciuta come ricorso o atto giudiziario (percorso A), fiducia 96%' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 09:15', who: 'Prunes', what: "Trovati il contribuente C-0048213 e l'avviso 2025 da 1.248 €", doc: 'd-avviso' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 09:15', who: 'Regola del flusso', what: 'Scadenze calcolate: costituzione 04/01/2027, avvisi 15/12 e 30/12' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 09:16', who: 'QGIS', what: 'Particelle 210 e 214 nel perimetro di contribuenza, Tavola 12', doc: 'd-tavola' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 12:41', who: 'Operatore del protocollo (esempio)', what: 'Fascicolo corretto: Ricorsi 2025 / Castel San Giorgio' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 12:58', who: 'Assistente della pratica', what: 'Bozza delle controdeduzioni salvata su SharePoint Legale', doc: 'd-controdeduzioni' }, // allow-italian: fixture data, shown as written
  ],
  draft: {
    file: 'controdeduzioni.docx',
    meta: 'salvata 12:58 · su SharePoint Legale', // allow-italian: fixture data, shown as written
    blocks: [
      { kind: 'heading', lines: ['Corte di giustizia tributaria di primo grado di Salerno', 'Controdeduzioni'] }, // allow-italian: fixture data, shown as written
      {
        kind: 'paragraph',
        text: [
          'per il Consorzio di Bonifica Integrale Comprensorio Sarno, ente pubblico economico a carattere associativo', // allow-italian: fixture data, shown as written
          { source: { id: 'lr-7-2025/a9c3', label: 'L.R. 7/2025, art. 9 c.3' } },
          ", in persona del legale rappresentante pro tempore, resistente, nel ricorso proposto da un'azienda agricola di Castel San Giorgio contro l'avviso di pagamento del contributo 2025.", // allow-italian: fixture data, shown as written
        ],
      },
      {
        kind: 'paragraph',
        lead: '1. Sul preteso difetto di beneficio.', // allow-italian: fixture data, shown as written
        text: [
          'Il fondo del ricorrente ricade nel perimetro di contribuenza del bacino del Sarno', // allow-italian: fixture data, shown as written
          { source: { id: 'd-tavola', label: 'Tavola 12' } },
          'e beneficia delle opere di scolo e di difesa idraulica individuate dal Piano di Classifica del Territorio', // allow-italian: fixture data, shown as written
          { source: { id: 'd-classifica', label: 'Piano di Classifica 1996' } }, // allow-italian: fixture data, shown as written
          ', approvato con delibera della Giunta regionale n. 0403/AC del 18/03/1997.', // allow-italian: fixture data, shown as written
        ],
      },
      { kind: 'proposal', text: 'Con un Piano di classifica approvato e il fondo dentro il perimetro di contribuenza, il beneficio si presume: spetta al ricorrente provare che il fondo non ne trae un vantaggio diretto e specifico.' }, // allow-italian: fixture data, shown as written
      { kind: 'paragraph', muted: true, lead: "2. Sull'istanza di sospensione.", text: ['…'] }, // allow-italian: fixture data, shown as written
    ],
  },
  assistant: {
    description: 'Vede solo questa pratica, i suoi documenti e la Conoscenza.', // allow-italian: fixture data, shown as written
    turns: [
      { role: 'user', text: ["Il ricorrente ha già fatto un'istanza di sgravio?"] }, // allow-italian: fixture data, shown as written
      { role: 'assistant', text: ['Sì, a marzo, respinta perché il fondo è nel perimetro di contribuenza', { source: { id: 'r-sgravio', label: 'pratica collegata' } }, '. Nelle controdeduzioni conviene citarla al punto 1.'] }, // allow-italian: fixture data, shown as written
      { role: 'user', text: ["Aggiungila e prepara l'elenco dei documenti da depositare."] }, // allow-italian: fixture data, shown as written
      { role: 'assistant', text: ['Fatto: paragrafo aggiornato e 5 documenti in elenco. Il deposito sul portale della giustizia tributaria lo fai tu.'] }, // allow-italian: fixture data, shown as written
    ],
    checklist: [
      { id: 'c1', text: 'Leggere il ricorso', done: true }, // allow-italian: fixture data, shown as written
      { id: 'c2', text: 'Verificare il perimetro in QGIS', done: true }, // allow-italian: fixture data, shown as written
      { id: 'c3', text: 'Controdeduzioni sul beneficio', done: false }, // allow-italian: fixture data, shown as written
      { id: 'c4', text: 'Firma del legale rappresentante sulla procura', done: false }, // allow-italian: fixture data, shown as written
      { id: 'c5', text: 'Costituzione entro il 04/01', done: false }, // allow-italian: fixture data, shown as written
    ],
  },
  norms: ['lr-7-2025/a9c3', 'dlgs-546-1992/a23', 'dlgs-546-1992/a47'],
  primaryAction: {
    label: 'Prepara il deposito', // allow-italian: fixture data, shown as written
    kind: 'deposit',
    receipt: {
      title: 'Ricevuta di deposito telematico', // allow-italian: fixture data, shown as written
      lines: [
        'Corte di giustizia tributaria di primo grado di Salerno', // allow-italian: fixture data, shown as written
        'Atto: controdeduzioni del Consorzio con 5 documenti', // allow-italian: fixture data, shown as written
        'Ricorso R.G.R. n. 1874/2026 (esempio)', // allow-italian: fixture data, shown as written
        'Depositato il 06/11/2026 alle 10:31 · esito: accettato', // allow-italian: fixture data, shown as written
      ],
    },
  },
  example: true,
};
