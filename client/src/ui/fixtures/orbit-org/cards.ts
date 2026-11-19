/**
 * The work on the kanban of «Da fare» in the SARIM edition: the columns and (allow-italian: quotes the Italian interface)
 * every card, each on the flow that moves it, with its history, who has it in
 * hand, who checks it, its originals and the values read on them.
 *
 * The demo moment is Friday 6 November 2026, 10:30 (`DEMO_NOW`): nothing here
 * happens after it except due dates. A card in «Fatto» was closed from 30/10 on. (allow-italian: quotes the Italian interface)
 * Cards are stopped for one of two reasons: blocked on something outside it,
 * or left in its column longer than its flow's `stuckAfterHours`; every other
 * open card entered its column more recently than that. Card ids, amounts,
 * plates, invoice and form numbers are examples, coherent across screens
 * (`scripts/ui-fixtures/sarim-cards.ts` checks them).
 */
import type { CardOriginal, CardValue, SarimCard, Stage, StageEntry, StageId, Worker } from './types';

/* ---------- helpers ---------- */

/** `2026-11-06T09:40:00+01:00` from `11-06` and `09:40`: every time on a card is autumn 2026, Rome time. */
const at = (day: string, time: string) => `2026-${day}T${time}:00+01:00`;
const entry = (stage: StageId, when: string, by: string): StageEntry => ({ stage, at: when, by });
const agentWorker = (id: string, doing: string, since: string): Worker => ({ kind: 'agent', id, doing, since });
const personWorker = (id: string, doing: string, since: string): Worker => ({ kind: 'person', id, doing, since });
const paper = (id: string, name: string, kind: CardOriginal['kind'], from: string, when: string, lines: string[]): CardOriginal => ({ id, name, kind, from, at: when, lines });
const read = (label: string, value: string, doc: string, quote: string, confidence: number): CardValue => ({ label, value, doc, quote, confidence });

/** The lines every invoice to SARIM and every form SARIM carries repeat (public data of S.A.R.I.M. SRL). */
const BUYER = 'Cessionario/committente: S.A.R.I.M. SRL, P.IVA 02596800652';
const CARRIER = 'Trasportatore: S.A.R.I.M. SRL, iscrizione Albo Gestori Ambientali NA00165';
const CALL_LINE = 'numero verde 800.983850'; // allow-italian: fixture data, shown as written

/* ---------- columns ---------- */

export const SARIM_STAGES: Stage[] = [
  { id: 'arrivo', label: 'In arrivo', hint: "L'agente lo legge e lo prepara" }, // allow-italian: fixture data, shown as written
  { id: 'lavorazione', label: 'In lavorazione', hint: 'Ci lavora un agente o una persona' }, // allow-italian: fixture data, shown as written
  { id: 'verifica', label: 'Da verificare', hint: "Una persona verifica ciò che l'agente ha letto e proposto" }, // allow-italian: fixture data, shown as written
  { id: 'approvazione', label: 'Da approvare', hint: 'Aspetta chi approva o firma' }, // allow-italian: fixture data, shown as written
  { id: 'fatto', label: 'Fatto', hint: 'Chiuso negli ultimi 7 giorni' }, // allow-italian: fixture data, shown as written
];

/* ---------- segnalazioni: AMA, utenze, servizio foglie (14) ---------- */

