/**
 * Case 2420: a report from the territory on WhatsApp, a blocked grate on the
 * Canale Torello in Castel San Giorgio with water on the road. Flow
 * `segnalazioni`, office Manutenzione, urgent. The same report the protocol
 * queue of `../../inbox.ts` shows as the blocked grate on the Canale Torello.
 *
 * Real: Castel San Giorgio and its canals (DATI-VERI.md, `../../views.ts`),
 * the maintenance done with the Consorzio's own workers and vehicles. An
 * example: the citizen, the number, the photo (a drawing, captioned so), the
 * position, the 24-hour rule (an internal rule, declared as an example).
 * WhatsApp reports are not protocolled.
 */
import type { CaseSeed } from '../types';
import { original } from './originals';

export const CASE_2420: CaseSeed = {
  id: '2420',
  org: 'nocera',
  kind: 'segnalazione',
  title: 'Griglia ostruita sul Canale Torello', // allow-italian: fixture data, shown as written
  subject: 'Griglia del Canale Torello ostruita, acqua sulla strada', // allow-italian: fixture data, shown as written
  office: 'manutenzione',
  flow: 'segnalazioni',
  channel: 'whatsapp',
  arrivedAt: '2026-11-06T07:46:00+01:00',
  counterpart: 'Cittadino (esempio)', // allow-italian: fixture data, shown as written
  status: 'da-confermare',
  urgent: true,
  assignee: 'protocollo',
  comune: 'Castel San Giorgio',
  proposal: 'Manutenzione · sopralluogo entro 07/11', // allow-italian: fixture data, shown as written
  fields: [
    {
      id: 'ufficio', label: 'Ufficio', value: 'Manutenzione', confidence: 81, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-whatsapp', page: 1, before: 'è completamente ', highlight: 'ostruita da rami e plastica', after: '.' }, // allow-italian: fixture data, shown as written
      reasoning: ['Rami e plastica sulla griglia: è ', { strong: 'manutenzione' }, ' ordinaria. Se al sopralluogo la griglia risulta danneggiata, passa al Tecnico. Sotto 85% conferma una persona.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'canale', label: 'Canale', value: 'Canale Torello', confidence: 96, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-whatsapp', page: 1, before: 'la griglia del ', highlight: 'Canale Torello', after: ' sotto il ponticello' }, // allow-italian: fixture data, shown as written
      reasoning: ['Il nome nel messaggio e la posizione condivisa cadono sullo stesso tratto in QGIS', { source: { id: 'd-qgis', label: 'localizzazione', page: 1 } }, '.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'comune', label: 'Comune', value: 'Castel San Giorgio', confidence: 98, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-whatsapp', page: 1, before: 'Posizione condivisa: ', highlight: 'Castel San Giorgio', after: ', ponticello sul Canale Torello' }, // allow-italian: fixture data, shown as written
      reasoning: ['Comune del comprensorio Alto: lo scrive il cittadino e lo conferma la posizione.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'urgenza', label: 'Urgenza', value: 'Alta: acqua sulla strada e un cortile allagato', confidence: 90, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-whatsapp', page: 1, before: "C'è anche ", highlight: "un'abitazione con il cortile allagato", after: '.' }, // allow-italian: fixture data, shown as written
      reasoning: ['Acqua fuori alveo vicino a un\'abitazione: urgente per la regola del flusso. Alle 08:07 il cittadino scrive che l\'acqua è ferma, ma la griglia è ancora piena.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'foto', label: 'Foto', value: 'Griglia piena di rami e plastica', confidence: 84, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-whatsapp', page: 1, before: 'foto di esempio · ', highlight: 'griglia ostruita e acqua sulla strada', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ["La foto mostra la griglia di monte coperta di rami e rifiuti e l'acqua sull'asfalto; non si vede se le sbarre sono piegate."], // allow-italian: fixture data, shown as written
    },
  ],
  deadlines: [
    {
      id: 'sopralluogo', label: 'Sopralluogo', // allow-italian: fixture data, shown as written
      from: '2026-11-06', days: 1, date: '2026-11-07', rollsOver: false,
      rule: 'regola interna di esempio: sopralluogo entro 24 ore', // allow-italian: fixture data, shown as written
      calc: 'Segnalazione delle 07:46 di venerdì 06/11/2026: sopralluogo entro le 07:46 di sabato 07/11. È un servizio di pronto intervento: vale anche di sabato e non si sposta.', // allow-italian: fixture data, shown as written
      office: 'manutenzione',
    },
  ],
  steps: [
    { id: 'ricevuta', label: 'Ricevuta', flowStep: 's1', state: 'done', at: '2026-11-06 07:46', by: 'WhatsApp' }, // allow-italian: fixture data, shown as written
    { id: 'localizzata', label: 'Localizzata', flowStep: 's2', state: 'done', at: '2026-11-06 07:50', by: 'QGIS' }, // allow-italian: fixture data, shown as written
    { id: 'confermata', label: 'Confermata', flowStep: 's3', state: 'current' }, // allow-italian: fixture data, shown as written
    { id: 'sopralluogo', label: 'Sopralluogo', flowStep: 's4', state: 'todo' }, // allow-italian: fixture data, shown as written
    { id: 'intervento', label: 'Intervento', flowStep: 's5', state: 'todo' }, // allow-italian: fixture data, shown as written
    { id: 'chiusa', label: 'Risposta e chiusura', flowStep: 's6', state: 'todo' }, // allow-italian: fixture data, shown as written
  ],
  documents: [
    {
      id: 'd-whatsapp', name: 'Conversazione WhatsApp', kind: 'image', // allow-italian: fixture data, shown as written
      detail: '7 messaggi · 1 foto · 1 posizione', // allow-italian: fixture data, shown as written
      from: 'Cittadino (esempio), WhatsApp', receivedAt: '2026-11-06T07:46:00+01:00', // allow-italian: fixture data, shown as written
      summary: [{ text: "Griglia del Canale Torello ostruita, acqua sulla strada e un cortile allagato; alle 08:07 l'acqua è ferma.", page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2420', 'd-whatsapp', 1),
    },
    {
      id: 'd-qgis', name: 'Localizzazione QGIS', kind: 'image', // allow-italian: fixture data, shown as written
      detail: 'da QGIS · 1 pagina', // allow-italian: fixture data, shown as written
      from: 'QGIS',
      summary: [{ text: 'Il punto inviato cade a 12 m dalla griglia di monte del ponticello sul Canale Torello.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2420', 'd-qgis', 1),
    },
  ],
  history: [
    { at: '2026-11-06 07:46', who: 'WhatsApp', what: 'Messaggio con foto e posizione', doc: 'd-whatsapp' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-06 07:47', who: 'AI', what: 'Riconosciuta come segnalazione dal territorio, urgente: acqua sulla strada' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-06 07:50', who: 'QGIS', what: 'Punto sul Canale Torello, Castel San Giorgio', doc: 'd-qgis' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-06 07:52', who: 'Flusso segnalazioni', what: 'Risposta automatica al cittadino con il numero 2420' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-06 08:05', who: 'Assistente della pratica', what: 'Risposta al cittadino: sopralluogo entro domani mattina' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-06 08:07', who: 'WhatsApp', what: "Il cittadino scrive che l'acqua è ferma, la griglia ancora piena" }, // allow-italian: fixture data, shown as written
  ],
  draft: {
    file: 'ordine-intervento-2420.docx',
    meta: 'preparato 07:53 · da confermare', // allow-italian: fixture data, shown as written
    blocks: [
      { kind: 'heading', lines: ['Ordine di intervento', 'Squadra di manutenzione'] }, // allow-italian: fixture data, shown as written
      {
        kind: 'paragraph',
        text: ['Segnalazione 2420 del 06/11/2026, ore 07:46, via WhatsApp', { source: { id: 'd-whatsapp', label: 'conversazione', page: 1 } }, ': griglia ostruita sul Canale Torello a Castel San Giorgio, sotto il ponticello stradale, con acqua sulla strada', { source: { id: 'd-qgis', label: 'QGIS', page: 1 } }, '.'], // allow-italian: fixture data, shown as written
      },
      {
        kind: 'paragraph',
        lead: 'Intervento richiesto.', // allow-italian: fixture data, shown as written
        text: ['Sopralluogo entro sabato 07/11 alle 07:46, rimozione del materiale dalla griglia e pulizia del tratto a monte. Foto prima e dopo nella pratica.'], // allow-italian: fixture data, shown as written
      },
      { kind: 'proposal', text: "Avvisare la Polizia municipale di Castel San Giorgio: c'è acqua sulla strada e un cortile allagato, il transito va segnalato finché la squadra non arriva." }, // allow-italian: fixture data, shown as written
    ],
  },
  assistant: {
    description: 'Vede solo questa pratica, i suoi documenti e la Conoscenza.', // allow-italian: fixture data, shown as written
    turns: [
      { role: 'user', text: ['Rispondi al cittadino che arriviamo entro domani mattina.'] }, // allow-italian: fixture data, shown as written
      { role: 'assistant', text: ["Inviato su WhatsApp alle 08:05", { source: { id: 'd-whatsapp', page: 1 } }, ". Alle 08:07 ha risposto che l'acqua ora è ferma ma la griglia è ancora piena."] }, // allow-italian: fixture data, shown as written
      { role: 'user', text: ['È lo stesso canale della pratica 2418?'] }, // allow-italian: fixture data, shown as written
      { role: 'assistant', text: ['Sì, il Canale Torello è sulla Tavola 12 della pratica 2418', { source: { id: '2418', label: 'pratica 2418' } }, ', ma il ponticello è fuori dalle particelle del ricorso. Le collego.'] }, // allow-italian: fixture data, shown as written
    ],
    checklist: [
      { id: 'c1', text: 'Confermare ufficio e urgenza', done: false, closedByConfirm: true }, // allow-italian: fixture data, shown as written
      { id: 'c2', text: 'Mandare la squadra', done: false }, // allow-italian: fixture data, shown as written
      { id: 'c3', text: 'Avvisare la Polizia municipale', done: false }, // allow-italian: fixture data, shown as written
      { id: 'c4', text: 'Foto prima e dopo', done: false }, // allow-italian: fixture data, shown as written
      { id: 'c5', text: 'Chiudere con risposta al cittadino', done: false }, // allow-italian: fixture data, shown as written
    ],
  },
  related: ['2418'],
  primaryAction: {
    label: 'Manda la squadra', // allow-italian: fixture data, shown as written
    kind: 'order',
    receipt: {
      title: 'Ordine di intervento inviato', // allow-italian: fixture data, shown as written
      lines: [
        'Ordine n. 2026/0412 (esempio) alla squadra di manutenzione', // allow-italian: fixture data, shown as written
        'Luogo: Canale Torello, Castel San Giorgio, griglia sotto il ponticello', // allow-italian: fixture data, shown as written
        'Sopralluogo entro sabato 07/11 alle 07:46', // allow-italian: fixture data, shown as written
        'Cittadino avvisato su WhatsApp alle 10:31', // allow-italian: fixture data, shown as written
      ],
    },
  },
  example: true,
};
