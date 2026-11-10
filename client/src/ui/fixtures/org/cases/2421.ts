/**
 * Case 2421: a note from the Regione Campania on implementing L.R. 7/2025,
 * asking every Consorzio for its data within 20 days. PEC flow, path C,
 * office Direzione.
 *
 * Real: L.R. 7/2025 and its articles 2, 4 and 5, and every number in the
 * draft reply (DATI-VERI.md: 43.054 ha, about 680 km of network split
 * 610/50/20, 24 basins, 129 employees at 31/12/2024, Piano di Classifica 1996
 * approved by D.G.R. 0403/AC of 18/03/1997). An example: the note itself, its
 * number and the regional office that sends it. The note asks for staff at
 * 31/12/2025; the sources only have 31/12/2024, and the draft says so.
 */
import type { CaseSeed } from '../types';
import { original } from './originals';

export const CASE_2421: CaseSeed = {
  id: '2421',
  org: 'nocera',
  kind: 'regione',
  title: 'Regione Campania, dati per la L.R. 7/2025', // allow-italian: fixture data, shown as written
  subject: 'L.R. 6 giugno 2025, n. 7. Attuazione: ricognizione dei dati dei Consorzi', // allow-italian: fixture data, shown as written
  office: 'direzione',
  flow: 'pec',
  channel: 'pec',
  arrivedAt: '2026-11-06T08:15:00+01:00',
  protocol: { number: '2026/0018478', date: '2026-11-06' },
  counterpart: 'Regione Campania (nota di esempio)', // allow-italian: fixture data, shown as written
  status: 'da-confermare',
  assignee: 'protocollo',
  proposal: 'Direzione · risposta entro 26/11', // allow-italian: fixture data, shown as written
  fields: [
    {
      id: 'ufficio', label: 'Ufficio', value: 'Direzione', confidence: 84, consulted: 3, // allow-italian: fixture data, shown as written
      source: { doc: 'd-nota', page: 1, before: 'si chiede a ', highlight: 'ciascun Consorzio', after: ' di trasmettere' }, // allow-italian: fixture data, shown as written
      reasoning: ["Nota della Regione a tutti i Consorzi, firmata dal legale rappresentante: la regola del flusso la manda sempre a una persona della Direzione. I dati vengono da Tecnico, Catasto e personale."], // allow-italian: fixture data, shown as written
    },
    {
      id: 'richieste', label: 'Dati richiesti', value: 'superficie, rete e opere, personale, classifica, difesa del suolo', confidence: 92, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-nota', page: 1, before: 'a) ', highlight: 'superficie del comprensorio di attuale operatività', after: ';' }, // allow-italian: fixture data, shown as written
      reasoning: ['Cinque voci, da a) a e). Quattro hanno già una risposta nelle fonti del Consorzio; il personale al 31/12/2025 va preso da Publisys.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'scadenza', label: 'Scadenza', value: '26/11/2026 · risposta', short: '26/11', confidence: 88, consulted: 2, // allow-italian: fixture data, shown as written
      source: { doc: 'd-nota', page: 1, before: 'di trasmettere, ', highlight: 'entro 20 giorni dal ricevimento della presente', after: ', i seguenti dati' }, // allow-italian: fixture data, shown as written
      reasoning: ['PEC ricevuta il 06/11/2026: 20 giorni, ', { strong: 'giovedì 26/11/2026' }, '.'], // allow-italian: fixture data, shown as written
    },
  ],
  deadlines: [
    {
      id: 'risposta', label: 'Invio dei dati alla Regione', // allow-italian: fixture data, shown as written
      from: '2026-11-06', days: 20, date: '2026-11-26', rollsOver: false,
      rule: 'termine fissato nella nota regionale (esempio)', // allow-italian: fixture data, shown as written
      calc: '20 giorni dal ricevimento della PEC, il 06/11/2026: giovedì 26/11/2026.', // allow-italian: fixture data, shown as written
      office: 'direzione',
    },
  ],
  steps: [
    { id: 'arrivata', label: 'Arrivata', flowStep: 'trigger', state: 'done', at: '2026-11-06 08:15', by: 'Flusso PEC' }, // allow-italian: fixture data, shown as written
    { id: 'classificata', label: 'Classificata', flowStep: 's2', state: 'done', at: '2026-11-06 08:16', by: 'AI' }, // allow-italian: fixture data, shown as written
    { id: 'protocollata', label: 'Protocollata', flowStep: 'c3', state: 'current' }, // allow-italian: fixture data, shown as written
    { id: 'risposta', label: 'Risposta', flowStep: 'c4', state: 'todo' }, // allow-italian: fixture data, shown as written
    { id: 'invio', label: 'Firma e invio', flowStep: 'c5', state: 'todo' }, // allow-italian: fixture data, shown as written
  ],
  documents: [
    {
      id: 'd-nota', name: 'nota-regione-0541234.pdf.p7m', kind: 'pdf', // allow-italian: fixture data, shown as written
      detail: '1 pagina · firmata', // allow-italian: fixture data, shown as written
      from: 'Regione Campania (nota di esempio)', receivedAt: '2026-11-06T08:15:00+01:00', signed: true, // allow-italian: fixture data, shown as written
      summary: [{ text: 'Chiede entro 20 giorni superficie, rete, personale al 31/12/2025, classifica e proposte sulla difesa del suolo.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('2421', 'd-nota', 1),
    },
  ],
  history: [
    { at: '2026-11-06 08:15', who: 'Flusso PEC', what: 'PEC consegnata su protocollo@ con 1 allegato', doc: 'd-nota' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-06 08:16', who: 'AI', what: 'Riconosciuta come comunicazione da un ente (percorso C): Regione, sempre a una persona' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-06 08:16', who: 'Regola del flusso', what: 'Termine calcolato: 26/11/2026' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-06 08:18', who: 'Assistente della pratica', what: 'Bozza di risposta con i dati già nelle fonti del Consorzio' }, // allow-italian: fixture data, shown as written
  ],
  draft: {
    file: 'risposta-regione-lr7.docx',
    meta: 'preparata 08:18 · dati da confermare', // allow-italian: fixture data, shown as written
    blocks: [
      { kind: 'heading', lines: ['Consorzio di Bonifica Integrale Comprensorio Sarno', 'Dati per la ricognizione L.R. 7/2025'] }, // allow-italian: fixture data, shown as written
      { kind: 'paragraph', lead: 'a) Superficie.', text: ['Comprensorio di attuale operatività: 43.054 ettari, bacini Sarno, Torrenti Vesuviani e Irno', { source: { id: 'libro-anno-2025', label: "Libro dell'anno 2025" } }, '.'] }, // allow-italian: fixture data, shown as written
      { kind: 'paragraph', lead: 'b) Rete e opere.', text: ['Circa 680 km di rete idraulica: 610 km di canali di bonifica, 50 km promiscui, 20 km irrigui; 24 vasche assorbenti laminanti', { source: { id: 'libro-anno-2025', label: "Libro dell'anno 2025" } }, '.'] }, // allow-italian: fixture data, shown as written
      { kind: 'paragraph', lead: 'd) Classifica.', text: ['Piano di Classifica del Territorio 1996, approvato con delibera G.R. Campania n. 0403/AC del 18/03/1997.'] }, // allow-italian: fixture data, shown as written
      { kind: 'proposal', text: 'Per il punto c) la Regione chiede il personale al 31/12/2025: nelle fonti c\'è solo il 31/12/2024 (129 dipendenti, 3 dirigenti, 30 impiegati, 96 operai). Il dato aggiornato va estratto da Publisys prima di firmare.' }, // allow-italian: fixture data, shown as written
      { kind: 'paragraph', muted: true, lead: 'e) Difesa del suolo.', text: ['…'] }, // allow-italian: fixture data, shown as written
    ],
  },
  norms: ['lr-7-2025/a2', 'lr-7-2025/a4', 'lr-7-2025/a5'],
  primaryAction: {
    label: 'Invia i dati alla Regione', // allow-italian: fixture data, shown as written
    kind: 'send-pec',
    receipt: {
      title: 'Ricevuta di avvenuta consegna', // allow-italian: fixture data, shown as written
      lines: [
        'Messaggio «Riscontro alla nota prot. n. 2026.0541234, L.R. 7/2025»', // allow-italian: fixture data, shown as written
        'Consegnato alla casella PEC della Regione il 06/11/2026 alle 10:36', // allow-italian: fixture data, shown as written
        'Protocollo in partenza n. 2026/0018505 (esempio)', // allow-italian: fixture data, shown as written
      ],
    },
  },
  example: true,
};