const REPORTS: SarimCard[] = [
  {
    id: 'SG-4131', flow: 'sarim-segnalazioni', step: 's1',
    title: 'Mancato ritiro organico, utenza non domestica', // allow-italian: fixture data, shown as written
    detail: 'Roma, Municipio V · Via Prenestina 312 · segnalazione AMA 18452', place: 'Roma (AMA)', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '10:14'), 'agent:ag-segnalazioni')],
    worker: agentWorker('ag-segnalazioni', 'legge la mail AMA e cerca il giro saltato di giovedì', at('11-06', '10:14')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', due: '2026-11-06', priority: 'alta',
    originals: [
      paper('mail-ama', 'Mail AMA, segnalazione 18452', 'mail', 'mail AMA', at('11-06', '10:13'), [ // allow-italian: fixture data, shown as written
        'Oggetto: segnalazione n. 18452 del 06/11/2026, mancato ritiro utenza non domestica', // allow-italian: fixture data, shown as written
        'Municipio V, Via Prenestina 312, utenza non domestica codice UND-05-04471 (bar).', // allow-italian: fixture data, shown as written
        'Frazione: organico. Ritiro previsto: giovedì 05/11/2026, giro serale.', // allow-italian: fixture data, shown as written
        "L'utente segnala il contenitore pieno e non svuotato. Si chiede il recupero in giornata.", // allow-italian: fixture data, shown as written
        'AMA S.p.A., servizio utenze non domestiche', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Indirizzo', 'Via Prenestina 312, Roma', 'mail-ama', 'Municipio V, Via Prenestina 312', 97), // allow-italian: fixture data, shown as written
      read('Utenza', 'UND-05-04471, bar', 'mail-ama', 'codice UND-05-04471 (bar)', 95), // allow-italian: fixture data, shown as written
      read('Frazione', 'organico', 'mail-ama', 'Frazione: organico', 98), // allow-italian: fixture data, shown as written
      read('Giro saltato', 'giovedì 05/11, serale', 'mail-ama', 'giovedì 05/11/2026, giro serale', 93), // allow-italian: fixture data, shown as written
    ],
    proposal: "Recupero oggi nel giro del pomeriggio del cantiere Roma Est, e risposta ad AMA con l'ora del passaggio.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-4132', flow: 'sarim-segnalazioni', step: 's1',
    title: "Ritiro ingombranti prenotato dall'app", // allow-italian: fixture data, shown as written
    detail: 'Agropoli · Via Piave 18 · prenotazione 7731', place: 'Agropoli', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '09:58'), 'agent:ag-segnalazioni')],
    worker: agentWorker('ag-segnalazioni', 'cerca il primo turno ingombranti libero ad Agropoli', at('11-06', '09:59')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', priority: 'normale',
    originals: [
      paper('prenotazione', 'Prenotazione 7731, app Sarim Ambiente', 'form', 'app Sarim Ambiente', at('11-06', '09:57'), [ // allow-italian: fixture data, shown as written
        'App Sarim Ambiente, prenotazione ritiro ingombranti n. 7731', // allow-italian: fixture data, shown as written
        'Comune: Agropoli', // allow-italian: fixture data, shown as written
        'Indirizzo: Via Piave 18, ritiro a bordo strada', // allow-italian: fixture data, shown as written
        'Cosa: 1 materasso matrimoniale, 1 rete a doghe, 2 sedie', // allow-italian: fixture data, shown as written
        'Giorno preferito: martedì mattina', // allow-italian: fixture data, shown as written
        'Inviata il 06/11/2026 alle 09:57', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Comune', 'Agropoli', 'prenotazione', 'Comune: Agropoli', 99), // allow-italian: fixture data, shown as written
      read('Indirizzo', 'Via Piave 18', 'prenotazione', 'Via Piave 18, ritiro a bordo strada', 96), // allow-italian: fixture data, shown as written
      read('Materiali', 'materasso, rete, 2 sedie', 'prenotazione', '1 materasso matrimoniale, 1 rete a doghe, 2 sedie', 94), // allow-italian: fixture data, shown as written
      read('Giorno preferito', 'martedì mattina', 'prenotazione', 'Giorno preferito: martedì mattina', 91), // allow-italian: fixture data, shown as written
    ],
    proposal: "Ritiro martedì 10/11 mattina con il turno ingombranti di Agropoli, conferma all'utente nell'app.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-4134', flow: 'sarim-segnalazioni', step: 's1',
    title: 'Mancato ritiro del multimateriale', // allow-italian: fixture data, shown as written
    detail: 'Albanella · località Matinella · segnalazione Enviro 3308', place: 'Albanella', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '10:21'), 'agent:ag-segnalazioni')],
    worker: agentWorker('ag-segnalazioni', 'consulta il calendario di raccolta della zona', at('11-06', '10:22')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', priority: 'normale',
    originals: [
      paper('enviro', 'Segnalazione Enviro 3308', 'form', 'Enviro, segnalazioni dei cittadini', at('11-06', '10:20'), [ // allow-italian: fixture data, shown as written
        'Enviro, segnalazione n. 3308, Comune di Albanella', // allow-italian: fixture data, shown as written
        'Tipo: mancato ritiro', // allow-italian: fixture data, shown as written
        'Indirizzo: località Matinella, Via dei Pini 4', // allow-italian: fixture data, shown as written
        'Frazione: multimateriale (plastica e metalli)', // allow-italian: fixture data, shown as written
        'Nota del cittadino: «il sacchetto è fuori da mercoledì sera»', // allow-italian: fixture data, shown as written
        'Foto allegata: no', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Indirizzo', 'Via dei Pini 4, Matinella', 'enviro', 'località Matinella, Via dei Pini 4', 92), // allow-italian: fixture data, shown as written
      read('Frazione', 'multimateriale', 'enviro', 'multimateriale (plastica e metalli)', 96), // allow-italian: fixture data, shown as written
      read('Fuori da', 'mercoledì sera', 'enviro', 'fuori da mercoledì sera', 78), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Recupero sabato 07/11 mattina con il giro del multimateriale di Albanella, risposta al cittadino su Enviro.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-4128', flow: 'sarim-segnalazioni', step: 's3', lane: 'pD',
    title: 'Foglie non raccolte dopo lo spazzamento', // allow-italian: fixture data, shown as written
    detail: 'Roma, Municipio XII · Viale dei Colli Portuensi · segnalazione AMA 18437', place: 'Roma (AMA, Smart Leaf)', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '08:46'), 'agent:ag-segnalazioni'),
      entry('lavorazione', at('11-06', '08:52'), 'agent:ag-segnalazioni'),
    ],
    worker: agentWorker('ag-segnalazioni', 'cerca in WinWaste il passaggio della squadra foglie di mercoledì', at('11-06', '08:52')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', due: '2026-11-08', priority: 'normale',
    originals: [
      paper('mail-ama', 'Mail AMA, segnalazione 18437', 'mail', 'mail AMA', at('11-06', '08:45'), [ // allow-italian: fixture data, shown as written
        'Oggetto: segnalazione n. 18437 del 06/11/2026, servizio foglie', // allow-italian: fixture data, shown as written
        'Municipio XII, Viale dei Colli Portuensi, tratto fra i civici 180 e 240.', // allow-italian: fixture data, shown as written
        'Dopo lo spazzamento di mercoledì 04/11 restano cumuli di foglie lungo il marciapiede lato parco.', // allow-italian: fixture data, shown as written
        'Si chiede la verifica del passaggio e un intervento entro 48 ore.', // allow-italian: fixture data, shown as written
        'AMA S.p.A., servizio raccolta foglie', // allow-italian: fixture data, shown as written
      ]),
      { ...paper('schermo-pc', 'Schermo del PC dell\'agente: il tratto sulla mappa', 'screen', 'PC dell\'agente', at('11-06', '08:57'), [ // allow-italian: fixture data, shown as written
        'Viale dei Colli Portuensi, Municipio XII: l\'agente ha aperto la mappa per riconoscere il tratto fra i civici 180 e 240 prima di cercare il passaggio della squadra.', // allow-italian: fixture data, shown as written
      ]), image: 'originali/sg-4128-schermo-pc.jpg' },
    ],
    values: [
      read('Tratto', 'civici 180-240', 'mail-ama', 'tratto fra i civici 180 e 240', 90), // allow-italian: fixture data, shown as written
      read('Passaggio contestato', 'mercoledì 04/11', 'mail-ama', 'spazzamento di mercoledì 04/11', 94), // allow-italian: fixture data, shown as written
      read('Termine', 'entro 48 ore', 'mail-ama', 'un intervento entro 48 ore', 97), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Se il passaggio di mercoledì risulta in WinWaste, ripasso con la squadra foglie del Municipio XII sabato 07/11 alle 6:00 e foto ad AMA a lavoro fatto.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-4129', flow: 'sarim-segnalazioni', step: 's3', lane: 'pC',
    title: 'Abbandono di rifiuti da demolizione, con foto', // allow-italian: fixture data, shown as written
    detail: "Pontecagnano Faiano · area di sosta della strada per Faiano · mail dell'ufficio ambiente", place: 'Pontecagnano Faiano', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '09:40'), 'agent:ag-segnalazioni'),
      entry('lavorazione', at('11-06', '09:47'), 'agent:ag-segnalazioni'),
    ],
    worker: agentWorker('ag-segnalazioni', 'riconosce dalla foto il tipo di rifiuto e stima il volume', at('11-06', '09:47')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', due: '2026-11-09', priority: 'normale',
    originals: [
      paper('mail', "Mail dell'ufficio ambiente", 'mail', "mail dell'ufficio ambiente", at('11-06', '09:38'), [ // allow-italian: fixture data, shown as written
        'Oggetto: abbandono di rifiuti, area di sosta della strada per Faiano', // allow-italian: fixture data, shown as written
        'Segnaliamo un cumulo di calcinacci e mattonelle lasciato nella notte, circa un metro cubo.', // allow-italian: fixture data, shown as written
        'In allegato la foto. Chiediamo la rimozione entro lunedì.', // allow-italian: fixture data, shown as written
        'Ufficio ambiente del Comune', // allow-italian: fixture data, shown as written
      ]),
      paper('foto', 'Foto del cumulo', 'photo', 'allegato alla mail', at('11-06', '09:38'), [ // allow-italian: fixture data, shown as written
        'Foto: cumulo di calcinacci, mattonelle rotte e due sacchi di cemento aperti, a bordo strada.', // allow-italian: fixture data, shown as written
        'Si vede il guard rail; nessun rifiuto pericoloso visibile.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Rifiuto', 'inerti da demolizione', 'mail', 'calcinacci e mattonelle', 88), // allow-italian: fixture data, shown as written
      read('Volume', 'circa 1 m³', 'mail', 'circa un metro cubo', 85), // allow-italian: fixture data, shown as written
      read('Rifiuti pericolosi', 'nessuno visibile', 'foto', 'nessun rifiuto pericoloso visibile', 72), // allow-italian: fixture data, shown as written
      read('Termine', 'entro lunedì 09/11', 'mail', 'Chiediamo la rimozione entro lunedì', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Rimozione lunedì 09/11 con il mezzo con gru del cantiere di Pontecagnano; il formulario si prepara dopo il sopralluogo.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-4126', flow: 'sarim-segnalazioni', step: 's4', lane: 'pC',
    title: 'Abbandono segnalato al numero verde, senza foto', // allow-italian: fixture data, shown as written
    detail: 'Capaccio Paestum · località Licinella · telefonata al numero verde', place: 'Capaccio Paestum', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '08:31'), 'agent:ag-segnalazioni'),
      entry('lavorazione', at('11-06', '08:40'), 'sarim-callcenter'),
    ],
    worker: personWorker('sarim-callcenter', "ha chiesto la foto all'utente con un SMS e aspetta la risposta", at('11-06', '08:52')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', priority: 'normale',
    blocked: { reason: "manca la foto: chiesta all'utente con un SMS", since: at('11-06', '08:52') }, // allow-italian: fixture data, shown as written
    originals: [
      paper('telefonata', 'Telefonata al numero verde', 'call', CALL_LINE, at('11-06', '08:29'), [ // allow-italian: fixture data, shown as written
        'Telefonata delle 08:27, durata 3 minuti, operatrice del call center', // allow-italian: fixture data, shown as written
        'Il cittadino segnala sacchi neri e un frigorifero lasciati vicino alla pineta, località Licinella.', // allow-italian: fixture data, shown as written
        'Non sa dire il numero civico; manderà una foto con la posizione.', // allow-italian: fixture data, shown as written
        'Richiamare allo stesso numero se servono dettagli.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Luogo', 'pineta di Licinella', 'telefonata', 'vicino alla pineta, località Licinella', 76), // allow-italian: fixture data, shown as written
      read('Rifiuti', 'sacchi neri, un frigorifero', 'telefonata', 'sacchi neri e un frigorifero', 90), // allow-italian: fixture data, shown as written
      read('Foto', 'promessa, non arrivata', 'telefonata', 'manderà una foto con la posizione', 88), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Appena arriva la foto: sopralluogo e rimozione con due mezzi, perché il frigorifero è un RAEE e va trasportato a parte.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-4127', flow: 'sarim-segnalazioni', step: 's4', lane: 'pB',
    title: 'Mancato ritiro della carta', // allow-italian: fixture data, shown as written
    detail: 'Castellabate · Santa Maria · portale utenze', place: 'Castellabate', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '09:12'), 'agent:ag-segnalazioni'),
      entry('lavorazione', at('11-06', '09:20'), 'agent:ag-segnalazioni'),
    ],
    worker: personWorker('sarim-callcenter', "richiama l'utente: nella segnalazione manca il numero civico", at('11-06', '10:05')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', priority: 'normale',
    originals: [
      paper('portale', 'Segnalazione 5512 dal portale utenze', 'form', 'portale utenze', at('11-06', '09:11'), [ // allow-italian: fixture data, shown as written
        'Portale utenze, segnalazione n. 5512', // allow-italian: fixture data, shown as written
        'Comune: Castellabate, frazione Santa Maria', // allow-italian: fixture data, shown as written
        'Indirizzo: Via Marina', // allow-italian: fixture data, shown as written
        'Tipo: mancato ritiro carta e cartone del giovedì', // allow-italian: fixture data, shown as written
        'Telefono per essere richiamati: indicato', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Comune', 'Castellabate, Santa Maria', 'portale', 'Comune: Castellabate, frazione Santa Maria', 98), // allow-italian: fixture data, shown as written
      read('Indirizzo', 'Via Marina, civico mancante', 'portale', 'Indirizzo: Via Marina', 70), // allow-italian: fixture data, shown as written
      read('Frazione', 'carta e cartone', 'portale', 'carta e cartone del giovedì', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Con il civico: recupero sabato 07/11 con il giro della carta di Santa Maria.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-4124', flow: 'sarim-segnalazioni', step: 's5', lane: 'pA',
    title: 'Ingombranti lasciati accanto ai contenitori', // allow-italian: fixture data, shown as written
    detail: 'Sarno · Via Matteotti 41 · telefonata al numero verde', place: 'Sarno', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '08:05'), 'agent:ag-segnalazioni'),
      entry('lavorazione', at('11-06', '08:11'), 'agent:ag-segnalazioni'),
      entry('verifica', at('11-06', '09:30'), 'agent:ag-segnalazioni'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-callcenter', 'verifica turno e mezzo proposti prima di confermare', at('11-06', '09:41')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', priority: 'normale',
    originals: [
      paper('telefonata', 'Telefonata al numero verde', 'call', CALL_LINE, at('11-06', '08:03'), [ // allow-italian: fixture data, shown as written
        'Telefonata delle 08:01, operatrice del call center', // allow-italian: fixture data, shown as written
        'Una signora segnala un divano e una lavatrice accanto ai contenitori stradali di Via Matteotti 41.', // allow-italian: fixture data, shown as written
        'Dice che sono lì da martedì e che bloccano il marciapiede.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Indirizzo', 'Via Matteotti 41, Sarno', 'telefonata', 'Via Matteotti 41', 95), // allow-italian: fixture data, shown as written
      read('Materiali', 'divano, lavatrice', 'telefonata', 'un divano e una lavatrice', 93), // allow-italian: fixture data, shown as written
      read('Da quando', 'martedì 03/11', 'telefonata', 'sono lì da martedì', 80), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Ritiro lunedì 09/11 mattina con il turno ingombranti di Sarno: costipatore e mezzo con sponda per la lavatrice.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-4130', flow: 'sarim-segnalazioni', step: 's5', lane: 'pE',
    title: 'Doppione: gli stessi ingombranti di Via Matteotti', // allow-italian: fixture data, shown as written
    detail: "Sarno · Via Matteotti 39 · mail di un'utente", place: 'Sarno', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '10:02'), 'agent:ag-segnalazioni'),
      entry('lavorazione', at('11-06', '10:03'), 'agent:ag-segnalazioni'),
      entry('verifica', at('11-06', '10:05'), 'agent:ag-segnalazioni'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-callcenter', 'verifica che sia la stessa segnalazione di SG-4124', at('11-06', '10:10')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', priority: 'bassa',
    originals: [
      paper('mail', "Mail di un'utente", 'mail', 'mail del servizio clienti', at('11-06', '10:01'), [ // allow-italian: fixture data, shown as written
        'Oggetto: rifiuti abbandonati in Via Matteotti', // allow-italian: fixture data, shown as written
        'Buongiorno, davanti al civico 39 di Via Matteotti ci sono un divano e una lavatrice vicino ai cassonetti.', // allow-italian: fixture data, shown as written
        'Potete passare a prenderli? Grazie.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Indirizzo', 'Via Matteotti 39, Sarno', 'mail', 'davanti al civico 39 di Via Matteotti', 94), // allow-italian: fixture data, shown as written
      read('Materiali', 'divano, lavatrice', 'mail', 'un divano e una lavatrice', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'È la stessa segnalazione di SG-4124, a 20 metri: collegarla e rispondere che il ritiro è già in programma lunedì 09/11.', // allow-italian: fixture data, shown as written
    links: { card: 'SG-4124' },
  },
  {
    id: 'SG-4119', flow: 'sarim-segnalazioni', step: 's5',
    title: 'Contenitore rotto da sostituire, utenza non domestica', // allow-italian: fixture data, shown as written
    detail: 'Roma, Municipio V · Via dei Castani 88 · segnalazione AMA 18391', place: 'Roma (AMA)', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '11:20'), 'agent:ag-segnalazioni'),
      entry('lavorazione', at('11-05', '11:24'), 'agent:ag-segnalazioni'),
      entry('verifica', at('11-05', '14:10'), 'agent:ag-segnalazioni'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-callcenter', 'deve confermare la consegna del contenitore nuovo', at('11-05', '14:10')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', priority: 'normale',
    originals: [
      paper('mail-ama', 'Mail AMA, segnalazione 18391', 'mail', 'mail AMA', at('11-05', '11:19'), [ // allow-italian: fixture data, shown as written
        'Oggetto: segnalazione n. 18391 del 05/11/2026, contenitore danneggiato', // allow-italian: fixture data, shown as written
        'Municipio V, Via dei Castani 88, utenza non domestica codice UND-05-02218 (ristorante).', // allow-italian: fixture data, shown as written
        'Il carrellato da 240 litri per il vetro ha una ruota rotta e il coperchio staccato.', // allow-italian: fixture data, shown as written
        'Si chiede la sostituzione al prossimo passaggio.', // allow-italian: fixture data, shown as written
        'AMA S.p.A., servizio utenze non domestiche', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Utenza', 'UND-05-02218, ristorante', 'mail-ama', 'codice UND-05-02218 (ristorante)', 96), // allow-italian: fixture data, shown as written
      read('Contenitore', 'carrellato 240 litri, vetro', 'mail-ama', 'Il carrellato da 240 litri per il vetro', 95), // allow-italian: fixture data, shown as written
      read('Danno', 'ruota rotta, coperchio staccato', 'mail-ama', 'una ruota rotta e il coperchio staccato', 92), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Consegna di un carrellato nuovo da 240 litri al passaggio del vetro di lunedì 09/11 e ritiro di quello rotto.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-4121', flow: 'sarim-segnalazioni', step: 's6',
    title: 'Pulizia straordinaria dopo una manifestazione', // allow-italian: fixture data, shown as written
    detail: 'Bellizzi · piazza e vie del centro · PEC del Comune', place: 'Bellizzi', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '07:50'), 'agent:ag-segnalazioni'),
      entry('lavorazione', at('11-05', '07:55'), 'agent:ag-segnalazioni'),
      entry('verifica', at('11-05', '08:20'), 'agent:ag-segnalazioni'), // allow-italian: stage id, compared by value
      entry('approvazione', at('11-05', '08:55'), 'sarim-callcenter'),
    ],
    worker: personWorker('sarim-tecnico', 'decide se fare la pulizia fuori giro domenica sera', at('11-05', '08:55')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-tecnico', due: '2026-11-08', priority: 'normale',
    originals: [
      paper('pec', 'PEC del Comune', 'mail', 'PEC del Comune', at('11-05', '07:48'), [ // allow-italian: fixture data, shown as written
        'Oggetto: richiesta di pulizia straordinaria, domenica 08/11/2026', // allow-italian: fixture data, shown as written
        'Per la manifestazione in piazza di domenica si chiede uno spazzamento straordinario a fine evento, dalle 20:00.', // allow-italian: fixture data, shown as written
        'Zona: piazza principale e le due vie che vi arrivano.', // allow-italian: fixture data, shown as written
        'Il servizio è fuori dal calendario ordinario.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Quando', 'domenica 08/11, dalle 20:00', 'pec', 'a fine evento, dalle 20:00', 93), // allow-italian: fixture data, shown as written
      read('Zona', 'piazza e due vie', 'pec', 'piazza principale e le due vie che vi arrivano', 87), // allow-italian: fixture data, shown as written
      read('Fuori giro', 'sì', 'pec', 'fuori dal calendario ordinario', 96), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Squadra di 2 operatori con spazzatrice piccola dalle 20:00 alle 23:00: è fuori giro, serve il sì del responsabile tecnico per gli straordinari.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-F10', flow: 'sarim-foglie', step: 's4',
    title: 'Rendiconto foglie di ottobre per AMA', // allow-italian: fixture data, shown as written
    detail: 'Roma, Smart Leaf · ottobre 2026 · 1.251 passaggi su 1.284', place: 'Roma (AMA, Smart Leaf)', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-02', '06:00'), 'agent:ag-segnalazioni'),
      entry('lavorazione', at('11-02', '06:05'), 'agent:ag-segnalazioni'),
      entry('verifica', at('11-04', '12:30'), 'agent:ag-segnalazioni'), // allow-italian: stage id, compared by value
      entry('approvazione', at('11-06', '09:15'), 'sarim-callcenter'),
    ],
    worker: personWorker('sarim-tecnico', "rilegge il rendiconto prima dell'invio ad AMA", at('11-06', '09:15')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-tecnico', due: '2026-11-10', priority: 'alta',
    originals: [
      paper('winwaste', 'Passaggi di ottobre da WinWaste', 'sheet', 'WinWaste', at('11-02', '06:00'), [ // allow-italian: fixture data, shown as written
        'WinWaste, servizio foglie Roma, dal 01/10/2026 al 31/10/2026', // allow-italian: fixture data, shown as written
        'Passaggi previsti: 1.284', // allow-italian: fixture data, shown as written
        'Passaggi registrati: 1.251', // allow-italian: fixture data, shown as written
        'Passaggi mancanti: 33, di cui 21 per la pioggia del 14 e 15/10', // allow-italian: fixture data, shown as written
        'Foglie raccolte: 412,6 tonnellate', // allow-italian: fixture data, shown as written
      ]),
      paper('rendiconto', 'Bozza del rendiconto di ottobre', 'sheet', "Excel, bozza dell'agente", at('11-04', '12:30'), [ // allow-italian: fixture data, shown as written
        'Rendiconto mensile del servizio di spazzamento foglie, ottobre 2026', // allow-italian: fixture data, shown as written
        'Passaggi eseguiti 1.251 su 1.284 previsti (97,4%)', // allow-italian: fixture data, shown as written
        'Recuperi fatti entro la settimana: 29 su 33', // allow-italian: fixture data, shown as written
        'Allegati: elenco delle strade per Municipio e foto dei recuperi', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Passaggi previsti', '1.284', 'winwaste', 'Passaggi previsti: 1.284', 99), // allow-italian: fixture data, shown as written
      read('Passaggi registrati', '1.251', 'winwaste', 'Passaggi registrati: 1.251', 99), // allow-italian: fixture data, shown as written
      read('Passaggi mancanti', '33, di cui 21 per pioggia', 'winwaste', 'Passaggi mancanti: 33, di cui 21 per la pioggia', 98), // allow-italian: fixture data, shown as written
      read('Recuperi', '29 su 33', 'rendiconto', 'Recuperi fatti entro la settimana: 29 su 33', 84), // allow-italian: fixture data, shown as written
      read('Foglie raccolte', '412,6 t', 'winwaste', 'Foglie raccolte: 412,6 tonnellate', 97), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Rendiconto pronto: 1.251 passaggi su 1.284, i 4 recuperi non fatti spiegati con la pioggia; da approvare e inviare ad AMA entro il 10/11.', // allow-italian: fixture data, shown as written
    links: { contract: 'c-smart-leaf', clause: 'art-8' },
  },
  {
    id: 'SG-F09', flow: 'sarim-foglie', step: 's5',
    title: 'Rendiconto foglie di settembre, riga doppia corretta', // allow-italian: fixture data, shown as written
    detail: 'Roma, Smart Leaf · settembre 2026 · correzione chiesta da AMA', place: 'Roma (AMA, Smart Leaf)', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-30', '11:40'), 'agent:ag-segnalazioni'),
      entry('lavorazione', at('10-30', '11:45'), 'agent:ag-segnalazioni'),
      entry('verifica', at('11-02', '10:00'), 'agent:ag-segnalazioni'), // allow-italian: stage id, compared by value
      entry('fatto', at('11-03', '09:20'), 'sarim-callcenter'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-callcenter', 'ha inviato ad AMA il rendiconto corretto', at('11-03', '09:20')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-tecnico', priority: 'normale',
    originals: [
      paper('mail-ama', 'Mail AMA sul rendiconto di settembre', 'mail', 'mail AMA', at('10-30', '11:38'), [ // allow-italian: fixture data, shown as written
        'Oggetto: rendiconto foglie di settembre, richiesta di correzione', // allow-italian: fixture data, shown as written
        'Le righe 214 e 215 riportano lo stesso passaggio due volte, Municipio XIII.', // allow-italian: fixture data, shown as written
        'Si chiede di inviare il rendiconto corretto.', // allow-italian: fixture data, shown as written
        'AMA S.p.A., servizio raccolta foglie', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Righe', '214 e 215', 'mail-ama', 'Le righe 214 e 215', 97), // allow-italian: fixture data, shown as written
      read('Municipio', 'XIII', 'mail-ama', 'Municipio XIII', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Togliere la riga 215, che ripete la 214, e rimandare ad AMA il rendiconto di settembre corretto.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-4118', flow: 'sarim-segnalazioni', step: 's7', lane: 'pB',
    title: 'Mancato ritiro del vetro, recuperato', // allow-italian: fixture data, shown as written
    detail: 'Montecorvino Rovella · Via Roma 7 · telefonata al numero verde', place: 'Montecorvino Rovella', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '08:40'), 'agent:ag-segnalazioni'),
      entry('lavorazione', at('11-05', '08:45'), 'agent:ag-segnalazioni'),
      entry('verifica', at('11-05', '09:30'), 'agent:ag-segnalazioni'), // allow-italian: stage id, compared by value
      entry('fatto', at('11-05', '15:10'), 'agent:ag-segnalazioni'), // allow-italian: stage id, compared by value
    ],
    worker: agentWorker('ag-segnalazioni', "ha aperto l'ordine di servizio in SAP dopo la conferma del call center", at('11-05', '15:10')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', priority: 'normale',
    originals: [
      paper('telefonata', 'Telefonata al numero verde', 'call', CALL_LINE, at('11-05', '08:38'), [ // allow-italian: fixture data, shown as written
        'Telefonata delle 08:36, operatrice del call center', // allow-italian: fixture data, shown as written
        'Il mastello del vetro di Via Roma 7 non è stato svuotato mercoledì.', // allow-italian: fixture data, shown as written
        "L'utente chiede il recupero prima del fine settimana.", // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Indirizzo', 'Via Roma 7', 'telefonata', 'Via Roma 7', 96), // allow-italian: fixture data, shown as written
      read('Frazione', 'vetro', 'telefonata', 'Il mastello del vetro', 95), // allow-italian: fixture data, shown as written
      read('Giro saltato', 'mercoledì 04/11', 'telefonata', 'non è stato svuotato mercoledì', 88), // allow-italian: fixture data, shown as written
    ],
    proposal: "Recupero giovedì 05/11 pomeriggio con il giro del vetro, SMS all'utente con l'ora.", // allow-italian: fixture data, shown as written
  },
];

/* ---------- FIR e RENTRI (8) ---------- */

const FORMS: SarimCard[] = [
  {
    id: 'FIR-0941', flow: 'sarim-fir', step: 's1',
    title: 'Formulario organico di Castellabate', // allow-italian: fixture data, shown as written
    detail: 'Castellabate · EER 20 01 08 · compattatore FX 218 KP', place: 'Castellabate', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '10:08'), 'agent:ag-fir')],
    worker: agentWorker('ag-fir', 'legge il formulario: codice EER, pesi, targa e destinatario', at('11-06', '10:08')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', priority: 'normale',
    originals: [
      paper('fir', 'FIR n. SRM 004521/26', 'form', "Enviro, foto dell'autista", at('11-06', '10:07'), [ // allow-italian: fixture data, shown as written
        'Formulario di identificazione del rifiuto n. SRM 004521/26', // allow-italian: fixture data, shown as written
        'Produttore: Comune di Castellabate, rifiuti urbani da raccolta differenziata', // allow-italian: fixture data, shown as written
        CARRIER,
        'Destinatario: Impianto di compostaggio (esempio)', // allow-italian: fixture data, shown as written
        'Codice EER 20 01 08, rifiuti biodegradabili di cucine e mense', // allow-italian: fixture data, shown as written
        'Quantità alla partenza: 6.850 kg (stima)', // allow-italian: fixture data, shown as written
        'Mezzo: compattatore targa FX 218 KP, inizio trasporto 06/11/2026 ore 07:15', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Codice EER', '20 01 08', 'fir', 'Codice EER 20 01 08', 98), // allow-italian: fixture data, shown as written
      read('Quantità stimata', '6.850 kg', 'fir', 'Quantità alla partenza: 6.850 kg', 92), // allow-italian: fixture data, shown as written
      read('Targa', 'FX 218 KP', 'fir', 'targa FX 218 KP', 89), // allow-italian: fixture data, shown as written
      read('Destinatario', 'Impianto di compostaggio', 'fir', 'Destinatario: Impianto di compostaggio', 97), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Formulario completo: manca solo il peso a destino per preparare la registrazione.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'FIR-0938', flow: 'sarim-fir', step: 's4',
    title: 'Peso a destino più alto della stima', // allow-italian: fixture data, shown as written
    detail: 'Sarno · EER 20 03 01 · 8.420 kg contro 7.900 stimati', place: 'Sarno', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '09:05'), 'agent:ag-fir'),
      entry('lavorazione', at('11-06', '09:12'), 'agent:ag-fir'),
    ],
    worker: agentWorker('ag-fir', 'prepara la registrazione con il peso a destino e segna la differenza del 6,6%', at('11-06', '09:12')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', priority: 'normale',
    originals: [
      paper('fir', 'FIR n. SRM 004509/26', 'form', 'Enviro', at('11-06', '09:04'), [ // allow-italian: fixture data, shown as written
        'Formulario di identificazione del rifiuto n. SRM 004509/26', // allow-italian: fixture data, shown as written
        'Produttore: Comune di Sarno, rifiuti urbani', // allow-italian: fixture data, shown as written
        CARRIER,
        'Destinatario: Impianto di trattamento meccanico biologico (esempio)', // allow-italian: fixture data, shown as written
        'Codice EER 20 03 01, rifiuti urbani non differenziati', // allow-italian: fixture data, shown as written
        'Quantità alla partenza: 7.900 kg (stima)', // allow-italian: fixture data, shown as written
        'Peso verificato a destino: 8.420 kg', // allow-italian: fixture data, shown as written
        'Mezzo: compattatore targa GB 506 TL, inizio trasporto 05/11/2026 ore 13:20', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Codice EER', '20 03 01', 'fir', 'Codice EER 20 03 01', 98), // allow-italian: fixture data, shown as written
      read('Quantità stimata', '7.900 kg', 'fir', 'Quantità alla partenza: 7.900 kg', 95), // allow-italian: fixture data, shown as written
      read('Peso a destino', '8.420 kg', 'fir', 'Peso verificato a destino: 8.420 kg', 96), // allow-italian: fixture data, shown as written
      read('Targa', 'GB 506 TL', 'fir', 'targa GB 506 TL', 90), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Registrare 8.420 kg, il peso a destino, e annotare la differenza del 6,6% rispetto alla stima.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'FIR-0936', flow: 'sarim-fir', step: 's2',
    title: 'Manca il peso verificato a destino', // allow-italian: fixture data, shown as written
    detail: 'Rocca Priora · EER 15 01 07 · vetro', place: 'Rocca Priora', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-04', '16:30'), 'agent:ag-fir'),
      entry('lavorazione', at('11-04', '16:40'), 'agent:ag-fir'),
    ],
    worker: personWorker('sarim-callcenter', "ha chiesto all'impianto la copia con il peso", at('11-05', '09:10')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', due: '2026-11-18', priority: 'alta',
    blocked: { reason: "manca il peso a destino: l'impianto non ha ancora rimandato la copia", since: at('11-05', '09:10') }, // allow-italian: fixture data, shown as written
    originals: [
      paper('fir', 'FIR n. SRM 004488/26', 'form', 'Enviro', at('11-04', '16:29'), [ // allow-italian: fixture data, shown as written
        'Formulario di identificazione del rifiuto n. SRM 004488/26', // allow-italian: fixture data, shown as written
        'Produttore: Comune di Rocca Priora, raccolta differenziata del vetro', // allow-italian: fixture data, shown as written
        CARRIER,
        'Destinatario: Piattaforma di selezione del vetro (esempio)', // allow-italian: fixture data, shown as written
        'Codice EER 15 01 07, imballaggi di vetro', // allow-italian: fixture data, shown as written
        'Quantità alla partenza: 4.300 kg (stima)', // allow-italian: fixture data, shown as written
        'Peso verificato a destino: (vuoto)', // allow-italian: fixture data, shown as written
        'Mezzo: autocarro con gru targa FT 744 ZC, inizio trasporto 04/11/2026 ore 11:05', // allow-italian: fixture data, shown as written
      ]),
      paper('mail', "Mail all'impianto", 'mail', 'posta del customer service', at('11-05', '09:10'), [ // allow-italian: fixture data, shown as written
        'Buongiorno, ci mandate la copia del formulario SRM 004488/26 con il peso verificato?', // allow-italian: fixture data, shown as written
        'Ci serve per la registrazione. Grazie, customer service S.A.R.I.M.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Codice EER', '15 01 07', 'fir', 'Codice EER 15 01 07', 98), // allow-italian: fixture data, shown as written
      read('Quantità stimata', '4.300 kg', 'fir', 'Quantità alla partenza: 4.300 kg', 94), // allow-italian: fixture data, shown as written
      read('Peso a destino', 'mancante', 'fir', 'Peso verificato a destino: (vuoto)', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: "Appena l'impianto manda il peso: registrazione con quel peso, entro il 18/11.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'FIR-0939', flow: 'sarim-fir', step: 's5',
    title: 'Formulario carta e cartone di Agropoli', // allow-italian: fixture data, shown as written
    detail: 'Agropoli · EER 20 01 01 · 5.140 kg', place: 'Agropoli', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '15:10'), 'agent:ag-fir'),
      entry('lavorazione', at('11-05', '15:15'), 'agent:ag-fir'),
      entry('verifica', at('11-06', '08:40'), 'agent:ag-fir'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-callcenter', 'verifica codice e pesi prima della firma', at('11-06', '09:05')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', priority: 'normale',
    originals: [
      paper('fir', 'FIR n. SRM 004514/26', 'form', "Enviro, foto dell'autista", at('11-05', '15:09'), [ // allow-italian: fixture data, shown as written
        'Formulario di identificazione del rifiuto n. SRM 004514/26', // allow-italian: fixture data, shown as written
        'Produttore: Comune di Agropoli, raccolta differenziata', // allow-italian: fixture data, shown as written
        CARRIER,
        'Destinatario: Piattaforma di selezione della carta (esempio)', // allow-italian: fixture data, shown as written
        'Codice EER 20 01 01, carta e cartone', // allow-italian: fixture data, shown as written
        'Quantità alla partenza: 5.000 kg (stima)', // allow-italian: fixture data, shown as written
        'Peso verificato a destino: 5.140 kg', // allow-italian: fixture data, shown as written
        'Mezzo: compattatore targa FX 221 KP, inizio trasporto 05/11/2026 ore 12:40', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Codice EER', '20 01 01', 'fir', 'Codice EER 20 01 01', 98), // allow-italian: fixture data, shown as written
      read('Peso a destino', '5.140 kg', 'fir', 'Peso verificato a destino: 5.140 kg', 97), // allow-italian: fixture data, shown as written
      read('Targa', 'FX 221 KP', 'fir', 'targa FX 221 KP', 64), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Registrazione pronta con 5.140 kg; la targa si legge male nella foto, controllarla sul foglio targa.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'FIR-0935', flow: 'sarim-fir', step: 's5',
    title: 'Foglie con terra: quale codice EER', // allow-italian: fixture data, shown as written
    detail: 'Roma, Smart Leaf · EER 20 03 03 · 2.960 kg', place: 'Roma (AMA, Smart Leaf)', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-03', '18:20'), 'agent:ag-fir'),
      entry('lavorazione', at('11-03', '18:25'), 'agent:ag-fir'),
      entry('verifica', at('11-05', '15:00'), 'agent:ag-fir'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-callcenter', 'deve decidere se il codice EER va bene per foglie miste a terra', at('11-05', '15:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-callcenter', priority: 'alta',
    originals: [
      paper('fir', 'FIR n. SRM 004476/26', 'form', 'Enviro', at('11-03', '18:19'), [ // allow-italian: fixture data, shown as written
        'Formulario di identificazione del rifiuto n. SRM 004476/26', // allow-italian: fixture data, shown as written
        'Produttore: servizio foglie di Roma, squadra del Municipio XII', // allow-italian: fixture data, shown as written
        CARRIER,
        'Destinatario: Impianto di compostaggio (esempio)', // allow-italian: fixture data, shown as written
        'Codice EER 20 03 03, residui della pulizia stradale', // allow-italian: fixture data, shown as written
        "Note dell'autista: foglie con molta terra", // allow-italian: fixture data, shown as written
        'Peso verificato a destino: 2.960 kg', // allow-italian: fixture data, shown as written
        'Mezzo: autocarro con vasca targa GC 902 BR, inizio trasporto 03/11/2026 ore 14:10', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Codice EER', '20 03 03', 'fir', 'Codice EER 20 03 03', 82), // allow-italian: fixture data, shown as written
      read("Note dell'autista", 'foglie con molta terra', 'fir', 'foglie con molta terra', 90), // allow-italian: fixture data, shown as written
      read('Peso a destino', '2.960 kg', 'fir', 'Peso verificato a destino: 2.960 kg', 97), // allow-italian: fixture data, shown as written
    ],
    proposal: "Il 20 03 03 va bene per foglie con terra; se l'impianto le ha accettate come verde serve il 20 02 01: chiederlo all'impianto prima di registrare.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'FIR-0933', flow: 'sarim-fir', step: 's6',
    title: 'Ingombranti di Pontecagnano Faiano', // allow-italian: fixture data, shown as written
    detail: 'Pontecagnano Faiano · EER 20 03 07 · 2.380 kg', place: 'Pontecagnano Faiano', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '12:10'), 'agent:ag-fir'),
      entry('lavorazione', at('11-05', '12:15'), 'agent:ag-fir'),
      entry('verifica', at('11-05', '16:00'), 'agent:ag-fir'), // allow-italian: stage id, compared by value
      entry('approvazione', at('11-06', '09:50'), 'sarim-callcenter'),
    ],
    worker: personWorker('sarim-tecnico', 'deve firmare la registrazione', at('11-06', '09:50')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-tecnico', priority: 'normale',
    originals: [
      paper('fir', 'FIR n. SRM 004511/26', 'form', 'Enviro', at('11-05', '12:09'), [ // allow-italian: fixture data, shown as written
        'Formulario di identificazione del rifiuto n. SRM 004511/26', // allow-italian: fixture data, shown as written
        'Produttore: Comune di Pontecagnano Faiano, ritiro ingombranti a domicilio', // allow-italian: fixture data, shown as written
        CARRIER,
        'Destinatario: Impianto di recupero ingombranti (esempio)', // allow-italian: fixture data, shown as written
        'Codice EER 20 03 07, rifiuti ingombranti', // allow-italian: fixture data, shown as written
        'Quantità alla partenza: 2.300 kg (stima)', // allow-italian: fixture data, shown as written
        'Peso verificato a destino: 2.380 kg', // allow-italian: fixture data, shown as written
        'Mezzo: costipatore targa FY 330 LN, inizio trasporto 05/11/2026 ore 10:30', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Codice EER', '20 03 07', 'fir', 'Codice EER 20 03 07', 99), // allow-italian: fixture data, shown as written
      read('Peso a destino', '2.380 kg', 'fir', 'Peso verificato a destino: 2.380 kg', 98), // allow-italian: fixture data, shown as written
      read('Targa', 'FY 330 LN', 'fir', 'targa FY 330 LN', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Registrazione di carico e scarico pronta con 2.380 kg: da firmare.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'FIR-0931', flow: 'sarim-fir', step: 's7',
    title: 'Organico di Capaccio Paestum, registrato', // allow-italian: fixture data, shown as written
    detail: 'Capaccio Paestum · EER 20 01 08 · 9.120 kg', place: 'Capaccio Paestum', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-04', '09:30'), 'agent:ag-fir'),
      entry('lavorazione', at('11-04', '09:35'), 'agent:ag-fir'),
      entry('verifica', at('11-04', '14:00'), 'agent:ag-fir'), // allow-italian: stage id, compared by value
      entry('approvazione', at('11-05', '10:00'), 'sarim-callcenter'),
      entry('fatto', at('11-05', '17:20'), 'agent:ag-fir'), // allow-italian: stage id, compared by value
    ],
    worker: agentWorker('ag-fir', 'ha trasmesso a RENTRI la registrazione firmata', at('11-05', '17:20')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-tecnico', priority: 'normale',
    originals: [
      paper('fir', 'FIR n. SRM 004495/26', 'form', 'Enviro', at('11-04', '09:29'), [ // allow-italian: fixture data, shown as written
        'Formulario di identificazione del rifiuto n. SRM 004495/26', // allow-italian: fixture data, shown as written
        'Produttore: Comune di Capaccio Paestum, rifiuti urbani da raccolta differenziata', // allow-italian: fixture data, shown as written
        CARRIER,
        'Destinatario: Impianto di compostaggio (esempio)', // allow-italian: fixture data, shown as written
        'Codice EER 20 01 08, rifiuti biodegradabili di cucine e mense', // allow-italian: fixture data, shown as written
        'Peso verificato a destino: 9.120 kg', // allow-italian: fixture data, shown as written
        'Mezzo: compattatore targa GA 117 MS, inizio trasporto 04/11/2026 ore 06:50', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Codice EER', '20 01 08', 'fir', 'Codice EER 20 01 08', 99), // allow-italian: fixture data, shown as written
      read('Peso a destino', '9.120 kg', 'fir', 'Peso verificato a destino: 9.120 kg', 98), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Registrazione firmata dal responsabile tecnico e trasmessa a RENTRI il 05/11.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'FIR-0929', flow: 'sarim-fir', step: 's7',
    title: 'Multimateriale di Serre, registrato', // allow-italian: fixture data, shown as written
    detail: 'Serre · EER 15 01 06 · 1.760 kg', place: 'Serre', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-02', '11:00'), 'agent:ag-fir'),
      entry('lavorazione', at('11-02', '11:05'), 'agent:ag-fir'),
      entry('verifica', at('11-02', '15:30'), 'agent:ag-fir'), // allow-italian: stage id, compared by value
      entry('approvazione', at('11-03', '09:00'), 'sarim-callcenter'),
      entry('fatto', at('11-03', '16:40'), 'sarim-tecnico'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-tecnico', 'ha firmato e chiuso la registrazione', at('11-03', '16:40')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-tecnico', priority: 'normale',
    originals: [
      paper('fir', 'FIR n. SRM 004470/26', 'form', 'Enviro', at('11-02', '10:59'), [ // allow-italian: fixture data, shown as written
        'Formulario di identificazione del rifiuto n. SRM 004470/26', // allow-italian: fixture data, shown as written
        'Produttore: Comune di Serre, raccolta differenziata', // allow-italian: fixture data, shown as written
        CARRIER,
        'Destinatario: Piattaforma di selezione multimateriale (esempio)', // allow-italian: fixture data, shown as written
        'Codice EER 15 01 06, imballaggi in materiali misti', // allow-italian: fixture data, shown as written
        'Peso verificato a destino: 1.760 kg', // allow-italian: fixture data, shown as written
        'Mezzo: costipatore targa FW 605 HG, inizio trasporto 02/11/2026 ore 08:20', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Codice EER', '15 01 06', 'fir', 'Codice EER 15 01 06', 99), // allow-italian: fixture data, shown as written
      read('Peso a destino', '1.760 kg', 'fir', 'Peso verificato a destino: 1.760 kg', 98), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Registrazione di carico e scarico fatta con 1.760 kg.', // allow-italian: fixture data, shown as written
  },
];

/* ---------- fatture passive (10): imponibile + IVA 22% = totale on every one ---------- */

const INVOICES: SarimCard[] = [
  {
    id: 'FT-2615', flow: 'sarim-fatture', step: 's1',
    title: 'Pneumatici per i compattatori', // allow-italian: fixture data, shown as written
    detail: 'Fornitore pneumatici (esempio) · 4.245,60 euro', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '10:01'), 'agent:ag-fatture')],
    worker: agentWorker('ag-fatture', 'legge righe, imponibile e IVA della fattura', at('11-06', '10:01')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-contabilita', due: '2026-12-05', priority: 'normale',
    originals: [
      paper('fattura', 'Fattura 1092/2026', 'invoice', 'SDI', at('11-06', '10:00'), [ // allow-italian: fixture data, shown as written
        'FatturaPA, tipo documento TD01, numero 1092/2026, data 2026-11-05', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: Fornitore pneumatici (esempio)', // allow-italian: fixture data, shown as written
        BUYER,
        'Riga 1: pneumatici 315/80 R22.5, 8 pezzi x 410,00 = 3.280,00', // allow-italian: fixture data, shown as written
        'Riga 2: montaggio ed equilibratura, 8 x 25,00 = 200,00', // allow-italian: fixture data, shown as written
        'Imponibile 3.480,00, IVA 22% 765,60, totale documento 4.245,60', // allow-italian: fixture data, shown as written
        'Riferimento ordine: 2026/0402 del 27/10/2026', // allow-italian: fixture data, shown as written
        'Scadenza pagamento: 05/12/2026', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Imponibile', '3.480,00 euro', 'fattura', 'Imponibile 3.480,00', 99), // allow-italian: fixture data, shown as written
      read('IVA', '765,60 euro', 'fattura', 'IVA 22% 765,60', 99),
      read('Totale', '4.245,60 euro', 'fattura', 'totale documento 4.245,60', 99), // allow-italian: fixture data, shown as written
      read('Ordine', '2026/0402', 'fattura', 'Riferimento ordine: 2026/0402', 96), // allow-italian: fixture data, shown as written
    ],
    proposal: "Fattura con l'ordine 2026/0402: abbinarla alla bolla di consegna dell'officina.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'FT-2616', flow: 'sarim-fatture', step: 's1',
    title: 'Energia elettrica di ottobre, sede di Eboli', // allow-italian: fixture data, shown as written
    detail: 'Fornitore energia elettrica (esempio) · 7.493,85 euro', place: 'Eboli', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '09:20'), 'agent:ag-fatture')],
    worker: agentWorker('ag-fatture', 'legge consumi e importi della bolletta', at('11-06', '09:21')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-contabilita', due: '2026-11-24', priority: 'normale',
    originals: [
      paper('fattura', 'Fattura E-2026-118422', 'invoice', 'SDI', at('11-06', '09:19'), [ // allow-italian: fixture data, shown as written
        'FatturaPA, tipo documento TD01, numero E-2026-118422, data 2026-11-04', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: Fornitore energia elettrica (esempio)', // allow-italian: fixture data, shown as written
        BUYER,
        'Fornitura: Eboli, Via Maestri del Lavoro, Area PIP, uffici, deposito e officina', // allow-italian: fixture data, shown as written
        'Periodo: dal 01/10/2026 al 31/10/2026, consumo 28.400 kWh', // allow-italian: fixture data, shown as written
        'Imponibile 6.142,50, IVA 22% 1.351,35, totale documento 7.493,85', // allow-italian: fixture data, shown as written
        'Scadenza pagamento: 24/11/2026', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Imponibile', '6.142,50 euro', 'fattura', 'Imponibile 6.142,50', 99), // allow-italian: fixture data, shown as written
      read('IVA', '1.351,35 euro', 'fattura', 'IVA 22% 1.351,35', 99),
      read('Totale', '7.493,85 euro', 'fattura', 'totale documento 7.493,85', 99), // allow-italian: fixture data, shown as written
      read('Consumo', '28.400 kWh', 'fattura', 'consumo 28.400 kWh', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: "Bolletta di ottobre con consumi vicini a quelli di settembre: da abbinare all'addebito in banca del 24/11.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'FT-2612', flow: 'sarim-fatture', step: 's2',
    title: 'Sacchetti compostabili per il porta a porta', // allow-italian: fixture data, shown as written
    detail: 'Fornitore sacchetti (esempio) · 6.588,00 euro', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '14:20'), 'agent:ag-fatture'),
      entry('lavorazione', at('11-05', '14:25'), 'agent:ag-fatture'),
    ],
    worker: agentWorker('ag-fatture', "abbina fattura, ordine 2026/0388 e bolla di consegna", at('11-06', '10:12')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-contabilita', due: '2026-12-31', priority: 'normale',
    originals: [
      paper('fattura', 'Fattura 774/2026', 'invoice', 'SDI', at('11-05', '14:19'), [ // allow-italian: fixture data, shown as written
        'FatturaPA, tipo documento TD01, numero 774/2026, data 2026-11-03', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: Fornitore sacchetti (esempio)', // allow-italian: fixture data, shown as written
        BUYER,
        'Riga 1: sacchetti compostabili 10 litri, 120.000 pezzi x 0,0450 = 5.400,00', // allow-italian: fixture data, shown as written
        'Imponibile 5.400,00, IVA 22% 1.188,00, totale documento 6.588,00', // allow-italian: fixture data, shown as written
        'Riferimento ordine: 2026/0388 del 12/10/2026, DDT 1417 del 22/10/2026', // allow-italian: fixture data, shown as written
        'Scadenza pagamento: 31/12/2026', // allow-italian: fixture data, shown as written
      ]),
      paper('ddt', 'DDT 1417 del 22/10', 'form', 'magazzino di Eboli', at('10-22', '11:30'), [ // allow-italian: fixture data, shown as written
        'Documento di trasporto n. 1417 del 22/10/2026', // allow-italian: fixture data, shown as written
        'Destinazione: magazzino di Eboli, Via Maestri del Lavoro', // allow-italian: fixture data, shown as written
        'Merce: sacchetti compostabili 10 litri, 120.000 pezzi su 6 bancali', // allow-italian: fixture data, shown as written
        'Ricevuto dal magazziniere, firma leggibile', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Imponibile', '5.400,00 euro', 'fattura', 'Imponibile 5.400,00', 99), // allow-italian: fixture data, shown as written
      read('IVA', '1.188,00 euro', 'fattura', 'IVA 22% 1.188,00', 99),
      read('Totale', '6.588,00 euro', 'fattura', 'totale documento 6.588,00', 99), // allow-italian: fixture data, shown as written
      read('Quantità consegnata', '120.000 pezzi', 'ddt', '120.000 pezzi su 6 bancali', 93), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Fattura, ordine e bolla tornano: 120.000 sacchetti a 0,045 euro, pronta per il controllo della contabilità.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'FT-2613', flow: 'sarim-fatture', step: 's3',
    title: 'Noleggio cassoni scarrabili di ottobre', // allow-italian: fixture data, shown as written
    detail: 'Noleggio cassoni (esempio) · 1.474,98 euro · Castellabate', place: 'Castellabate', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '08:10'), 'agent:ag-fatture'),
      entry('lavorazione', at('11-06', '08:12'), 'agent:ag-fatture'),
    ],
    worker: agentWorker('ag-fatture', 'conta i giorni di noleggio sul foglio del cantiere di Castellabate', at('11-06', '08:12')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-contabilita', due: '2026-12-02', priority: 'normale',
    originals: [
      paper('fattura', 'Fattura 210/2026', 'invoice', 'SDI', at('11-06', '08:09'), [ // allow-italian: fixture data, shown as written
        'FatturaPA, tipo documento TD01, numero 210/2026, data 2026-11-02', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: Noleggio cassoni (esempio)', // allow-italian: fixture data, shown as written
        BUYER,
        'Riga 1: noleggio cassoni scarrabili 30 m³, 6 cassoni x 31 giorni x 6,50 = 1.209,00', // allow-italian: fixture data, shown as written
        'Cantiere: Castellabate, isola ecologica', // allow-italian: fixture data, shown as written
        'Imponibile 1.209,00, IVA 22% 265,98, totale documento 1.474,98', // allow-italian: fixture data, shown as written
        'Scadenza pagamento: 02/12/2026', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Imponibile', '1.209,00 euro', 'fattura', 'Imponibile 1.209,00', 99), // allow-italian: fixture data, shown as written
      read('IVA', '265,98 euro', 'fattura', 'IVA 22% 265,98', 99),
      read('Totale', '1.474,98 euro', 'fattura', 'totale documento 1.474,98', 99), // allow-italian: fixture data, shown as written
      read('Giorni fatturati', '6 cassoni per 31 giorni', 'fattura', '6 cassoni x 31 giorni', 90), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Controllare sul foglio del cantiere se i 6 cassoni sono rimasti tutti i 31 giorni: uno risulta ritirato il 26/10.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'FT-2609', flow: 'sarim-fatture', step: 's4',
    title: 'Fattura ricambi senza ordine', // allow-italian: fixture data, shown as written
    detail: 'Fornitore ricambi (esempio) · 1.508,53 euro', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-03', '08:40'), 'agent:ag-fatture'),
      entry('lavorazione', at('11-03', '08:45'), 'agent:ag-fatture'),
    ],
    worker: personWorker('sarim-contabilita', 'ha chiesto alla Flotta chi ha ordinato i ricambi', at('11-03', '09:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-contabilita', priority: 'normale',
    blocked: { reason: "fattura senza ordine: chiesto alla Flotta il numero d'ordine", since: at('11-03', '09:00') }, // allow-italian: fixture data, shown as written
    originals: [
      paper('fattura', 'Fattura 1511/2026', 'invoice', 'SDI', at('11-03', '08:39'), [ // allow-italian: fixture data, shown as written
        'FatturaPA, tipo documento TD01, numero 1511/2026, data 2026-10-31', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: Fornitore ricambi (esempio)', // allow-italian: fixture data, shown as written
        BUYER,
        'Riga 1: filtri olio e gasolio per compattatori, 30 pezzi = 742,50', // allow-italian: fixture data, shown as written
        'Riga 2: cinghie e tubi idraulici = 494,00', // allow-italian: fixture data, shown as written
        'Imponibile 1.236,50, IVA 22% 272,03, totale documento 1.508,53', // allow-italian: fixture data, shown as written
        'Riferimento ordine: non indicato', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Imponibile', '1.236,50 euro', 'fattura', 'Imponibile 1.236,50', 99), // allow-italian: fixture data, shown as written
      read('IVA', '272,03 euro', 'fattura', 'IVA 22% 272,03', 99),
      read('Totale', '1.508,53 euro', 'fattura', 'totale documento 1.508,53', 99), // allow-italian: fixture data, shown as written
      read('Ordine', 'non indicato', 'fattura', 'Riferimento ordine: non indicato', 98), // allow-italian: fixture data, shown as written
    ],
    proposal: "Senza ordine la fattura non si paga: se la Flotta indica l'ordine si abbina, altrimenti si chiede al fornitore una nota di credito.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'FT-2611', flow: 'sarim-fatture', step: 's5',
    title: 'Gasolio di ottobre sopra il prezzo di contratto', // allow-italian: fixture data, shown as written
    detail: 'Fornitore carburanti (esempio) · 31.007,52 euro · 18.000 litri', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-04', '09:10'), 'agent:ag-fatture'),
      entry('lavorazione', at('11-04', '09:12'), 'agent:ag-fatture'),
      entry('verifica', at('11-05', '15:00'), 'agent:ag-fatture'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-contabilita', "confronta il prezzo al litro con la formula dell'art. 5 del contratto", at('11-06', '09:30')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-contabilita', due: '2026-11-30', priority: 'alta',
    originals: [
      paper('fattura', 'Fattura 2026/0417', 'invoice', 'SDI', at('11-04', '09:09'), [ // allow-italian: fixture data, shown as written
        'FatturaPA, tipo documento TD01, numero 2026/0417, data 2026-10-31', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: Fornitore carburanti (esempio)', // allow-italian: fixture data, shown as written
        BUYER,
        'Riga 1: gasolio autotrazione, consegna del 07/10/2026 al deposito di Eboli, 9.000 litri x 1,4120 = 12.708,00', // allow-italian: fixture data, shown as written
        'Riga 2: gasolio autotrazione, consegna del 21/10/2026 al deposito di Eboli, 9.000 litri x 1,4120 = 12.708,00', // allow-italian: fixture data, shown as written
        'Totale litri consegnati: 18.000', // allow-italian: fixture data, shown as written
        'Imponibile 25.416,00, IVA 22% 5.591,52, totale documento 31.007,52', // allow-italian: fixture data, shown as written
        'Riferimento: accordo quadro gasolio', // allow-italian: fixture data, shown as written
        'Scadenza pagamento: 30/11/2026', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Imponibile', '25.416,00 euro', 'fattura', 'Imponibile 25.416,00', 99), // allow-italian: fixture data, shown as written
      read('IVA', '5.591,52 euro', 'fattura', 'IVA 22% 5.591,52', 99),
      read('Totale', '31.007,52 euro', 'fattura', 'totale documento 31.007,52', 99), // allow-italian: fixture data, shown as written
      read('Prezzo al litro', '1,4120 euro', 'fattura', '9.000 litri x 1,4120', 97), // allow-italian: fixture data, shown as written
      read('Litri', '18.000', 'fattura', 'Totale litri consegnati: 18.000', 98), // allow-italian: fixture data, shown as written
    ],
    proposal: "Il prezzo fatturato, 1,4120 euro al litro, è sopra quello che dà la formula dell'art. 5 del contratto gasolio: contestare la differenza e chiedere una nota di credito prima di pagare.", // allow-italian: fixture data, shown as written
    links: { contract: 'c-carburante', clause: 'art-5' },
  },
  {
    id: 'FT-2607', flow: 'sarim-fatture', step: 's5',
    title: 'Contenitori: la bolla dice 380 mastelli, la fattura 400', // allow-italian: fixture data, shown as written
    detail: 'Fornitore contenitori (esempio) · 5.636,40 euro', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-02', '10:00'), 'agent:ag-fatture'),
      entry('lavorazione', at('11-02', '10:05'), 'agent:ag-fatture'),
      entry('verifica', at('11-02', '16:00'), 'agent:ag-fatture'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-contabilita', 'deve decidere se pagare 380 mastelli o aspettare gli altri 20', at('11-02', '16:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-contabilita', due: '2026-11-29', priority: 'normale',
    originals: [
      paper('fattura', 'Fattura 655/2026', 'invoice', 'SDI', at('11-02', '09:59'), [ // allow-italian: fixture data, shown as written
        'FatturaPA, tipo documento TD01, numero 655/2026, data 2026-10-30', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: Fornitore contenitori (esempio)', // allow-italian: fixture data, shown as written
        BUYER,
        'Riga 1: mastelli 40 litri con chiusura, 400 pezzi x 6,80 = 2.720,00', // allow-italian: fixture data, shown as written
        'Riga 2: carrellati 240 litri, 50 pezzi x 38,00 = 1.900,00', // allow-italian: fixture data, shown as written
        'Imponibile 4.620,00, IVA 22% 1.016,40, totale documento 5.636,40', // allow-italian: fixture data, shown as written
        'Riferimento ordine: 2026/0371 del 05/10/2026', // allow-italian: fixture data, shown as written
        'Scadenza pagamento: 29/11/2026', // allow-italian: fixture data, shown as written
      ]),
      paper('ddt', 'DDT 902 del 28/10', 'form', 'deposito di Eboli', at('10-28', '12:15'), [ // allow-italian: fixture data, shown as written
        'Documento di trasporto n. 902 del 28/10/2026', // allow-italian: fixture data, shown as written
        'Destinazione: deposito di Eboli', // allow-italian: fixture data, shown as written
        'Merce: mastelli 40 litri, 380 pezzi; carrellati 240 litri, 50 pezzi', // allow-italian: fixture data, shown as written
        'Annotazione: 20 mastelli in consegna successiva', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Imponibile', '4.620,00 euro', 'fattura', 'Imponibile 4.620,00', 99), // allow-italian: fixture data, shown as written
      read('IVA', '1.016,40 euro', 'fattura', 'IVA 22% 1.016,40', 99),
      read('Totale', '5.636,40 euro', 'fattura', 'totale documento 5.636,40', 99), // allow-italian: fixture data, shown as written
      read('Mastelli fatturati', '400', 'fattura', 'mastelli 40 litri con chiusura, 400 pezzi', 97), // allow-italian: fixture data, shown as written
      read('Mastelli consegnati', '380', 'ddt', 'mastelli 40 litri, 380 pezzi', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Pagare 380 mastelli (2.584,00 euro di riga) e chiedere una nota di credito per i 20 non consegnati, oppure aspettare la seconda consegna.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'FT-2604', flow: 'sarim-fatture', step: 's6',
    title: 'Riparazione del compattatore riconsegnato in ritardo', // allow-italian: fixture data, shown as written
    detail: 'Officina veicoli industriali (esempio) · 5.011,76 euro · mezzo FZ 318 KD', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-02', '09:30'), 'agent:ag-fatture'),
      entry('lavorazione', at('11-02', '09:35'), 'agent:ag-fatture'),
      entry('verifica', at('11-03', '11:00'), 'agent:ag-fatture'), // allow-italian: stage id, compared by value
      entry('approvazione', at('11-05', '11:00'), 'sarim-contabilita'),
    ],
    worker: personWorker('sarim-dg', 'decide se pagare trattenendo la penale per il ritardo', at('11-05', '11:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-dg', due: '2026-11-29', priority: 'alta',
    originals: [
      paper('fattura', 'Fattura 318/2026', 'invoice', 'SDI', at('11-02', '09:29'), [ // allow-italian: fixture data, shown as written
        'FatturaPA, tipo documento TD01, numero 318/2026, data 2026-10-30', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: Officina veicoli industriali (esempio)', // allow-italian: fixture data, shown as written
        BUYER,
        'Riga 1: riparazione impianto idraulico del compattatore targa FZ 318 KD, ricambi = 2.860,00', // allow-italian: fixture data, shown as written
        'Riga 2: manodopera, 26 ore x 48,00 = 1.248,00', // allow-italian: fixture data, shown as written
        'Imponibile 4.108,00, IVA 22% 903,76, totale documento 5.011,76', // allow-italian: fixture data, shown as written
        'Scadenza pagamento: 29/11/2026', // allow-italian: fixture data, shown as written
      ]),
      paper('scheda', 'Scheda lavori del mezzo FZ 318 KD', 'sheet', "scheda di accettazione dell'officina", at('10-29', '17:30'), [ // allow-italian: fixture data, shown as written
        'Mezzo FZ 318 KD, compattatore posteriore 23 m³, cantiere di Sarno', // allow-italian: fixture data, shown as written
        'Ingresso in officina: 20/10/2026 ore 08:15', // allow-italian: fixture data, shown as written
        'Riconsegna: 29/10/2026 ore 17:30', // allow-italian: fixture data, shown as written
        'Lavori: sostituzione della pompa e di due tubi ad alta pressione', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Imponibile', '4.108,00 euro', 'fattura', 'Imponibile 4.108,00', 99), // allow-italian: fixture data, shown as written
      read('IVA', '903,76 euro', 'fattura', 'IVA 22% 903,76', 99),
      read('Totale', '5.011,76 euro', 'fattura', 'totale documento 5.011,76', 99), // allow-italian: fixture data, shown as written
      read('Ingresso in officina', '20/10/2026', 'scheda', 'Ingresso in officina: 20/10/2026', 96), // allow-italian: fixture data, shown as written
      read('Riconsegna', '29/10/2026', 'scheda', 'Riconsegna: 29/10/2026', 96), // allow-italian: fixture data, shown as written
    ],
    proposal: "Il mezzo è rimasto in officina 9 giorni, dal 20/10 al 29/10: pagare trattenendo la penale per il ritardo dell'art. 6 del contratto di manutenzione, con una lettera all'officina.", // allow-italian: fixture data, shown as written
    links: { contract: 'c-officina', clause: 'art-6' },
  },
  {
    id: 'FT-2601', flow: 'sarim-fatture', step: 's7',
    title: 'Lubrificanti di ottobre, pagata e riconciliata', // allow-italian: fixture data, shown as written
    detail: 'Fornitore lubrificanti (esempio) · 2.257,00 euro', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-30', '10:00'), 'agent:ag-fatture'),
      entry('lavorazione', at('10-30', '10:05'), 'agent:ag-fatture'),
      entry('verifica', at('10-30', '14:00'), 'agent:ag-fatture'), // allow-italian: stage id, compared by value
      entry('fatto', at('11-04', '16:30'), 'agent:ag-fatture'), // allow-italian: stage id, compared by value
    ],
    worker: agentWorker('ag-fatture', 'ha abbinato il bonifico del 04/11 e chiuso la riconciliazione', at('11-04', '16:30')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-contabilita', priority: 'normale',
    originals: [
      paper('fattura', 'Fattura 77/2026', 'invoice', 'SDI', at('10-30', '09:59'), [ // allow-italian: fixture data, shown as written
        'FatturaPA, tipo documento TD01, numero 77/2026, data 2026-10-29', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: Fornitore lubrificanti (esempio)', // allow-italian: fixture data, shown as written
        BUYER,
        'Riga 1: olio idraulico, 10 fusti da 200 litri = 1.850,00', // allow-italian: fixture data, shown as written
        'Imponibile 1.850,00, IVA 22% 407,00, totale documento 2.257,00', // allow-italian: fixture data, shown as written
        'Riferimento ordine: 2026/0365 del 01/10/2026', // allow-italian: fixture data, shown as written
      ]),
      paper('banca', 'Movimento in banca del 04/11', 'sheet', 'estratto conto', at('11-04', '16:00'), [ // allow-italian: fixture data, shown as written
        'Estratto conto, movimento del 04/11/2026', // allow-italian: fixture data, shown as written
        'Bonifico in uscita 2.257,00 a Fornitore lubrificanti (esempio)', // allow-italian: fixture data, shown as written
        'Causale: saldo fattura 77/2026', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Imponibile', '1.850,00 euro', 'fattura', 'Imponibile 1.850,00', 99), // allow-italian: fixture data, shown as written
      read('IVA', '407,00 euro', 'fattura', 'IVA 22% 407,00', 99),
      read('Totale', '2.257,00 euro', 'fattura', 'totale documento 2.257,00', 99), // allow-italian: fixture data, shown as written
      read('Bonifico', '2.257,00 euro', 'banca', 'Bonifico in uscita 2.257,00', 98), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Il bonifico del 04/11 è uguale al totale della fattura 77/2026: riconciliazione chiusa.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'FT-2598', flow: 'sarim-fatture', step: 's7',
    title: 'Dispositivi di protezione per gli operatori', // allow-italian: fixture data, shown as written
    detail: 'Fornitore DPI (esempio) · 4.831,20 euro', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-27', '09:00'), 'agent:ag-fatture'),
      entry('lavorazione', at('10-27', '09:05'), 'agent:ag-fatture'),
      entry('verifica', at('10-27', '15:00'), 'agent:ag-fatture'), // allow-italian: stage id, compared by value
      entry('approvazione', at('10-28', '10:00'), 'sarim-contabilita'),
      entry('fatto', at('10-30', '17:10'), 'sarim-contabilita'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-contabilita', 'ha chiuso la fattura dopo il sì della direzione', at('10-30', '17:10')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-contabilita', priority: 'normale',
    originals: [
      paper('fattura', 'Fattura 2290/2026', 'invoice', 'SDI', at('10-27', '08:59'), [ // allow-italian: fixture data, shown as written
        'FatturaPA, tipo documento TD01, numero 2290/2026, data 2026-10-26', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: Fornitore DPI (esempio)', // allow-italian: fixture data, shown as written
        BUYER,
        'Riga 1: giubbotti ad alta visibilità, 120 pezzi x 24,50 = 2.940,00', // allow-italian: fixture data, shown as written
        'Riga 2: guanti da lavoro, 600 paia x 1,70 = 1.020,00', // allow-italian: fixture data, shown as written
        'Imponibile 3.960,00, IVA 22% 871,20, totale documento 4.831,20', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Imponibile', '3.960,00 euro', 'fattura', 'Imponibile 3.960,00', 99), // allow-italian: fixture data, shown as written
      read('IVA', '871,20 euro', 'fattura', 'IVA 22% 871,20', 99),
      read('Totale', '4.831,20 euro', 'fattura', 'totale documento 4.831,20', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: "Fattura uguale all'ordine e alla bolla: pagamento alla scadenza.", // allow-italian: fixture data, shown as written
  },
];

/* ---------- gare (6) ---------- */

const TENDERS: SarimCard[] = [
  {
    id: 'GA-034', flow: 'sarim-gara', step: 's1',
    title: 'Spazzamento meccanizzato, Comune costiero (esempio)', // allow-italian: fixture data, shown as written
    detail: 'provincia di Salerno · 2.180.000,00 euro · 36 mesi', place: 'Comune costiero (esempio)', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '09:10'), 'agent:ag-gare')],
    worker: agentWorker('ag-gare', 'legge bando e disciplinare', at('11-06', '09:10')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-tecnico', due: '2026-11-27', priority: 'normale',
    originals: [
      paper('bando', 'Bando di gara, spazzamento', 'tender', 'portale gare', at('11-05', '17:00'), [ // allow-italian: fixture data, shown as written
        'Bando di gara: procedura aperta per il servizio di spazzamento meccanizzato e manuale', // allow-italian: fixture data, shown as written
        'Stazione appaltante: Comune costiero (esempio), provincia di Salerno', // allow-italian: fixture data, shown as written
        'Importo a base di gara: 2.180.000,00 euro, IVA esclusa', // allow-italian: fixture data, shown as written
        'Durata: 36 mesi', // allow-italian: fixture data, shown as written
        'Termine per le offerte: 27/11/2026 ore 12:00', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Importo', '2.180.000,00 euro', 'bando', 'Importo a base di gara: 2.180.000,00 euro', 98), // allow-italian: fixture data, shown as written
      read('Durata', '36 mesi', 'bando', 'Durata: 36 mesi', 98), // allow-italian: fixture data, shown as written
      read('Scadenza offerte', '27/11/2026 ore 12:00', 'bando', 'Termine per le offerte: 27/11/2026 ore 12:00', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Gara vicina ai cantieri del Cilento: preparare la scheda per la valutazione della Tecnica.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'GA-033', flow: 'sarim-gara', step: 's2',
    title: 'Raccolta porta a porta, Unione di comuni (esempio)', // allow-italian: fixture data, shown as written
    detail: 'provincia di Salerno · 6.420.000,00 euro · 60 mesi', place: 'Unione di comuni (esempio)', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '11:40'), 'agent:ag-gare'),
      entry('lavorazione', at('11-05', '11:50'), 'agent:ag-gare'),
    ],
    worker: agentWorker('ag-gare', 'prepara la scheda: requisiti, CCNL, mezzi e personale da assorbire', at('11-06', '08:30')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-tecnico', due: '2026-11-20', priority: 'normale',
    originals: [
      paper('bando', 'Bando di gara, porta a porta', 'tender', 'portale gare', at('11-05', '11:30'), [ // allow-italian: fixture data, shown as written
        'Bando di gara: procedura aperta per la raccolta porta a porta e il trasporto dei rifiuti urbani di 4 comuni', // allow-italian: fixture data, shown as written
        'Stazione appaltante: Unione di comuni (esempio), provincia di Salerno', // allow-italian: fixture data, shown as written
        'Importo a base di gara: 6.420.000,00 euro, IVA esclusa, di cui oneri per la sicurezza 64.200,00', // allow-italian: fixture data, shown as written
        'Durata: 60 mesi', // allow-italian: fixture data, shown as written
        'Criterio di aggiudicazione: offerta economicamente più vantaggiosa', // allow-italian: fixture data, shown as written
        'Termine per le offerte: 20/11/2026 ore 12:00', // allow-italian: fixture data, shown as written
        'Clausola sociale: assorbimento del personale del gestore uscente, 23 addetti', // allow-italian: fixture data, shown as written
        'CCNL da applicare: FISE Assoambiente', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Importo', '6.420.000,00 euro', 'bando', 'Importo a base di gara: 6.420.000,00 euro', 98), // allow-italian: fixture data, shown as written
      read('Durata', '60 mesi', 'bando', 'Durata: 60 mesi', 98), // allow-italian: fixture data, shown as written
      read('Scadenza offerte', '20/11/2026 ore 12:00', 'bando', 'Termine per le offerte: 20/11/2026 ore 12:00', 99), // allow-italian: fixture data, shown as written
      read('Personale da assorbire', '23 addetti', 'bando', 'personale del gestore uscente, 23 addetti', 90), // allow-italian: fixture data, shown as written
      read('CCNL', 'FISE Assoambiente', 'bando', 'CCNL da applicare: FISE Assoambiente', 96), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Gara compatibile con i cantieri vicini, 23 addetti da assorbire: la scheda va alla Tecnica per mezzi e costi.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'GA-031', flow: 'sarim-gara', step: 's3',
    title: 'Igiene urbana, Comune collinare (esempio): manca un chiarimento', // allow-italian: fixture data, shown as written
    detail: 'provincia di Avellino · 3.950.000,00 euro · 48 mesi', place: 'Comune collinare (esempio)', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-02', '10:20'), 'agent:ag-gare'),
      entry('lavorazione', at('11-02', '10:30'), 'agent:ag-gare'),
    ],
    worker: personWorker('sarim-tecnico', 'stima mezzi e personale, ma il numero di utenze non torna', at('11-03', '12:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-tecnico', due: '2026-11-23', priority: 'normale',
    blocked: { reason: 'aspetta il chiarimento della stazione appaltante sul numero di utenze', since: at('11-03', '12:00') }, // allow-italian: fixture data, shown as written
    originals: [
      paper('bando', 'Bando di gara, igiene urbana', 'tender', 'portale gare', at('11-02', '10:10'), [ // allow-italian: fixture data, shown as written
        'Bando di gara: procedura aperta per il servizio di igiene urbana', // allow-italian: fixture data, shown as written
        'Stazione appaltante: Comune collinare (esempio), provincia di Avellino', // allow-italian: fixture data, shown as written
        'Importo a base di gara: 3.950.000,00 euro, IVA esclusa', // allow-italian: fixture data, shown as written
        'Durata: 48 mesi', // allow-italian: fixture data, shown as written
        'Utenze servite: 7.800 domestiche e 640 non domestiche', // allow-italian: fixture data, shown as written
        'Termine per le offerte: 23/11/2026 ore 12:00', // allow-italian: fixture data, shown as written
      ]),
      paper('chiarimento', 'Richiesta di chiarimento', 'mail', 'portale gare', at('11-03', '12:00'), [ // allow-italian: fixture data, shown as written
        "Quesito n. 2: il capitolato indica 8.900 utenze domestiche, il bando 7.800. Quale numero vale per l'offerta?", // allow-italian: fixture data, shown as written
        'Inviato dal portale il 03/11/2026 alle 12:00', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Importo', '3.950.000,00 euro', 'bando', 'Importo a base di gara: 3.950.000,00 euro', 98), // allow-italian: fixture data, shown as written
      read('Utenze nel bando', '7.800 domestiche', 'bando', '7.800 domestiche', 95), // allow-italian: fixture data, shown as written
      read('Utenze nel capitolato', '8.900 domestiche', 'chiarimento', 'il capitolato indica 8.900 utenze domestiche', 74), // allow-italian: fixture data, shown as written
      read('Scadenza offerte', '23/11/2026 ore 12:00', 'bando', 'Termine per le offerte: 23/11/2026 ore 12:00', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Con 8.900 utenze servono 2 mezzi in più: aspettare la risposta prima di stimare i costi.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'GA-030', flow: 'sarim-gara', step: 's4',
    title: 'Raccolta e trasporto dei rifiuti urbani, CUC (esempio) per 3 comuni', // allow-italian: fixture data, shown as written
    detail: 'provincia di Salerno · 5.270.000,00 euro · 60 mesi', place: 'CUC (esempio)', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-29', '09:00'), 'agent:ag-gare'),
      entry('lavorazione', at('10-29', '09:10'), 'agent:ag-gare'),
      entry('verifica', at('11-04', '17:00'), 'sarim-tecnico'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-bruno', 'verifica garanzie, requisiti e clausola sociale', at('11-05', '09:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-bruno', due: '2026-11-16', priority: 'alta',
    originals: [
      paper('bando', 'Bando di gara, raccolta e trasporto', 'tender', 'portale gare', at('10-28', '16:00'), [ // allow-italian: fixture data, shown as written
        'Bando di gara: procedura aperta per la raccolta e il trasporto dei rifiuti urbani', // allow-italian: fixture data, shown as written
        'Stazione appaltante: CUC (esempio) per 3 comuni della provincia di Salerno', // allow-italian: fixture data, shown as written
        'Importo a base di gara: 5.270.000,00 euro, IVA esclusa', // allow-italian: fixture data, shown as written
        'Durata: 60 mesi, con opzione di proroga di 6 mesi', // allow-italian: fixture data, shown as written
        'Termine per le offerte: 16/11/2026 ore 12:00', // allow-italian: fixture data, shown as written
        'Requisiti: iscrizione Albo Gestori Ambientali categoria 1 classe D o superiore', // allow-italian: fixture data, shown as written
        "Garanzia provvisoria: 2% dell'importo a base di gara", // allow-italian: fixture data, shown as written
        'CCNL da applicare: FISE Assoambiente', // allow-italian: fixture data, shown as written
      ]),
      paper('scheda', 'Scheda della Tecnica', 'sheet', 'Word, scheda di valutazione', at('11-04', '17:00'), [ // allow-italian: fixture data, shown as written
        'Mezzi necessari: 9 compattatori, 4 costipatori, 2 lavacassonetti', // allow-italian: fixture data, shown as written
        'Personale: 31 addetti, di cui 26 dal gestore uscente', // allow-italian: fixture data, shown as written
        'Parere: partecipare', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Importo', '5.270.000,00 euro', 'bando', 'Importo a base di gara: 5.270.000,00 euro', 98), // allow-italian: fixture data, shown as written
      read('Scadenza offerte', '16/11/2026 ore 12:00', 'bando', 'Termine per le offerte: 16/11/2026 ore 12:00', 99), // allow-italian: fixture data, shown as written
      read('Iscrizione Albo', 'categoria 1, classe D', 'bando', 'categoria 1 classe D o superiore', 96), // allow-italian: fixture data, shown as written
      read('Garanzia provvisoria', '105.400,00 euro (2%)', 'bando', "Garanzia provvisoria: 2% dell'importo a base di gara", 93), // allow-italian: fixture data, shown as written
      read('Parere della Tecnica', 'partecipare', 'scheda', 'Parere: partecipare', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: "La Tecnica dice di partecipare: chiedere subito la garanzia provvisoria di 105.400,00 euro, perché l'offerta scade il 16/11 e manca solo il controllo del Legale.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'GA-029', flow: 'sarim-gara', step: 's5',
    title: 'Igiene urbana, Comune dei Castelli Romani (esempio)', // allow-italian: fixture data, shown as written
    detail: 'città metropolitana di Roma · 9.800.000,00 euro · 84 mesi', place: 'Comune dei Castelli Romani (esempio)', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-26', '10:00'), 'agent:ag-gare'),
      entry('lavorazione', at('10-26', '10:15'), 'agent:ag-gare'),
      entry('verifica', at('10-30', '12:00'), 'sarim-tecnico'), // allow-italian: stage id, compared by value
      entry('approvazione', at('11-05', '18:00'), 'sarim-bruno'),
    ],
    worker: personWorker('sarim-dg', 'decide se partecipare', at('11-05', '18:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-dg', due: '2026-11-19', priority: 'alta',
    originals: [
      paper('bando', 'Bando di gara, igiene urbana', 'tender', 'portale gare', at('10-26', '09:50'), [ // allow-italian: fixture data, shown as written
        'Bando di gara: procedura aperta per il servizio integrato di igiene urbana', // allow-italian: fixture data, shown as written
        'Stazione appaltante: Comune dei Castelli Romani (esempio), città metropolitana di Roma', // allow-italian: fixture data, shown as written
        'Importo a base di gara: 9.800.000,00 euro, IVA esclusa', // allow-italian: fixture data, shown as written
        'Durata: 84 mesi', // allow-italian: fixture data, shown as written
        'Termine per le offerte: 19/11/2026 ore 12:00', // allow-italian: fixture data, shown as written
      ]),
      paper('scheda', 'Scheda di valutazione', 'sheet', 'Word, scheda della Tecnica e del Legale', at('11-05', '17:40'), [ // allow-italian: fixture data, shown as written
        'Distanza: 15 km dai cantieri di Rocca Priora e Grottaferrata', // allow-italian: fixture data, shown as written
        'Margine stimato dalla Tecnica: 6,8%', // allow-italian: fixture data, shown as written
        'Parere del Legale: nessun ostacolo nei requisiti', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Importo', '9.800.000,00 euro', 'bando', 'Importo a base di gara: 9.800.000,00 euro', 98), // allow-italian: fixture data, shown as written
      read('Durata', '84 mesi', 'bando', 'Durata: 84 mesi', 98), // allow-italian: fixture data, shown as written
      read('Scadenza offerte', '19/11/2026 ore 12:00', 'bando', 'Termine per le offerte: 19/11/2026 ore 12:00', 99), // allow-italian: fixture data, shown as written
      read('Margine stimato', '6,8%', 'scheda', 'Margine stimato dalla Tecnica: 6,8%', 88), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Partecipare: è a 15 km dai cantieri di Rocca Priora e Grottaferrata, margine stimato 6,8%, nessun ostacolo nei requisiti.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'GA-027', flow: 'sarim-gara', step: 's6',
    title: 'Gara scartata: troppo lontana dai cantieri', // allow-italian: fixture data, shown as written
    detail: 'provincia di Potenza · 2.640.000,00 euro · 48 mesi', place: 'Comune (esempio) in provincia di Potenza', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-28', '09:00'), 'agent:ag-gare'),
      entry('lavorazione', at('10-28', '09:20'), 'agent:ag-gare'),
      entry('verifica', at('10-30', '10:00'), 'sarim-tecnico'), // allow-italian: stage id, compared by value
      entry('approvazione', at('11-02', '12:00'), 'sarim-bruno'),
      entry('fatto', at('11-04', '12:00'), 'sarim-dg'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-dg', 'ha deciso di non partecipare', at('11-04', '12:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-dg', priority: 'bassa',
    originals: [
      paper('bando', 'Bando di gara, raccolta', 'tender', 'portale gare', at('10-28', '08:40'), [ // allow-italian: fixture data, shown as written
        'Bando di gara: procedura aperta per la raccolta dei rifiuti urbani', // allow-italian: fixture data, shown as written
        'Stazione appaltante: Comune (esempio), provincia di Potenza', // allow-italian: fixture data, shown as written
        'Importo a base di gara: 2.640.000,00 euro, IVA esclusa', // allow-italian: fixture data, shown as written
        'Durata: 48 mesi', // allow-italian: fixture data, shown as written
        'Termine per le offerte: 12/11/2026 ore 12:00', // allow-italian: fixture data, shown as written
      ]),
      paper('scheda', 'Scheda della Tecnica', 'sheet', 'Word, scheda di valutazione', at('10-30', '10:00'), [ // allow-italian: fixture data, shown as written
        'Distanza dal cantiere più vicino: 95 km', // allow-italian: fixture data, shown as written
        'Parere della Tecnica: costi di trasferta troppo alti', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Importo', '2.640.000,00 euro', 'bando', 'Importo a base di gara: 2.640.000,00 euro', 98), // allow-italian: fixture data, shown as written
      read('Distanza', '95 km', 'scheda', 'Distanza dal cantiere più vicino: 95 km', 92), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Non partecipare: 95 km dal cantiere più vicino, i costi di trasferta tolgono il margine.', // allow-italian: fixture data, shown as written
  },
];

/* ---------- personale: tempi determinati, turni, ferie, fogli targa, INPS, RSU (9) ---------- */

const STAFF: SarimCard[] = [
  {
    id: 'PE-121', flow: 'sarim-turni', step: 's1',
    title: 'Ferie di Natale, cantiere di Agropoli', // allow-italian: fixture data, shown as written
    detail: 'Agropoli · 6 richieste fra il 21/12 e il 04/01', place: 'Agropoli', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '10:10'), 'agent:ag-personale')],
    worker: agentWorker('ag-personale', 'mette le richieste accanto ai turni di dicembre', at('11-06', '10:10')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-personale', due: '2026-11-30', priority: 'normale',
    originals: [
      paper('zucchetti', 'Richieste di ferie da Zucchetti', 'sheet', 'Zucchetti', at('11-06', '10:09'), [ // allow-italian: fixture data, shown as written
        'Zucchetti, richieste di ferie, cantiere di Agropoli', // allow-italian: fixture data, shown as written
        'Matricola 0233, dal 21/12/2026 al 31/12/2026', // allow-italian: fixture data, shown as written
        'Matricola 0241, dal 21/12/2026 al 27/12/2026', // allow-italian: fixture data, shown as written
        'Matricola 0256, dal 28/12/2026 al 04/01/2027', // allow-italian: fixture data, shown as written
        'Matricola 0260, dal 24/12/2026 al 04/01/2027', // allow-italian: fixture data, shown as written
        'Matricola 0271, dal 21/12/2026 al 24/12/2026', // allow-italian: fixture data, shown as written
        'Matricola 0288, dal 28/12/2026 al 31/12/2026', // allow-italian: fixture data, shown as written
        'Richieste aperte: 6', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Richieste', '6', 'zucchetti', 'Richieste aperte: 6', 99), // allow-italian: fixture data, shown as written
      read('Più lunga', 'matricola 0260, 12 giorni', 'zucchetti', 'Matricola 0260, dal 24/12/2026 al 04/01/2027', 94), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Il 28/12 sarebbero in ferie 4 operatori del cantiere insieme: approvarle a turni alterni.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PE-122', flow: 'sarim-turni', step: 's1',
    title: 'Fogli targa di giovedì, cantiere di Sarno', // allow-italian: fixture data, shown as written
    detail: 'Sarno · 2 mezzi usciti senza foglio targa', place: 'Sarno', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '07:30'), 'agent:ag-personale')],
    worker: agentWorker('ag-personale', 'cerca nei turni di giovedì chi guidava i 2 mezzi', at('11-06', '07:31')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-flotta', priority: 'normale',
    originals: [
      paper('fogli', 'Fogli targa del 05/11', 'sheet', 'Excel, fogli targa del cantiere', at('11-06', '07:29'), [ // allow-italian: fixture data, shown as written
        'Cantiere di Sarno, fogli targa di giovedì 05/11/2026', // allow-italian: fixture data, shown as written
        'Mezzi usciti: 14, fogli compilati: 12', // allow-italian: fixture data, shown as written
        'Senza foglio: GB 506 TL (compattatore), FV 129 DS (porter)', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Mezzi usciti', '14', 'fogli', 'Mezzi usciti: 14', 98), // allow-italian: fixture data, shown as written
      read('Fogli compilati', '12', 'fogli', 'fogli compilati: 12', 98), // allow-italian: fixture data, shown as written
      read('Senza foglio', 'GB 506 TL, FV 129 DS', 'fogli', 'GB 506 TL (compattatore), FV 129 DS (porter)', 93), // allow-italian: fixture data, shown as written
    ],
    proposal: "Il compattatore GB 506 TL è anche nel formulario FIR-0938 delle 13:20: completare il foglio con l'autista di quel turno.", // allow-italian: fixture data, shown as written
    links: { card: 'FIR-0938' },
  },
  {
    id: 'PE-118', flow: 'sarim-scadenze', step: 's3',
    title: '3 contratti a termine del servizio estivo di Castellabate scadono il 30/11', // allow-italian: fixture data, shown as written
    detail: 'Castellabate · 2 operatori ecologici e un autista · scadenza 30/11/2026', place: 'Castellabate', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-02', '07:00'), 'agent:ag-personale'),
      entry('lavorazione', at('11-05', '16:00'), 'agent:ag-personale'),
    ],
    worker: agentWorker('ag-personale', 'prepara la scheda dei 3 contratti: mesi fatti e proroghe usate', at('11-06', '09:40')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-personale', due: '2026-11-30', priority: 'alta',
    originals: [
      paper('zucchetti', 'Contratti a termine in scadenza', 'sheet', 'Zucchetti', at('11-02', '07:00'), [ // allow-italian: fixture data, shown as written
        'Zucchetti, contratti a tempo determinato in scadenza entro 60 giorni', // allow-italian: fixture data, shown as written
        'Matricola 0612, operatore ecologico, Castellabate, servizio estivo, scadenza 30/11/2026', // allow-italian: fixture data, shown as written
        'Matricola 0618, operatore ecologico, Castellabate, servizio estivo, scadenza 30/11/2026', // allow-italian: fixture data, shown as written
        'Matricola 0623, autista patente C, Castellabate, servizio estivo, scadenza 30/11/2026', // allow-italian: fixture data, shown as written
        'Proroghe già usate: 0612 una, 0618 nessuna, 0623 una', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Scadenza', '30/11/2026', 'zucchetti', 'servizio estivo, scadenza 30/11/2026', 99), // allow-italian: fixture data, shown as written
      read('Autista', 'matricola 0623, patente C', 'zucchetti', 'Matricola 0623, autista patente C', 97), // allow-italian: fixture data, shown as written
      read('Proroghe usate', '0612 una, 0618 nessuna, 0623 una', 'zucchetti', 'Proroghe già usate: 0612 una, 0618 nessuna, 0623 una', 86), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Proroga di un mese per i 3 contratti, fino al 31/12, per coprire le ferie di dicembre.', // allow-italian: fixture data, shown as written
    links: { contract: 'c-td-castellabate', clause: 'art-2' },
  },
  {
    id: 'PE-115', flow: 'sarim-turni', step: 's3',
    title: 'UniEmens di ottobre: 2 matricole non tornano', // allow-italian: fixture data, shown as written
    detail: 'INPS · denuncia di ottobre · da inviare entro il 30/11', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-04', '08:00'), 'agent:ag-personale'),
      entry('lavorazione', at('11-04', '09:30'), 'agent:ag-personale'),
    ],
    worker: personWorker('sarim-personale', 'confronta presenze e cedolini delle 2 matricole', at('11-04', '15:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-personale', due: '2026-11-30', priority: 'alta',
    blocked: { reason: 'aspetta da Zucchetti i cedolini corretti delle 2 matricole', since: at('11-04', '15:00') }, // allow-italian: fixture data, shown as written
    originals: [
      paper('controllo', 'Controllo UniEmens di ottobre', 'sheet', 'Zucchetti', at('11-04', '08:00'), [ // allow-italian: fixture data, shown as written
        'Zucchetti, controllo della denuncia UniEmens, competenza ottobre 2026', // allow-italian: fixture data, shown as written
        'Matricola 0517: ore lavorate in presenze 168, in cedolino 152', // allow-italian: fixture data, shown as written
        'Matricola 0544: ore lavorate in presenze 160, in cedolino 176', // allow-italian: fixture data, shown as written
        "Differenze da correggere prima dell'invio: 2", // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Differenze', '2', 'controllo', "Differenze da correggere prima dell'invio: 2", 98), // allow-italian: fixture data, shown as written
      read('Matricola 0517', '168 ore contro 152', 'controllo', 'Matricola 0517: ore lavorate in presenze 168, in cedolino 152', 95), // allow-italian: fixture data, shown as written
      read('Matricola 0544', '160 ore contro 176', 'controllo', 'Matricola 0544: ore lavorate in presenze 160, in cedolino 176', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Correggere i 2 cedolini e inviare la denuncia di ottobre entro il 30/11.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PE-117', flow: 'sarim-scadenze', step: 's4',
    title: '2 contratti a termine di Sarno scadono il 31/12', // allow-italian: fixture data, shown as written
    detail: 'Sarno · 2 operatori ecologici · scadenza 31/12/2026', place: 'Sarno', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-02', '07:00'), 'agent:ag-personale'),
      entry('lavorazione', at('11-02', '07:05'), 'agent:ag-personale'),
      entry('verifica', at('11-06', '09:00'), 'agent:ag-personale'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-personale', 'decide fra rinnovo e chiusura', at('11-06', '09:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-personale', due: '2026-12-31', priority: 'normale',
    originals: [
      paper('zucchetti', 'Contratti a termine in scadenza', 'sheet', 'Zucchetti', at('11-02', '07:00'), [ // allow-italian: fixture data, shown as written
        'Zucchetti, contratti a tempo determinato in scadenza entro 60 giorni', // allow-italian: fixture data, shown as written
        'Matricola 0587, operatore ecologico, Sarno, scadenza 31/12/2026, mesi già fatti: 10', // allow-italian: fixture data, shown as written
        'Matricola 0590, operatore ecologico, Sarno, scadenza 31/12/2026, mesi già fatti: 22', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Scadenza', '31/12/2026', 'zucchetti', 'Sarno, scadenza 31/12/2026', 99), // allow-italian: fixture data, shown as written
      read('Matricola 0587', '10 mesi fatti', 'zucchetti', 'mesi già fatti: 10', 95), // allow-italian: fixture data, shown as written
      read('Matricola 0590', '22 mesi fatti', 'zucchetti', 'mesi già fatti: 22', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'La matricola 0590 arriva a 24 mesi il 31/12: si sceglie fra assunzione a tempo indeterminato e chiusura; la 0587 si può rinnovare.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PE-116', flow: 'sarim-turni', step: 's5',
    title: 'Fogli targa di ottobre: chilometri che non tornano', // allow-italian: fixture data, shown as written
    detail: 'Albanella · 3 mezzi · 640 km in più del GPS', place: 'Albanella', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-02', '08:00'), 'agent:ag-personale'),
      entry('lavorazione', at('11-02', '08:10'), 'agent:ag-personale'),
      entry('verifica', at('11-04', '18:00'), 'agent:ag-personale'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-flotta', 'confronta i chilometri dei fogli targa con il GPS', at('11-05', '08:30')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-flotta', priority: 'normale',
    originals: [
      paper('fogli', 'Riepilogo dei fogli targa di ottobre', 'sheet', 'Excel, fogli targa del cantiere', at('11-02', '08:00'), [ // allow-italian: fixture data, shown as written
        'Cantiere di Albanella, fogli targa di ottobre 2026', // allow-italian: fixture data, shown as written
        'FX 402 KP: 1.920 km sui fogli, 1.610 km dal GPS', // allow-italian: fixture data, shown as written
        'GA 233 RM: 1.455 km sui fogli, 1.270 km dal GPS', // allow-italian: fixture data, shown as written
        'FY 118 LN: 980 km sui fogli, 835 km dal GPS', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('FX 402 KP', '310 km in più', 'fogli', 'FX 402 KP: 1.920 km sui fogli, 1.610 km dal GPS', 94), // allow-italian: fixture data, shown as written
      read('GA 233 RM', '185 km in più', 'fogli', 'GA 233 RM: 1.455 km sui fogli, 1.270 km dal GPS', 94), // allow-italian: fixture data, shown as written
      read('FY 118 LN', '145 km in più', 'fogli', 'FY 118 LN: 980 km sui fogli, 835 km dal GPS', 83), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Chiedere ai 3 autisti i fogli del 12 e del 19/10, dove la differenza è più alta, e controllare i rifornimenti di quei giorni.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PE-120', flow: 'sarim-turni', step: 's6',
    title: 'Assemblea delle RSU di giovedì 12/11: spostare i turni', // allow-italian: fixture data, shown as written
    detail: 'sede di Eboli · dalle 10:30 alle 12:30 · turni del mattino', place: 'Eboli', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '15:20'), 'agent:ag-personale'),
      entry('lavorazione', at('11-05', '15:25'), 'agent:ag-personale'),
      entry('verifica', at('11-05', '17:00'), 'agent:ag-personale'), // allow-italian: stage id, compared by value
      entry('approvazione', at('11-06', '08:00'), 'sarim-personale'),
    ],
    worker: personWorker('sarim-personale', "approva lo spostamento dei turni per l'assemblea", at('11-06', '08:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-personale', due: '2026-11-12', priority: 'normale',
    originals: [
      paper('mail', 'Mail delle RSU', 'mail', 'posta del Personale', at('11-05', '15:18'), [ // allow-italian: fixture data, shown as written
        'Oggetto: convocazione di assemblea retribuita, giovedì 12/11/2026', // allow-italian: fixture data, shown as written
        "Le RSU convocano l'assemblea dei lavoratori nella sede di Eboli, dalle 10:30 alle 12:30.", // allow-italian: fixture data, shown as written
        'Ordine del giorno: accordo integrativo su turni e reperibilità.', // allow-italian: fixture data, shown as written
        'Le RSU',
      ]),
    ],
    values: [
      read('Data', '12/11/2026', 'mail', 'giovedì 12/11/2026', 99), // allow-italian: fixture data, shown as written
      read('Orario', '10:30-12:30', 'mail', 'dalle 10:30 alle 12:30', 97), // allow-italian: fixture data, shown as written
      read('Ordine del giorno', 'turni e reperibilità', 'mail', 'accordo integrativo su turni e reperibilità', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: "Anticipare di 2 ore i giri del mattino del 12/11 e chiudere i turni alle 10:00 nei cantieri che partecipano all'assemblea.", // allow-italian: fixture data, shown as written
    links: { card: 'CT-A05' },
  },
  {
    id: 'PE-112', flow: 'sarim-scadenze', step: 's6',
    title: 'Proroga di 2 contratti a termine, Pontecagnano Faiano', // allow-italian: fixture data, shown as written
    detail: 'Pontecagnano Faiano · 2 operatori · prorogati al 28/02/2027', place: 'Pontecagnano Faiano', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-26', '07:00'), 'agent:ag-personale'),
      entry('lavorazione', at('10-26', '07:05'), 'agent:ag-personale'),
      entry('verifica', at('10-27', '09:00'), 'agent:ag-personale'), // allow-italian: stage id, compared by value
      entry('approvazione', at('10-29', '10:00'), 'sarim-personale'),
      entry('fatto', at('11-03', '12:00'), 'sarim-personale'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-personale', 'ha consegnato le lettere e inviato le comunicazioni obbligatorie', at('11-03', '12:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-personale', priority: 'normale',
    originals: [
      paper('zucchetti', 'Contratti a termine in scadenza', 'sheet', 'Zucchetti', at('10-26', '07:00'), [ // allow-italian: fixture data, shown as written
        'Zucchetti, contratti a tempo determinato in scadenza entro 60 giorni', // allow-italian: fixture data, shown as written
        'Matricola 0534, operatore ecologico, Pontecagnano Faiano, scadenza 30/11/2026', // allow-italian: fixture data, shown as written
        'Matricola 0539, operatore ecologico, Pontecagnano Faiano, scadenza 30/11/2026', // allow-italian: fixture data, shown as written
      ]),
      paper('lettera', 'Lettera di proroga', 'letter', 'Word, firmata dalla direzione', at('11-02', '11:00'), [ // allow-italian: fixture data, shown as written
        'Oggetto: proroga del contratto a tempo determinato', // allow-italian: fixture data, shown as written
        'Il contratto è prorogato fino al 28/02/2027 alle stesse condizioni.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Scadenza', '30/11/2026', 'zucchetti', 'Pontecagnano Faiano, scadenza 30/11/2026', 99), // allow-italian: fixture data, shown as written
      read('Nuova scadenza', '28/02/2027', 'lettera', 'prorogato fino al 28/02/2027', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Proroga di 3 mesi dei 2 contratti, fino al 28/02/2027.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PE-113', flow: 'sarim-turni', step: 's7',
    title: 'Presenze di ottobre chiuse, cantiere di Bellizzi', // allow-italian: fixture data, shown as written
    detail: 'Bellizzi · 22 operatori · ottobre 2026', place: 'Bellizzi', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-31', '13:00'), 'agent:ag-personale'),
      entry('lavorazione', at('10-31', '13:10'), 'agent:ag-personale'),
      entry('verifica', at('11-02', '09:00'), 'agent:ag-personale'), // allow-italian: stage id, compared by value
      entry('approvazione', at('11-02', '11:00'), 'sarim-personale'),
      entry('fatto', at('11-02', '18:00'), 'agent:ag-personale'), // allow-italian: stage id, compared by value
    ],
    worker: agentWorker('ag-personale', 'ha chiuso il mese in Zucchetti dopo il sì del Personale', at('11-02', '18:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-personale', priority: 'normale',
    originals: [
      paper('zucchetti', 'Chiusura presenze di ottobre', 'sheet', 'Zucchetti', at('10-31', '13:00'), [ // allow-italian: fixture data, shown as written
        'Zucchetti, chiusura presenze di ottobre 2026, cantiere di Bellizzi', // allow-italian: fixture data, shown as written
        'Operatori: 22, giorni lavorati 506, ferie 31 giorni, malattia 9 giorni', // allow-italian: fixture data, shown as written
        'Straordinari approvati: 46 ore', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Operatori', '22', 'zucchetti', 'Operatori: 22', 99), // allow-italian: fixture data, shown as written
      read('Straordinari', '46 ore', 'zucchetti', 'Straordinari approvati: 46 ore', 97), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Presenze di ottobre complete, nessuna assenza senza giustificativo: mese da chiudere.', // allow-italian: fixture data, shown as written
  },
];

/* ---------- contratti e varianti (7): the ids the contracts of `contracts.ts` link back to ---------- */

const CONTRACT_CARDS: SarimCard[] = [
  {
    id: 'CT-S02', flow: 'sarim-varianti', step: 's1',
    title: 'Contratto di Vallo della Lucania scaduto, servizio proseguito', // allow-italian: fixture data, shown as written
    detail: 'Vallo della Lucania · scaduto il 14/03/2025 · serve un atto', place: 'Vallo della Lucania', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '07:00'), 'agent:ag-contratti')],
    worker: agentWorker('ag-contratti', 'ha trovato il contratto scaduto e prepara il riepilogo', at('11-06', '07:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-bruno', priority: 'alta',
    originals: [
      paper('scadenzario', 'Scadenzario dei contratti', 'sheet', 'Excel del Legale', at('11-06', '07:00'), [ // allow-italian: fixture data, shown as written
        'Scadenzario dei contratti, controllo del 06/11/2026', // allow-italian: fixture data, shown as written
        'Vallo della Lucania, ATI SARIM e Nappi Sud, contratto del 05/12/2017', // allow-italian: fixture data, shown as written
        'Valore: 9.298.979,61 euro', // allow-italian: fixture data, shown as written
        'Scadenza: 14/03/2025', // allow-italian: fixture data, shown as written
        "Stato: servizio proseguito dopo la scadenza, nessun atto di proroga nell'archivio", // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Contratto', '05/12/2017', 'scadenzario', 'contratto del 05/12/2017', 98), // allow-italian: fixture data, shown as written
      read('Valore', '9.298.979,61 euro', 'scadenzario', 'Valore: 9.298.979,61 euro', 98), // allow-italian: fixture data, shown as written
      read('Scadenza', '14/03/2025', 'scadenzario', 'Scadenza: 14/03/2025', 99), // allow-italian: fixture data, shown as written
      read('Stato', 'servizio proseguito, nessun atto', 'scadenzario', 'servizio proseguito dopo la scadenza', 92), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Preparare per il Legale il riepilogo e la scelta fra proroga tecnica e nuovo contratto, da chiedere al Comune.', // allow-italian: fixture data, shown as written
    links: { contract: 'c-vallo' },
  },
  {
    id: 'CT-N12', flow: 'sarim-varianti', step: 's3',
    title: 'Autorizzazione al subappalto del lavaggio contenitori', // allow-italian: fixture data, shown as written
    detail: 'Castellabate · Subappaltatore lavaggio (esempio) · richiesta al RUP', place: 'Castellabate', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-03', '11:00'), 'agent:ag-contratti'),
      entry('lavorazione', at('11-04', '10:00'), 'sarim-bruno'),
    ],
    worker: personWorker('sarim-bruno', 'scrive la richiesta di autorizzazione al RUP', at('11-05', '09:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-dg', priority: 'normale',
    blocked: { reason: 'manca il DURC aggiornato del subappaltatore', since: at('11-05', '09:00') }, // allow-italian: fixture data, shown as written
    originals: [
      paper('offerta', 'Offerta del subappaltatore', 'letter', 'posta del Legale', at('11-03', '10:40'), [ // allow-italian: fixture data, shown as written
        'Oggetto: lavaggio e igienizzazione dei contenitori, Comune di Castellabate', // allow-italian: fixture data, shown as written
        'Servizio: 2 lavaggi al mese dei contenitori stradali e dei carrellati, da aprile a settembre', // allow-italian: fixture data, shown as written
        'Documenti allegati: visura camerale, dichiarazione dei requisiti, DURC', // allow-italian: fixture data, shown as written
      ]),
      paper('durc', 'DURC allegato', 'form', "allegato all'offerta", at('11-03', '10:40'), [ // allow-italian: fixture data, shown as written
        'Documento unico di regolarità contributiva', // allow-italian: fixture data, shown as written
        'Esito: regolare', // allow-italian: fixture data, shown as written
        'Scadenza validità: 28/10/2026', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Servizio', '2 lavaggi al mese, aprile-settembre', 'offerta', '2 lavaggi al mese', 97), // allow-italian: fixture data, shown as written
      read('DURC', 'scaduto il 28/10/2026', 'durc', 'Scadenza validità: 28/10/2026', 98), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Richiesta al RUP pronta tranne il DURC: quello allegato è scaduto il 28/10, chiederne uno nuovo al subappaltatore.', // allow-italian: fixture data, shown as written
    links: { contract: 'c-sub-lavaggio', clause: 'art-2' },
  },
  {
    id: 'CT-R03', flow: 'sarim-varianti', step: 's4',
    title: "Rinnovo dell'accordo quadro gasolio", // allow-italian: fixture data, shown as written
    detail: 'Fornitore carburanti (esempio) · scade il 31/01/2027 · disdetta entro il 02/12/2026', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-02', '07:30'), 'agent:ag-contratti'),
      entry('lavorazione', at('11-02', '07:40'), 'agent:ag-contratti'),
      entry('verifica', at('11-05', '16:00'), 'agent:ag-contratti'), // allow-italian: stage id, compared by value
    ],
    worker: agentWorker('ag-contratti', 'confronta il prezzo della v2 con le ultime 6 fatture', at('11-06', '09:50')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-contabilita', due: '2026-12-02', priority: 'normale',
    originals: [
      paper('mail', 'Mail del fornitore', 'mail', 'posta della contabilità', at('11-02', '07:20'), [ // allow-italian: fixture data, shown as written
        'Oggetto: accordo quadro gasolio in scadenza il 31/01/2027', // allow-italian: fixture data, shown as written
        'Vi proponiamo il rinnovo alle condizioni della versione in vigore.', // allow-italian: fixture data, shown as written
        'Ricordiamo che la disdetta va comunicata con 60 giorni di preavviso.', // allow-italian: fixture data, shown as written
      ]),
      paper('fatture', 'Ultime 6 fatture del gasolio', 'sheet', 'Excel della contabilità', at('11-05', '15:40'), [ // allow-italian: fixture data, shown as written
        'Fatture del gasolio da maggio a ottobre 2026, Fornitore carburanti (esempio)', // allow-italian: fixture data, shown as written
        'Maggio: 17.800 litri a 1,3740 euro', // allow-italian: fixture data, shown as written
        'Giugno: 18.200 litri a 1,3820 euro', // allow-italian: fixture data, shown as written
        'Luglio: 19.100 litri a 1,3880 euro', // allow-italian: fixture data, shown as written
        'Agosto: 19.400 litri a 1,3950 euro', // allow-italian: fixture data, shown as written
        'Settembre: 17.400 litri a 1,3960 euro', // allow-italian: fixture data, shown as written
        'Ottobre: 18.000 litri a 1,4120 euro, fattura 2026/0417', // allow-italian: fixture data, shown as written
        'Prezzo medio semplice: 1,3912 euro al litro', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Scadenza', '31/01/2027', 'mail', 'in scadenza il 31/01/2027', 99), // allow-italian: fixture data, shown as written
      read('Preavviso', '60 giorni', 'mail', 'con 60 giorni di preavviso', 97), // allow-italian: fixture data, shown as written
      read('Prezzo medio', '1,3912 euro al litro', 'fatture', 'Prezzo medio semplice: 1,3912 euro al litro', 96), // allow-italian: fixture data, shown as written
      read('Ottobre', '1,4120 euro al litro', 'fatture', 'Ottobre: 18.000 litri a 1,4120 euro', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: "Ottobre è il prezzo più alto dei 6 mesi e sta sopra la formula dell'art. 5 (FT-2611): decidere entro il 02/12 se rinnovare o dare disdetta.", // allow-italian: fixture data, shown as written
    links: { contract: 'c-carburante', clause: 'art-5', card: 'FT-2611' },
  },
  {
    id: 'CT-A05', flow: 'sarim-varianti', step: 's4',
    title: 'Accordo integrativo su turni e reperibilità, versione 2', // allow-italian: fixture data, shown as written
    detail: "RSU · proposta di versione 2 · modifica dell'art. 3", // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '15:30'), 'agent:ag-contratti'),
      entry('lavorazione', at('11-05', '15:40'), 'agent:ag-contratti'),
      entry('verifica', at('11-06', '08:20'), 'agent:ag-contratti'), // allow-italian: stage id, compared by value
    ],
    worker: agentWorker('ag-contratti', 'evidenzia cosa cambia fra v1 e v2', at('11-06', '08:20')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-personale', due: '2026-11-12', priority: 'normale',
    originals: [
      paper('mail', 'Mail delle RSU con la versione 2', 'mail', 'posta del Personale', at('11-05', '15:25'), [ // allow-italian: fixture data, shown as written
        'Oggetto: accordo integrativo su turni e reperibilità, proposta di versione 2', // allow-italian: fixture data, shown as written
        "In allegato la versione 2 con le modifiche all'art. 3 su turni festivi e reperibilità.", // allow-italian: fixture data, shown as written
        "La discuteremo nell'assemblea di giovedì 12/11/2026.", // allow-italian: fixture data, shown as written
        'Le RSU',
      ]),
    ],
    values: [
      read('Articolo', 'art. 3', 'mail', "le modifiche all'art. 3", 96), // allow-italian: fixture data, shown as written
      read('Temi', 'turni festivi e reperibilità', 'mail', 'turni festivi e reperibilità', 94), // allow-italian: fixture data, shown as written
      read('Assemblea', '12/11/2026', 'mail', 'giovedì 12/11/2026', 98), // allow-italian: fixture data, shown as written
    ],
    proposal: "Mettere accanto v1 e v2 dell'art. 3 per il Personale prima dell'assemblea del 12/11.", // allow-italian: fixture data, shown as written
    links: { contract: 'c-accordo-turni', clause: 'art-3', card: 'PE-120' },
  },
  {
    id: 'CT-V07', flow: 'sarim-varianti', step: 's6',
    title: 'Variante: spazzamento estivo nelle frazioni costiere', // allow-italian: fixture data, shown as written
    detail: 'Castellabate · variante v3 · +4,2% del valore', place: 'Castellabate', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-26', '10:30'), 'agent:ag-contratti'),
      entry('lavorazione', at('10-26', '11:00'), 'agent:ag-contratti'),
      entry('verifica', at('10-30', '12:00'), 'sarim-bruno'), // allow-italian: stage id, compared by value
      entry('approvazione', at('11-02', '15:00'), 'sarim-bruno'),
    ],
    worker: personWorker('sarim-dg', 'deve approvare la variante prima della firma', at('11-02', '15:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-dg', priority: 'alta',
    originals: [
      paper('pec', 'PEC del Comune di Castellabate', 'mail', 'PEC del Comune', at('10-26', '10:20'), [ // allow-italian: fixture data, shown as written
        'Oggetto: contratto di gestione integrata dei rifiuti e spazzamento, CIG B8B7C39D2A, richiesta di variante', // allow-italian: fixture data, shown as written
        'Si chiede di estendere lo spazzamento estivo alle frazioni costiere dal 1 giugno al 30 settembre di ogni anno.', // allow-italian: fixture data, shown as written
        'Il RUP del contratto', // allow-italian: fixture data, shown as written
      ]),
      paper('variante', 'Bozza della variante', 'letter', 'Word, bozza del Legale', at('10-30', '11:40'), [ // allow-italian: fixture data, shown as written
        'Atto di variante al contratto del 29/01/2026, CIG B8B7C39D2A', // allow-italian: fixture data, shown as written
        'Oggetto: estensione dello spazzamento estivo nelle frazioni costiere', // allow-italian: fixture data, shown as written
        'Importo della variante: 477.761,29 euro, pari al 4,2% del valore del contratto', // allow-italian: fixture data, shown as written
        "Modifica l'art. 4 del contratto; le altre clausole restano invariate.", // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('CIG', 'B8B7C39D2A', 'variante', 'CIG B8B7C39D2A', 99),
      read('Importo della variante', '477.761,29 euro', 'variante', 'Importo della variante: 477.761,29 euro', 97), // allow-italian: fixture data, shown as written
      read('Quota del valore', '4,2%', 'variante', 'pari al 4,2% del valore del contratto', 97), // allow-italian: fixture data, shown as written
      read('Periodo', 'dal 1 giugno al 30 settembre', 'pec', 'dal 1 giugno al 30 settembre di ogni anno', 90), // allow-italian: fixture data, shown as written
      read('Clausola', 'art. 4', 'variante', "Modifica l'art. 4 del contratto", 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Variante di 477.761,29 euro, il 4,2% del valore: il Legale ha controllato la bozza, manca il sì della direzione prima della firma.', // allow-italian: fixture data, shown as written
    links: { contract: 'c-castellabate', clause: 'art-4' },
  },
  {
    id: 'CT-F01', flow: 'sarim-varianti', step: 's7',
    title: 'Firma della versione 2 del contratto di Albanella', // allow-italian: fixture data, shown as written
    detail: 'Albanella · firmata digitalmente il 04/11/2026', place: 'Albanella', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-28', '09:00'), 'agent:ag-contratti'),
      entry('lavorazione', at('10-28', '09:30'), 'sarim-bruno'),
      entry('verifica', at('10-30', '11:00'), 'sarim-bruno'), // allow-italian: stage id, compared by value
      entry('approvazione', at('11-02', '10:00'), 'sarim-bruno'),
      entry('fatto', at('11-04', '16:00'), 'sarim-dg'), // allow-italian: stage id, compared by value
    ],
    worker: personWorker('sarim-dg', 'ha firmato digitalmente la versione 2', at('11-04', '16:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-bruno', priority: 'normale',
    originals: [
      paper('firma', 'Pagina delle firme, versione 2', 'letter', 'Word, firmato digitalmente', at('11-04', '16:00'), [ // allow-italian: fixture data, shown as written
        'Contratto per il servizio di raccolta e trasporto dei rifiuti urbani e di igiene urbana, Comune di Albanella', // allow-italian: fixture data, shown as written
        'CIG B6242F1551',
        'Importo contrattuale: 7.559.582,25 euro, durata 7 anni con eventuale proroga di 12 mesi', // allow-italian: fixture data, shown as written
        'Versione 2, firmata digitalmente per S.A.R.I.M. SRL il 04/11/2026', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('CIG', 'B6242F1551', 'firma', 'CIG B6242F1551', 99),
      read('Importo', '7.559.582,25 euro', 'firma', 'Importo contrattuale: 7.559.582,25 euro', 99), // allow-italian: fixture data, shown as written
      read('Durata', '7 anni, più 12 mesi di proroga eventuale', 'firma', 'durata 7 anni con eventuale proroga di 12 mesi', 97), // allow-italian: fixture data, shown as written
      read('Firma', '04/11/2026', 'firma', 'firmata digitalmente per S.A.R.I.M. SRL il 04/11/2026', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Versione 2 firmata: inviarla al Comune via PEC e archiviarla come versione in vigore.', // allow-italian: fixture data, shown as written
    links: { contract: 'c-albanella' },
  },
  {
    id: 'CT-T04', flow: 'sarim-varianti', step: 's7',
    title: 'Verbale di passaggio degli 11 lavoratori della Castellabate Servizi', // allow-italian: fixture data, shown as written
    detail: 'Castellabate · 11 lavoratori · verbale archiviato con le firme', place: 'Castellabate', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-29', '10:00'), 'agent:ag-contratti'),
      entry('lavorazione', at('10-29', '10:10'), 'agent:ag-contratti'),
      entry('verifica', at('10-30', '09:00'), 'agent:ag-contratti'), // allow-italian: stage id, compared by value
      entry('fatto', at('11-02', '11:00'), 'agent:ag-contratti'), // allow-italian: stage id, compared by value
    ],
    worker: agentWorker('ag-contratti', 'ha archiviato il verbale con tutte le firme, controllate dal Personale', at('11-02', '11:00')), // allow-italian: fixture data, shown as written
    reviewer: 'sarim-personale', priority: 'normale',
    originals: [
      paper('verbale', 'Verbale di accordo, copia firmata', 'letter', 'scansione del Personale', at('10-29', '09:50'), [ // allow-italian: fixture data, shown as written
        'Verbale di accordo per il passaggio del personale, servizio di igiene urbana del Comune di Castellabate', // allow-italian: fixture data, shown as written
        'S.A.R.I.M. SRL assume 11 lavoratori della Castellabate Servizi srl dal 01/04/2026, in applicazione del CCNL.', // allow-italian: fixture data, shown as written
        'Firme: S.A.R.I.M. SRL, Castellabate Servizi srl, organizzazioni sindacali', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Lavoratori', '11', 'verbale', 'assume 11 lavoratori della Castellabate Servizi srl', 99), // allow-italian: fixture data, shown as written
      read('Dal', '01/04/2026', 'verbale', 'dal 01/04/2026', 96), // allow-italian: fixture data, shown as written
      read('Firme', 'SARIM, Castellabate Servizi, sindacati', 'verbale', 'Firme: S.A.R.I.M. SRL, Castellabate Servizi srl, organizzazioni sindacali', 93), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Verbale completo di tutte le firme: archiviarlo con il contratto di Castellabate.', // allow-italian: fixture data, shown as written
    links: { contract: 'c-accordo-castellabate' },
  },
];

export const SARIM_CARDS: SarimCard[] = [...REPORTS, ...FORMS, ...INVOICES, ...TENDERS, ...STAFF, ...CONTRACT_CARDS];
