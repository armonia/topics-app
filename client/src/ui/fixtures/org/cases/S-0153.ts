/**
 * Case S-0153: AMA reports leaves blocking the drains of a street, on Teams.
 * SARIM, flow `sarim-segnalazioni`, office Call center.
 *
 * Real: SARIM handles reports from AMA and from private users, and the leaf
 * collection service (training questionnaire of 26-28/10, DATI-VERI.md). An
 * example: the street, the AMA contact, the reference number, the deadline
 * (the one AMA asks for in its message).
 */
import type { CaseSeed } from '../types';
import { original } from './originals';

export const CASE_S0153: CaseSeed = {
  id: 'S-0153',
  org: 'sarim',
  kind: 'foglie',
  title: 'AMA: foglie sulle caditoie, via Esempio', // allow-italian: fixture data, shown as written
  subject: 'Accumulo di foglie che ostruisce le caditoie, civici 20-48', // allow-italian: fixture data, shown as written
  office: 'call-center',
  flow: 'sarim-segnalazioni',
  channel: 'teams',
  arrivedAt: '2026-11-05T14:12:00+01:00',
  counterpart: 'AMA, referente (esempio)', // allow-italian: fixture data, shown as written
  status: 'in-lavorazione',
  urgent: true,
  assignee: 'sarim-cc',
  proposal: 'Call center · passaggio entro sabato 07/11', // allow-italian: fixture data, shown as written
  fields: [
    {
      id: 'luogo', label: 'Luogo', value: 'via Esempio, civici 20-48', confidence: 93, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-teams', page: 1, before: 'ostruisce le caditoie in ', highlight: 'via Esempio, tra i civici 20 e 48', after: '.' }, // allow-italian: fixture data, shown as written
      reasoning: ['Tratto del giro foglie del giovedì: la squadra più vicina è quella del mattino.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'riferimento', label: 'Riferimento AMA', value: 'n. 88213', confidence: 97, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-teams', page: 1, before: 'Riferimento della segnalazione nel nostro sistema: ', highlight: 'n. 88213', after: '.' }, // allow-italian: fixture data, shown as written
      reasoning: ["Va riportato nell'esito ad AMA e nella rendicontazione del servizio foglie."], // allow-italian: fixture data, shown as written
    },
    {
      id: 'scadenza', label: 'Entro', value: 'sabato 07/11', short: '07/11', confidence: 89, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-teams', page: 1, before: 'serve un passaggio ', highlight: 'entro sabato', after: '.' }, // allow-italian: fixture data, shown as written
      reasoning: ['Messaggio di giovedì 05/11: «entro sabato» è il ', { strong: '07/11' }, '. Pioggia prevista per venerdì: urgente.'], // allow-italian: fixture data, shown as written
    },
  ],
  deadlines: [
    {
      id: 'passaggio', label: 'Passaggio della squadra', // allow-italian: fixture data, shown as written
      from: '2026-11-05', days: 2, date: '2026-11-07', rollsOver: false,
      rule: 'termine chiesto da AMA nel messaggio (esempio)', // allow-italian: fixture data, shown as written
      calc: 'Richiesta di giovedì 05/11/2026 «entro sabato»: sabato 07/11/2026. Il servizio lavora anche di sabato, il termine non si sposta.', // allow-italian: fixture data, shown as written
      office: 'call-center',
    },
  ],
  steps: [
    { id: 'ricevuta', label: 'Ricevuta', flowStep: 's1', state: 'done', at: '2026-11-05 14:12', by: 'Teams' }, // allow-italian: fixture data, shown as written
    { id: 'ticket', label: 'Ticket aperto', flowStep: 's2', state: 'done', at: '2026-11-05 14:20', by: 'Operatrice call center SARIM (esempio)' }, // allow-italian: fixture data, shown as written
    { id: 'squadra', label: 'Squadra assegnata', flowStep: 's3', state: 'current' }, // allow-italian: fixture data, shown as written
    { id: 'intervento', label: 'Intervento', flowStep: 's4', state: 'todo' }, // allow-italian: fixture data, shown as written
    { id: 'esito', label: 'Esito ad AMA', flowStep: 's5', state: 'todo' }, // allow-italian: fixture data, shown as written
  ],
  documents: [
    {
      id: 'd-teams', name: 'Chat Teams AMA · SARIM', kind: 'image', // allow-italian: fixture data, shown as written
      detail: '3 messaggi · 05/11/2026', // allow-italian: fixture data, shown as written
      from: 'Referente AMA (esempio), Teams', receivedAt: '2026-11-05T14:12:00+01:00', // allow-italian: fixture data, shown as written
      summary: [{ text: 'Foglie sulle caditoie tra i civici 20 e 48; passaggio entro sabato; riferimento AMA n. 88213.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('S-0153', 'd-teams', 1),
    },
  ],
  history: [
    { at: '2026-11-05 14:12', who: 'Teams', what: 'Messaggio del referente AMA', doc: 'd-teams' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 14:13', who: 'AI', what: 'Riconosciuta come segnalazione AMA, servizio foglie, urgente' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-05 14:20', who: 'Operatrice call center SARIM (esempio)', what: 'Ticket aperto e risposta su Teams' }, // allow-italian: fixture data, shown as written
  ],
  primaryAction: {
    label: 'Assegna la squadra', // allow-italian: fixture data, shown as written
    kind: 'order',
    receipt: {
      title: 'Squadra assegnata', // allow-italian: fixture data, shown as written
      lines: [
        'Squadra foglie del mattino (esempio), sabato 07/11 alle 7:00', // allow-italian: fixture data, shown as written
        'Ticket S-0153 collegato al riferimento AMA n. 88213', // allow-italian: fixture data, shown as written
        'Orario comunicato ad AMA su Teams', // allow-italian: fixture data, shown as written
      ],
    },
  },
  example: true,
};
