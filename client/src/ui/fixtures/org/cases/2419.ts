/**
 * Case 2419: a generalised civic access request (FOIA) from an association,
 * on the concessions and the hydraulic police reports of two canals. PEC
 * flow, path F, office Segreteria.
 *
 * Real: the two canals, Mulini and Macchione (DATI-VERI.md), art. 5
 * c.2, c.3, c.5 and c.6 and art. 5-bis D.Lgs. 33/2013. An example: the
 * association, the counts, the protocol number (the one Halley gives on
 * confirmation). The identity document attached to the PEC is not rendered.
 */
import type { CaseSeed } from '../types';
import { original } from './originals';

export const CASE_2419: CaseSeed = {
  id: '2419',
  org: 'nocera',
  kind: 'accesso',
  title: 'Accesso civico, concessioni di due canali', // allow-italian: fixture data, shown as written
  subject: 'Richiesta di accesso agli atti, concessioni Canale dei Mulini e Canale Macchione', // allow-italian: fixture data, shown as written
  office: 'segreteria',
  flow: 'pec',
  channel: 'pec',
  arrivedAt: '2026-11-05T16:20:37+01:00',
  protocol: { number: '2026/0018466', date: '2026-11-05' },
  counterpart: 'Associazione (esempio)', // allow-italian: fixture data, shown as written
  status: 'da-confermare',
  assignee: 'protocollo',
  proposal: 'Segreteria · risposta entro 05/12', // allow-italian: fixture data, shown as written
  fields: [
    {
      id: 'tipo', label: 'Tipo di accesso', value: 'Civico generalizzato (art. 5 c.2 D.Lgs. 33/2013)', confidence: 74, consulted: 3, // allow-italian: fixture data, shown as written
      source: { doc: 'd-istanza', page: 1, before: 'Oggetto: ', highlight: 'istanza di accesso civico generalizzato', after: ' ai sensi dell\'art. 5, comma 2, del D.Lgs. 33/2013.' }, // allow-italian: fixture data, shown as written
      reasoning: ["L'istanza cita l'art. 5 c.2, ma l'oggetto della PEC dice «accesso agli atti»", { source: { id: 'd-pec', label: 'PEC', page: 1 } }, ': se fosse accesso documentale (L. 241/1990) servirebbe un interesse diretto, concreto e attuale. Sotto 85% decide una persona.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'ufficio', label: 'Ufficio', value: 'Segreteria', confidence: 88, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-istanza', page: 1, before: 'Al Consorzio di Bonifica Integrale Comprensorio Sarno ', highlight: "Ufficio competente per l'accesso civico", after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ['Gli accessi civici li istruisce la Segreteria e li iscrive nel registro degli accessi; i dati delle concessioni li fornisce il Tecnico.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'oggetto1', label: 'Richiesta 1', value: 'Elenco concessioni 2024-2025, Canale dei Mulini e Canale Macchione', confidence: 92, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-istanza', page: 1, before: '1. ', highlight: "l'elenco delle concessioni e autorizzazioni idrauliche per attraversamenti e scarichi rilasciate negli anni 2024 e 2025", after: ' sul Canale dei Mulini e sul Canale Macchione' }, // allow-italian: fixture data, shown as written
      reasoning: ['Dati che il Consorzio detiene: si può dare. Con il ', { strong: 'titolare' }, ' persona fisica ci sono dati personali.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'oggetto2', label: 'Richiesta 2', value: 'Verbali di accertamento per scarichi non autorizzati', confidence: 90, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-istanza', page: 1, before: '2. ', highlight: "copia dei verbali di accertamento redatti negli stessi anni dall'ufficiale idraulico", after: ' per scarichi non autorizzati nei medesimi canali.' }, // allow-italian: fixture data, shown as written
      reasoning: ['Verbali con persone identificate e, se il procedimento è aperto, attività ispettiva in corso: limiti dell\'art. 5-bis c.1 lett. g) e c.2 lett. a).'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'controinteressati', label: 'Controinteressati', value: 'Titolari persone fisiche e persone nei verbali', confidence: 81, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-istanza', page: 1, before: 'con indicazione del ', highlight: 'titolare', after: ", dell'oggetto, della data di rilascio e del canone annuo" }, // allow-italian: fixture data, shown as written
      reasoning: ['Se si danno i nomi, ognuno va avvisato e ha 10 giorni per opporsi, con il termine sospeso (art. 5 c.5). Con i nomi omessi non serve.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'scadenza', label: 'Scadenza', value: '05/12/2026 · risposta', short: '05/12', confidence: 87, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-pec', page: 1, before: 'il giorno ', highlight: '05/11/2026 alle ore 16:20:37', after: ' il messaggio è stato inviato' }, // allow-italian: fixture data, shown as written
      reasoning: ['30 giorni dalla presentazione (art. 5 c.6): ', { strong: 'sabato 05/12/2026' }, '. Il termine non si sposta: conviene rispondere entro venerdì 04/12.'], // allow-italian: fixture data, shown as written
    },
  ],
  deadlines: [
    {
      id: 'risposta', label: "Provvedimento sull'accesso civico", // allow-italian: fixture data, shown as written
      from: '2026-11-05', days: 30, date: '2026-12-05', rollsOver: false,
      rule: 'art. 5 c.6 D.Lgs. 33/2013',
      calc: "30 giorni dalla presentazione dell'istanza, il 05/11/2026: sabato 05/12/2026. È un termine amministrativo e non si sposta al lunedì, quindi la risposta va inviata entro venerdì 04/12. Se si avvisano i controinteressati, il termine resta sospeso fino a 10 giorni (art. 5 c.5).", // allow-italian: fixture data, shown as written
      office: 'segreteria',
    },
  ],
  steps: [
    { id: 'arrivata', label: 'Arrivata', flowStep: 'trigger', state: 'done', at: '2026-11-05 16:20', by: 'Flusso PEC' }, // allow-italian: fixture data, shown as written
    { id: 'classificata', label: 'Classificata', flowStep: 's2', state: 'done', at: '2026-11-05 16:21', by: 'AI' }, // allow-italian: fixture data, shown as written
    { id: 'registro', label: 'Registro degli accessi', flowStep: 'f3', state: 'current' }, // allow-italian: fixture data, shown as written
    { id: 'controinteressati', label: 'Controinteressati', flowStep: 'f4', state: 'todo' }, // allow-italian: fixture data, shown as written
    { id: 'risposta', label: 'Risposta', flowStep: 'f5', state: 'todo' }, // allow-italian: fixture data, shown as written
  ],
  documents: [
    {
      id: 'd-pec', name: 'PEC del 05/11/2026', kind: 'mail', // allow-italian: fixture data, shown as written
      detail: 'messaggio di posta certificata · 2 allegati', // allow-italian: fixture data, shown as written
      from: 'associazione.esempio@x.example.it', receivedAt: '2026-11-05T16:20:37+01:00', // allow-italian: fixture data, shown as written
      summary: [{ text: "Trasmette l'istanza firmata e il documento di identità; l'oggetto parla di «accesso agli atti».", page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2419', 'd-pec', 1),
    },
    {
      id: 'd-istanza', name: 'istanza-accesso.pdf.p7m', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: '2 pagine · firmata', // allow-italian: fixture data, shown as written
      from: 'Associazione (esempio)', receivedAt: '2026-11-05T16:20:37+01:00', signed: true, // allow-italian: fixture data, shown as written
      summary: [
        { text: 'Accesso civico generalizzato: elenco delle concessioni 2024-2025 su due canali e verbali per scarichi.', page: 1 }, // allow-italian: fixture data, shown as written
        { text: 'Nessuna motivazione richiesta; il richiedente sa dei controinteressati e della sospensione.', page: 2 }, // allow-italian: fixture data, shown as written
      ],
      ...original('2419', 'd-istanza', 2),
    },
  ],
  history: [
    { at: '2026-11-05 16:20', who: 'Flusso PEC', what: 'PEC consegnata su protocollo@ con 2 allegati', doc: 'd-pec' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 16:21', who: 'AI', what: 'Riconosciuta come accesso agli atti (percorso F), tipo civico generalizzato, fiducia 74%' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 16:21', who: 'Regola del flusso', what: 'Termine calcolato: 05/12/2026, sabato' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 16:22', who: 'AI', what: 'Possibili controinteressati: titolari delle concessioni e persone nei verbali', doc: 'd-istanza' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 16:22', who: 'AI', what: "Documento di identità allegato: tenuto fuori dall'anteprima, contiene dati personali" }, // allow-italian: fixture data, shown as written
    { at: '2026-11-06 09:02', who: 'Operatore del protocollo (esempio)', what: 'Aperta, non ancora confermata' }, // allow-italian: fixture data, shown as written
  ],
  draft: {
    file: 'risposta-accesso-2419.docx',
    meta: 'preparata 16:24 · da rivedere', // allow-italian: fixture data, shown as written
    blocks: [
      { kind: 'heading', lines: ['Consorzio di Bonifica Integrale Comprensorio Sarno', "Risposta all'istanza di accesso civico generalizzato"] }, // allow-italian: fixture data, shown as written
      {
        kind: 'paragraph',
        text: ["Con riferimento all'istanza dell'Associazione (esempio) del 5 novembre 2026", { source: { id: 'd-istanza', label: 'istanza', page: 1 } }, ', presentata ai sensi dell\'art. 5, comma 2, del D.Lgs. 33/2013, si comunica quanto segue.'], // allow-italian: fixture data, shown as written
      },
      {
        kind: 'paragraph',
        lead: '1. Elenco delle concessioni.', // allow-italian: fixture data, shown as written
        text: ["Si trasmette l'elenco delle concessioni rilasciate nel 2024 e nel 2025 sul Canale dei Mulini e sul Canale Macchione, con oggetto, data e canone. Per i titolari persone fisiche il nome è omesso, a tutela dei dati personali (art. 5-bis, comma 2, lett. a)."], // allow-italian: fixture data, shown as written
      },
      { kind: 'proposal', text: "Per i verbali con procedimento sanzionatorio ancora aperto conviene differire l'accesso alla chiusura del procedimento invece di negarlo: l'art. 5-bis, comma 5, non consente il diniego quando basta il differimento." }, // allow-italian: fixture data, shown as written
      { kind: 'paragraph', muted: true, lead: '2. Verbali di accertamento.', text: ['…'] }, // allow-italian: fixture data, shown as written
    ],
  },
  assistant: {
    description: 'Vede solo questa pratica, i suoi documenti e la Conoscenza.', // allow-italian: fixture data, shown as written
    turns: [
      { role: 'user', text: ['Ci sono controinteressati da avvisare?'] }, // allow-italian: fixture data, shown as written
      { role: 'assistant', text: ['Solo se si danno i nomi. L\'istanza chiede il titolare di ogni concessione', { source: { id: 'd-istanza', page: 1 } }, ': con i nomi delle persone fisiche omessi non serve avvisare nessuno e il termine resta il 05/12.'] }, // allow-italian: fixture data, shown as written
      { role: 'user', text: ['Quante concessioni sono?'] }, // allow-italian: fixture data, shown as written
      { role: 'assistant', text: ["Nel registro delle concessioni del Tecnico: 14 sui due canali nel 2024-2025, 9 intestate a persone fisiche (numeri di esempio). I verbali per scarichi sono 3, uno con procedimento ancora aperto."] }, // allow-italian: fixture data, shown as written
    ],
    checklist: [
      { id: 'c1', text: 'Confermare il tipo di accesso', done: false, closedByConfirm: true }, // allow-italian: fixture data, shown as written
      { id: 'c2', text: 'Iscrivere nel registro degli accessi', done: false }, // allow-italian: fixture data, shown as written
      { id: 'c3', text: "Estrarre l'elenco dal registro delle concessioni", done: false }, // allow-italian: fixture data, shown as written
      { id: 'c4', text: 'Decidere sui verbali: parziale o differito', done: false }, // allow-italian: fixture data, shown as written
      { id: 'c5', text: 'Rispondere entro venerdì 04/12', done: false }, // allow-italian: fixture data, shown as written
    ],
  },
  related: ['2386', '2395'],
  norms: ['dlgs-33-2013/a5', 'dlgs-33-2013/a5bis'],
  primaryAction: {
    label: 'Invia la risposta', // allow-italian: fixture data, shown as written
    kind: 'send-pec',
    receipt: {
      title: 'Ricevuta di avvenuta consegna', // allow-italian: fixture data, shown as written
      lines: [
        "Messaggio «Risposta all'istanza di accesso civico del 05/11/2026»", // allow-italian: fixture data, shown as written
        'Consegnato a associazione.esempio@x.example.it il 06/11/2026 alle 10:33', // allow-italian: fixture data, shown as written
        'Protocollo in partenza n. 2026/0018504 (esempio)', // allow-italian: fixture data, shown as written
        'Registro degli accessi: esito e data annotati', // allow-italian: fixture data, shown as written
      ],
    },
  },
  example: true,
};
