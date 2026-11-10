/**
 * The work on the kanban of «Da fare» in the Consorzio edition: the columns and allow-italian: quotes the words on screen
 * every card, each on the flow that moves it (`./flows.ts`), with its history,
 * who has it in hand, who checks it, its originals and the values read on them.
 * Same shape and the same rules as `../orbit-org/cards.ts`.
 *
 * The demo moment is Friday 6 November 2026, 10:30 (`DEMO_NOW`): nothing here
 * happens after it except due dates. A card in «Fatto» was closed from 30/10 on. allow-italian: quotes the words on screen
 * Cards are stopped for one of two reasons: blocked on something outside it,
 * or left in its column longer than its flow's `stuckAfterHours`; every other
 * open card entered its column more recently than that.
 *
 * Real: the comuni, canals, torrents and basins (Libro dell'anno 2025 of the allow-italian: quotes the words on screen
 * Consorzio, `DATI-VERI.md`), the norms, the programs, the sede and the PEC
 * address of the Consorzio. An example: every private person, farm, company and
 * firm, every amount, CIG, protocol, invoice and form number, every date of a
 * single case; each original says so on its last line. Cases 2381-2421 are the
 * ones of the old preview (`../org/cases/`), moved into the new shape and given
 * the prefix of their flow; the others follow the same numbers.
 */
import type { CardOriginal, CardValue, OrbitCard, Stage, StageEntry, StageId, Worker } from '../orbit-org/types';

/* ---------- helpers ---------- */

/** `2026-11-06T09:40:00+01:00` from `11-06` and `09:40`: every time on a card is autumn 2026, Rome time (summer time ends on 25/10). */
const at = (day: string, time: string) => `2026-${day}T${time}:00${day < '10-25' ? '+02:00' : '+01:00'}`;
const entry = (stage: StageId, when: string, by: string): StageEntry => ({ stage, at: when, by });
const agentWorker = (id: string, doing: string, since: string): Worker => ({ kind: 'agent', id, doing, since });
const personWorker = (id: string, doing: string, since: string): Worker => ({ kind: 'person', id, doing, since });
const read = (label: string, value: string, doc: string, quote: string, confidence: number): CardValue => ({ label, value, doc, quote, confidence });

/** The last line of every original: they are all examples (`DATI-VERI.md`: no real persons, amounts or case numbers). */
const EXAMPLE_NOTE = "Documento di esempio per l'anteprima di Topics: persone, numeri e importi non reali."; // allow-italian: fixture data, shown as written
const paper = (id: string, name: string, kind: CardOriginal['kind'], from: string, when: string, lines: string[]): CardOriginal => ({ id, name, kind, from, at: when, lines: [...lines, EXAMPLE_NOTE] });

/** The lines the Consorzio repeats on what it receives and sends (public data of the Consorzio). */
const PEC_TO = 'A: protocollo@x.example.it';
const BUYER = 'Cessionario/committente: CONSORZIO DI BONIFICA INTEGRALE COMPRENSORIO SARNO, codice fiscale 80009450653'; // allow-italian: fixture data, shown as written
const VAT_NOTE = 'Esigibilità IVA: S (scissione dei pagamenti), art. 17-ter DPR 633/1972'; // allow-italian: fixture data, shown as written

/* ---------- columns ---------- */

export const NOCERA_STAGES: Stage[] = [
  { id: 'arrivo', label: 'In arrivo', hint: "L'agente lo legge e lo prepara" }, // allow-italian: fixture data, shown as written
  { id: 'lavorazione', label: 'In lavorazione', hint: 'Ci lavora un agente o una persona' }, // allow-italian: fixture data, shown as written
  { id: 'verifica', label: 'Da verificare', hint: "Una persona verifica ciò che l'agente ha letto e proposto" }, // allow-italian: fixture data, shown as written
  { id: 'approvazione', label: 'Da approvare', hint: 'Aspetta chi approva o firma' }, // allow-italian: fixture data, shown as written
  { id: 'fatto', label: 'Fatto', hint: 'Chiuso negli ultimi 7 giorni' }, // allow-italian: fixture data, shown as written
];

/* ---------- PEC e protocollo (9) ---------- */

const PEC: OrbitCard[] = [
  {
    id: 'PEC-2423', flow: 'nocera-pec', step: 's1', // allow-italian: fixture data, shown as written
    title: 'Richiesta di spurgo del Canale Rio Pennacchio', // allow-italian: fixture data, shown as written
    detail: 'San Valentino Torio · PEC del Comune · tratto lungo la strada comunale', place: 'San Valentino Torio', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '10:02'), 'agent:ag-pec')], // allow-italian: fixture data, shown as written
    worker: agentWorker('ag-pec', 'legge la PEC e verifica la firma e la ricevuta di consegna', at('11-06', '10:03')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-protocollo', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('pec', 'PEC del Comune di San Valentino Torio', 'mail', 'PEC del Comune', at('11-06', '10:01'), [ // allow-italian: fixture data, shown as written
        'Da: lavori.pubblici@x.example.it', // allow-italian: fixture data, shown as written
        PEC_TO,
        'Oggetto: richiesta di spurgo del Canale Rio Pennacchio, tratto lungo la strada comunale', // allow-italian: fixture data, shown as written
        'Dopo le piogge dei giorni scorsi il canale è colmo di sedimenti e la sezione si è ridotta di circa la metà.', // allow-italian: fixture data, shown as written
        'Si chiede un intervento di spurgo prima delle prossime allerte meteo.', // allow-italian: fixture data, shown as written
        'Allegati: tre fotografie del tratto, planimetria', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Mittente', 'Comune di San Valentino Torio, lavori pubblici', 'pec', 'Da: lavori.pubblici@x.example.it', 92), // allow-italian: fixture data, shown as written
      read('Canale', 'Canale Rio Pennacchio', 'pec', 'spurgo del Canale Rio Pennacchio', 97), // allow-italian: fixture data, shown as written
      read('Luogo', 'strada comunale', 'pec', 'tratto lungo la strada comunale', 90), // allow-italian: fixture data, shown as written
      read('Richiesta', 'spurgo prima delle prossime allerte meteo', 'pec', 'spurgo prima delle prossime allerte meteo', 88), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Tipo: richiesta di intervento di un Comune; team Tecnico e manutenzione, che la apre come segnalazione dal territorio.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PEC-2422', flow: 'nocera-pec', step: 's3', lane: 'pB', // allow-italian: fixture data, shown as written
    title: "Contestazione dell'avviso 2026 per un capannone demolito", // allow-italian: fixture data, shown as written
    detail: 'Scafati · avviso 2026/0071120/01 · 486,50 euro', place: 'Scafati', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '09:21'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-06', '09:30'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-pec', "cerca in Prunes il contribuente dal numero dell'avviso", at('11-06', '09:31')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-protocollo', due: '2026-12-07', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('pec', 'PEC di una società di Scafati', 'mail', 'PEC della società', at('11-06', '09:20'), [ // allow-italian: fixture data, shown as written
        'Da: impresa.scafati@x.example.it', // allow-italian: fixture data, shown as written
        PEC_TO,
        "Oggetto: contestazione dell'avviso di pagamento n. 2026/0071120/01 e richiesta di annullamento in autotutela", // allow-italian: fixture data, shown as written
        'Il contributo 2026 di euro 486,50 è riferito a un capannone demolito nel 2024; si allega il certificato di demolizione.', // allow-italian: fixture data, shown as written
        'Si chiede una risposta entro 30 giorni dal ricevimento di questa PEC.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Tipo di PEC', 'contestazione di un avviso, annullamento in autotutela', 'pec', "contestazione dell'avviso di pagamento n. 2026/0071120/01", 86), // allow-italian: fixture data, shown as written
      read('Avviso', '2026/0071120/01, 486,50 euro', 'pec', 'avviso di pagamento n. 2026/0071120/01', 96), // allow-italian: fixture data, shown as written
      read('Motivo', 'capannone demolito nel 2024', 'pec', 'capannone demolito nel 2024', 91), // allow-italian: fixture data, shown as written
      read('Termine di risposta', 'entro 07/12/2026', 'pec', 'una risposta entro 30 giorni dal ricevimento', 74), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Titolario Istanze dei contribuenti, team Catasto e ruoli: la card passa a Istanza di sgravio e la risposta è dovuta entro 07/12 (il 06/12 è domenica).', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PEC-2421', flow: 'nocera-pec', step: 's2', // allow-italian: fixture data, shown as written
    title: 'Regione Campania chiede i dati dei Consorzi per la L.R. 7/2025', // allow-italian: fixture data, shown as written
    detail: 'Regione Campania · nota del 05/11/2026 · risposta entro 20 giorni', place: 'Regione Campania', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '08:15'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-06', '08:24'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-pec', 'propone la Direzione come team e calcola i 20 giorni per rispondere', at('11-06', '08:24')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-protocollo', due: '2026-11-26', priority: 'alta', // allow-italian: fixture data, shown as written
    originals: [
      paper('nota', 'Nota della Regione, ricognizione dei dati', 'mail', 'PEC della Regione', at('11-06', '08:14'), [ // allow-italian: fixture data, shown as written
        'Regione Campania, Giunta Regionale · Prot. n. 2026.0541234 del 05/11/2026', // allow-italian: fixture data, shown as written
        'Oggetto: L.R. 6 giugno 2025, n. 7. Attuazione: ricognizione dei dati dei Consorzi per il riordino dei comprensori e per il Piano comprensoriale di bonifica.', // allow-italian: fixture data, shown as written
        'Si chiede a ciascun Consorzio di trasmettere, entro 20 giorni dal ricevimento della presente, i seguenti dati:', // allow-italian: fixture data, shown as written
        'a) superficie del comprensorio di attuale operatività;', // allow-italian: fixture data, shown as written
        'b) consistenza della rete idraulica e delle opere, distinguendo canali di bonifica, promiscui e irrigui;', // allow-italian: fixture data, shown as written
        'c) personale in servizio al 31/12/2025, per qualifica;', // allow-italian: fixture data, shown as written
        'd) strumenti di classifica in vigore e loro data di approvazione;', // allow-italian: fixture data, shown as written
        "e) eventuali proposte sull'esercizio delle funzioni di difesa del suolo delegabili (art. 4).", // allow-italian: fixture data, shown as written
        'I dati vanno inviati via PEC, firmati dal legale rappresentante.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Mittente', 'Regione Campania, Giunta Regionale', 'nota', 'Regione Campania, Giunta Regionale', 98), // allow-italian: fixture data, shown as written
      read('Norma', 'L.R. 7/2025', 'nota', 'L.R. 6 giugno 2025, n. 7', 99), // allow-italian: fixture data, shown as written
      read('Termine di risposta', 'entro 26/11/2026', 'nota', 'entro 20 giorni dal ricevimento della presente', 80), // allow-italian: fixture data, shown as written
      read('Dati richiesti', 'superficie, rete, personale al 31/12/2025, classifica, difesa del suolo', 'nota', 'personale in servizio al 31/12/2025, per qualifica', 93), // allow-italian: fixture data, shown as written
      read('Firma', 'del legale rappresentante', 'nota', 'firmati dal legale rappresentante', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Alla Direzione, che firma; ogni team porta il suo dato (rete al Tecnico, personale al Personale) e la risposta parte per PEC entro il 26/11.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PEC-2418', flow: 'nocera-pec', step: 's6', lane: 'pA', // allow-italian: fixture data, shown as written
    title: 'Ricorso alla Corte di giustizia tributaria contro un avviso 2025', // allow-italian: fixture data, shown as written
    detail: 'Castel San Giorgio · azienda agricola (esempio) · avviso 2025/0048213/01 · 1.248,00 euro', place: 'Castel San Giorgio', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '09:12'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-05', '09:20'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-05', '12:41'), 'cn-protocollo'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-legale', 'legge i tre motivi del ricorso e la richiesta di sospensione', at('11-06', '09:40')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-legale', due: '2027-01-04', priority: 'alta', // allow-italian: fixture data, shown as written
    originals: [
      paper('pec', 'PEC con il ricorso', 'mail', 'PEC dello studio legale', at('11-05', '09:12'), [ // allow-italian: fixture data, shown as written
        'Da: studio.legale@x.example.it', // allow-italian: fixture data, shown as written
        PEC_TO,
        'Oggetto: Ricorso avverso avviso di pagamento 2025', // allow-italian: fixture data, shown as written
        'Il giorno 05/11/2026 alle ore 09:12:04 il messaggio «Ricorso avverso avviso di pagamento 2025» è stato consegnato nella casella di destinazione', // allow-italian: fixture data, shown as written
        'Allegati: ricorso.pdf.p7m, avviso-2025.pdf, tavola-12.pdf', // allow-italian: fixture data, shown as written
      ]),
      paper('ricorso', 'Ricorso alla Corte di giustizia tributaria', 'letter', 'allegato alla PEC', at('11-05', '09:12'), [ // allow-italian: fixture data, shown as written
        'CORTE DI GIUSTIZIA TRIBUTARIA DI PRIMO GRADO DI SALERNO', // allow-italian: fixture data, shown as written
        "RICORSO con istanza di sospensione dell'atto impugnato (art. 47 D.Lgs. 546/1992)", // allow-italian: fixture data, shown as written
        'AZIENDA AGRICOLA ESEMPIO s.s., con sede in Castel San Giorgio (SA)', // allow-italian: fixture data, shown as written
        "avverso l'avviso di pagamento n. 2025/0048213/01 del 31/08/2026, relativo al contributo consortile per l'anno 2025 di euro 1.248,00", // allow-italian: fixture data, shown as written
        'fondo al foglio 14, particelle 210 e 214, della superficie complessiva di ettari 2.76.80', // allow-italian: fixture data, shown as written
        'Il fondo della ricorrente non trae alcun beneficio diretto e specifico dalle opere del Consorzio', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Tipo di PEC', 'ricorso alla Corte di giustizia tributaria, con sospensione', 'ricorso', "RICORSO con istanza di sospensione dell'atto impugnato", 96), // allow-italian: fixture data, shown as written
      read('Atto impugnato', 'avviso 2025/0048213/01, 1.248,00 euro', 'ricorso', "avverso l'avviso di pagamento n. 2025/0048213/01 del 31/08/2026", 97), // allow-italian: fixture data, shown as written
      read('Particelle', 'Castel San Giorgio, foglio 14, particelle 210 e 214', 'ricorso', 'foglio 14, particelle 210 e 214', 95), // allow-italian: fixture data, shown as written
      read('Motivo principale', 'il fondo non trarrebbe beneficio dalle opere', 'ricorso', 'non trae alcun beneficio diretto e specifico dalle opere del Consorzio', 88), // allow-italian: fixture data, shown as written
      read('Termine di costituzione', '04/01/2027, 60 giorni dalla notifica', 'pec', 'Il giorno 05/11/2026 alle ore 09:12:04', 71), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Costituirsi entro il 04/01/2027 con le controdeduzioni (art. 23 D.Lgs. 546/1992), rispondendo anche sulla sospensione; Contenzioso, fascicolo Ricorsi 2025.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PEC-2419', flow: 'nocera-pec', step: 's5', lane: 'pF', // allow-italian: fixture data, shown as written
    title: 'Accesso civico alle concessioni di due canali', // allow-italian: fixture data, shown as written
    detail: "Nocera Inferiore · associazione (esempio) · Canale dei Mulini e Canale Macchione", place: 'Nocera Inferiore', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '16:20'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-05', '16:31'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-05', '17:10'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-protocollo', 'decide se è un accesso civico generalizzato o documentale', at('11-06', '09:15')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-protocollo', due: '2026-12-05', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('pec', 'PEC dell\'Associazione Esempio APS', 'mail', 'PEC dell\'associazione', at('11-05', '16:20'), [ // allow-italian: fixture data, shown as written
        'Per conto di: associazione.esempio@x.example.it', // allow-italian: fixture data, shown as written
        PEC_TO,
        'Oggetto: POSTA CERTIFICATA: Richiesta di accesso agli atti, concessioni Canale dei Mulini e Canale Macchione', // allow-italian: fixture data, shown as written
        "si trasmette in allegato l'istanza di accesso civico generalizzato dell'Associazione Esempio APS, firmata digitalmente dal legale rappresentante", // allow-italian: fixture data, shown as written
      ]),
      paper('istanza', 'Istanza di accesso', 'letter', 'allegato alla PEC', at('11-05', '16:20'), [ // allow-italian: fixture data, shown as written
        "Oggetto: istanza di accesso civico generalizzato ai sensi dell'art. 5, comma 2, del D.Lgs. 33/2013.", // allow-italian: fixture data, shown as written
        "1. l'elenco delle concessioni e autorizzazioni idrauliche per attraversamenti e scarichi rilasciate negli anni 2024 e 2025 sul Canale dei Mulini e sul Canale Macchione", // allow-italian: fixture data, shown as written
        "2. copia dei verbali di accertamento redatti negli stessi anni dall'ufficiale idraulico per scarichi non autorizzati nei medesimi canali", // allow-italian: fixture data, shown as written
        "L'istanza non richiede motivazione (art. 5, comma 3, D.Lgs. 33/2013).", // allow-italian: fixture data, shown as written
        'Il procedimento si conclude con provvedimento espresso e motivato nel termine di trenta giorni dalla presentazione dell\'istanza (art. 5, comma 6, D.Lgs. 33/2013).', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Tipo di PEC', 'accesso civico generalizzato', 'istanza', "istanza di accesso civico generalizzato ai sensi dell'art. 5, comma 2, del D.Lgs. 33/2013", 74), // allow-italian: fixture data, shown as written
      read('Canali', 'Canale dei Mulini, Canale Macchione', 'istanza', 'sul Canale dei Mulini e sul Canale Macchione', 98), // allow-italian: fixture data, shown as written
      read('Documenti chiesti', 'concessioni 2024-2025 e verbali di accertamento', 'istanza', 'rilasciate negli anni 2024 e 2025', 90), // allow-italian: fixture data, shown as written
      read('Termine di risposta', 'entro 05/12/2026, 30 giorni', 'istanza', 'nel termine di trenta giorni dalla presentazione', 82), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Titolario Accessi agli atti, team Protocollo e segreteria; i dati delle concessioni li fornisce il Tecnico, la risposta entro 05/12.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PEC-2415', flow: 'nocera-pec', step: 's5', lane: 'pC', // allow-italian: fixture data, shown as written
    title: 'Conferenza di servizi sul Canale Bottaro', // allow-italian: fixture data, shown as written
    detail: 'Scafati · convocazione del Comune · giovedì 12/11 ore 10:30', place: 'Scafati', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '14:10'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-05', '14:20'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-05', '15:05'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-protocollo', 'conferma il team: è di competenza del Tecnico', at('11-06', '08:50')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-protocollo', due: '2026-11-12', priority: 'alta', // allow-italian: fixture data, shown as written
    originals: [
      paper('pec', 'PEC del Comune di Scafati', 'mail', 'PEC del Comune', at('11-05', '14:09'), [ // allow-italian: fixture data, shown as written
        'Da: protocollo@x.example.it', // allow-italian: fixture data, shown as written
        PEC_TO,
        "Oggetto: convocazione della conferenza di servizi per il parere sull'attraversamento del Canale Bottaro", // allow-italian: fixture data, shown as written
        'La conferenza è convocata per giovedì 12/11/2026 alle ore 10:30, in modalità telematica.', // allow-italian: fixture data, shown as written
        'Si invita il Consorzio a esprimere il parere di competenza o a partecipare con un proprio rappresentante.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Tipo di PEC', 'convocazione di una conferenza di servizi', 'pec', 'convocazione della conferenza di servizi', 94), // allow-italian: fixture data, shown as written
      read('Canale', 'Canale Bottaro', 'pec', 'attraversamento del Canale Bottaro', 96), // allow-italian: fixture data, shown as written
      read('Data', 'giovedì 12/11/2026, ore 10:30', 'pec', 'giovedì 12/11/2026 alle ore 10:30', 99), // allow-italian: fixture data, shown as written
      read('Team', 'Tecnico e manutenzione', 'pec', 'esprimere il parere di competenza', 78), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Al Tecnico, che prepara il parere o manda un rappresentante entro giovedì 12/11; il Protocollo conferma il team.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PEC-2412', flow: 'nocera-pec', step: 's7', lane: 'pA', // allow-italian: fixture data, shown as written
    title: 'Decreto ingiuntivo del Tribunale di Salerno, 18.420 euro', // allow-italian: fixture data, shown as written
    detail: 'Costruzioni Esempio S.r.l. · decreto 1487/2026 · opposizione entro 40 giorni', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-04', '15:48'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-04', '15:55'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-05', '09:30'), 'cn-protocollo'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('11-05', '16:30'), 'cn-legale'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-dg', "deve approvare l'incarico al legale per l'opposizione", at('11-05', '16:30')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-dg', due: '2026-12-14', priority: 'alta', // allow-italian: fixture data, shown as written
    originals: [
      paper('pec', 'PEC con la notifica del decreto', 'mail', "PEC dello studio dell'avvocato", at('11-04', '15:48'), [ // allow-italian: fixture data, shown as written
        'Da: avvocato.esempio@x.example.it', // allow-italian: fixture data, shown as written
        PEC_TO,
        'Oggetto: notifica del decreto ingiuntivo n. 1487/2026 del Tribunale di Salerno', // allow-italian: fixture data, shown as written
        'Il giorno 04/11/2026 alle ore 15:48 il decreto è stato notificato a mezzo PEC ai sensi della L. 53/1994.', // allow-italian: fixture data, shown as written
      ]),
      paper('decreto', 'Decreto ingiuntivo n. 1487/2026', 'letter', 'allegato alla PEC', at('11-04', '15:48'), [ // allow-italian: fixture data, shown as written
        'TRIBUNALE DI SALERNO · DECRETO INGIUNTIVO n. 1487/2026', // allow-italian: fixture data, shown as written
        'ingiunge al Consorzio di Bonifica Integrale Comprensorio Sarno di pagare a Costruzioni Esempio S.r.l. la somma di euro 18.420,00, oltre interessi e spese', // allow-italian: fixture data, shown as written
        'Il debitore può proporre opposizione entro 40 giorni dalla notifica (art. 641 c.p.c.).', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Atto', 'decreto ingiuntivo 1487/2026, Tribunale di Salerno', 'decreto', 'DECRETO INGIUNTIVO n. 1487/2026', 98), // allow-italian: fixture data, shown as written
      read('Parte', 'Costruzioni Esempio S.r.l.', 'decreto', 'di pagare a Costruzioni Esempio S.r.l.', 96), // allow-italian: fixture data, shown as written
      read('Somma ingiunta', '18.420,00 euro, più interessi e spese', 'decreto', 'la somma di euro 18.420,00, oltre interessi e spese', 97), // allow-italian: fixture data, shown as written
      read('Termine di opposizione', 'entro 14/12/2026', 'decreto', 'entro 40 giorni dalla notifica', 74), // allow-italian: fixture data, shown as written
    ],
    proposal: "Incarico a un legale dell'albo per l'opposizione, con il parere dell'avvocato interno; serve la tua approvazione prima del 14/12.", // allow-italian: fixture data, shown as written
    links: { contract: 'ct-albo-legali' }, // allow-italian: fixture data, shown as written
  },
  {
    id: 'PEC-2410', flow: 'nocera-pec', step: 's1', // allow-italian: fixture data, shown as written
    title: 'Diffida ad adempiere con allegato che non si apre', // allow-italian: fixture data, shown as written
    detail: 'Studio legale (esempio) · diffida con termine 05/11 · firma p7m non leggibile', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('10-30', '17:42'), 'agent:ag-pec')], // allow-italian: fixture data, shown as written
    worker: personWorker('cn-protocollo', 'ha scritto al mittente per farsi rimandare il file', at('11-02', '09:10')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-protocollo', due: '2026-11-05', priority: 'alta', // allow-italian: fixture data, shown as written
    blocked: { reason: "l'allegato firmato non si apre: chiesto il reinvio al mittente il 02/11", since: at('11-02', '09:10') }, // allow-italian: fixture data, shown as written
    originals: [
      paper('pec', 'PEC con la diffida', 'mail', 'PEC dello studio legale', at('10-30', '17:42'), [ // allow-italian: fixture data, shown as written
        'Da: studio.legale.esempio@x.example.it', // allow-italian: fixture data, shown as written
        PEC_TO,
        'Oggetto: diffida ad adempiere nei confronti del Consorzio', // allow-italian: fixture data, shown as written
        'Si trasmette in allegato la diffida. Si prega di dare riscontro entro il 05/11/2026.', // allow-italian: fixture data, shown as written
        'Allegato: diffida.pdf.p7m (la firma digitale non risulta leggibile)', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Tipo di PEC', 'diffida ad adempiere', 'pec', 'diffida ad adempiere nei confronti del Consorzio', 90), // allow-italian: fixture data, shown as written
      read('Termine di riscontro', '05/11/2026', 'pec', 'riscontro entro il 05/11/2026', 93), // allow-italian: fixture data, shown as written
      read('Allegato', 'non leggibile', 'pec', 'la firma digitale non risulta leggibile', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: "Appena arriva il file leggibile: assegnare all'avvocato interno e rispondere; il termine del 05/11 è già passato, va scritto al mittente.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'PEC-2411', flow: 'nocera-pec', step: 's8', lane: 'pC', // allow-italian: fixture data, shown as written
    title: 'Certificato di collaudo della Vasca Santa Croce', // allow-italian: fixture data, shown as written
    detail: 'Nocera Superiore · studio tecnico (esempio) · protocollo 2026/0018302', place: 'Nocera Superiore', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-30', '09:15'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-30', '09:20'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
      entry('verifica', at('10-30', '14:00'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
      entry('fatto', at('11-03', '10:10'), 'agent:ag-pec'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-pec', 'ha protocollato in Halley con il numero 2026/0018302 e assegnato la PEC al Tecnico', at('11-03', '10:10')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-protocollo', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('pec', 'PEC con il certificato di collaudo', 'mail', 'PEC dello studio tecnico', at('10-30', '09:14'), [ // allow-italian: fixture data, shown as written
        'Da: studio.tecnico.esempio@x.example.it', // allow-italian: fixture data, shown as written
        PEC_TO,
        'Oggetto: trasmissione del certificato di collaudo, Vasca Santa Croce', // allow-italian: fixture data, shown as written
        'Si trasmette il certificato di collaudo statico della Vasca Santa Croce, in Comune di Nocera Superiore.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Tipo di PEC', 'certificato di collaudo', 'pec', 'certificato di collaudo statico', 96), // allow-italian: fixture data, shown as written
      read('Mittente', 'studio tecnico (esempio)', 'pec', 'Da: studio.tecnico.esempio@x.example.it', 92), // allow-italian: fixture data, shown as written
      read('Opera', 'Vasca Santa Croce, Nocera Superiore', 'pec', 'Vasca Santa Croce, in Comune di Nocera Superiore', 97), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Protocollata in Halley e assegnata al Tecnico: il certificato va nel fascicolo della vasca.', // allow-italian: fixture data, shown as written
  },
];

/* ---------- Fatture passive (7) ---------- */

const INVOICES: OrbitCard[] = [
  {
    id: 'FT-2414', flow: 'nocera-fatture', step: 's1', // allow-italian: fixture data, shown as written
    title: 'Fattura per il collaudo statico della Vasca Santa Croce', // allow-italian: fixture data, shown as written
    detail: 'Studio Tecnico Esempio · fattura 41/PA · 3.904,00 euro', place: 'Nocera Superiore', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '10:11'), 'agent:ag-fatture')], // allow-italian: fixture data, shown as written
    worker: agentWorker('ag-fatture', 'legge la fattura: fornitore, righe, imponibile e IVA', at('11-06', '10:12')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-ragioneria', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('fattura', 'Fattura 41/PA, collaudo statico', 'invoice', 'SdI', at('11-06', '10:10'), [ // allow-italian: fixture data, shown as written
        'Fattura elettronica n. 41/PA del 05/11/2026, consegnata dallo SdI il 06/11/2026', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: STUDIO TECNICO ESEMPIO, IT04567890123', // allow-italian: fixture data, shown as written
        BUYER,
        'Prestazione: collaudo statico della Vasca Santa Croce, Nocera Superiore', // allow-italian: fixture data, shown as written
        'Imponibile: 3.200,00 euro', // allow-italian: fixture data, shown as written
        'IVA 22%: 704,00 euro', // allow-italian: fixture data, shown as written
        VAT_NOTE,
        'Totale documento: 3.904,00 euro', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Fornitore', 'Studio Tecnico Esempio', 'fattura', 'STUDIO TECNICO ESEMPIO, IT04567890123', 97), // allow-italian: fixture data, shown as written
      read('Prestazione', 'collaudo statico della Vasca Santa Croce', 'fattura', 'collaudo statico della Vasca Santa Croce', 96), // allow-italian: fixture data, shown as written
      read('Imponibile', '3.200,00 euro', 'fattura', 'Imponibile: 3.200,00 euro', 99), // allow-italian: fixture data, shown as written
      read('IVA', '704,00 euro', 'fattura', 'IVA 22%: 704,00 euro', 99), // allow-italian: fixture data, shown as written
      read('Totale', '3.904,00 euro', 'fattura', 'Totale documento: 3.904,00 euro', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: "Abbinare alla PEC di collaudo PEC-2411 e all'incarico, poi fissare la scadenza a 30 giorni dal ricevimento.", // allow-italian: fixture data, shown as written
    links: { card: 'PEC-2411' }, // allow-italian: fixture data, shown as written
  },
  {
    id: 'FT-2412', flow: 'nocera-fatture', step: 's3', // allow-italian: fixture data, shown as written
    title: 'Energia elettrica dei pozzi irrigui, ottobre', // allow-italian: fixture data, shown as written
    detail: 'Energia Esempio S.p.A. · fattura 2026/4471 · 29.743,60 euro · 55 punti di prelievo', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-04', '08:10'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-04', '08:20'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-fatture', 'abbina le letture dei 55 punti di prelievo al contratto di fornitura', at('11-04', '08:20')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-ragioneria', due: '2026-12-04', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('fattura', 'Fattura 2026/4471, energia dei pozzi', 'invoice', 'SdI', at('11-04', '08:09'), [ // allow-italian: fixture data, shown as written
        'Fattura elettronica n. 2026/4471 del 03/11/2026, consegnata dallo SdI il 04/11/2026', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: ENERGIA ESEMPIO S.P.A., IT01234509876', // allow-italian: fixture data, shown as written
        BUYER,
        'Fornitura di energia elettrica ai pozzi irrigui, ottobre 2026, 55 punti di prelievo', // allow-italian: fixture data, shown as written
        'Consumo: 118.600 kWh · CIG derivato B6D3E18F27', // allow-italian: fixture data, shown as written
        'Imponibile: 24.380,00 euro', // allow-italian: fixture data, shown as written
        'IVA 22%: 5.363,60 euro', // allow-italian: fixture data, shown as written
        VAT_NOTE,
        'Totale documento: 29.743,60 euro', // allow-italian: fixture data, shown as written
        'Pagamento: bonifico a 30 giorni', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Fornitore', 'Energia Esempio S.p.A.', 'fattura', 'ENERGIA ESEMPIO S.P.A., IT01234509876', 97), // allow-italian: fixture data, shown as written
      read('Punti di prelievo', '55', 'fattura', '55 punti di prelievo', 96), // allow-italian: fixture data, shown as written
      read('CIG', 'B6D3E18F27', 'fattura', 'CIG derivato B6D3E18F27', 95), // allow-italian: fixture data, shown as written
      read('Imponibile', '24.380,00 euro', 'fattura', 'Imponibile: 24.380,00 euro', 99), // allow-italian: fixture data, shown as written
      read('IVA', '5.363,60 euro', 'fattura', 'IVA 22%: 5.363,60 euro', 99), // allow-italian: fixture data, shown as written
      read('Totale', '29.743,60 euro', 'fattura', 'Totale documento: 29.743,60 euro', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Abbinare ai consumi dei pozzi e al contratto di fornitura; se coincidono, scadenza al 04/12 e verifica della Ragioneria.', // allow-italian: fixture data, shown as written
    links: { contract: 'ct-energia-pozzi' }, // allow-italian: fixture data, shown as written
  },
  {
    id: 'FT-2413', flow: 'nocera-fatture', step: 's5', // allow-italian: fixture data, shown as written
    title: 'Noleggio escavatori di ottobre, 8 ore in più dei fogli di lavoro', // allow-italian: fixture data, shown as written
    detail: 'Noleggi Esempio S.r.l. · fattura 96/E · 11.712,00 euro', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-04', '16:40'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-04', '16:50'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-05', '15:30'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-ragioneria', 'confronta le 120 ore fatturate con i fogli di lavoro', at('11-06', '09:05')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-ragioneria', due: '2026-12-04', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('fattura', 'Fattura 96/E, noleggio escavatori', 'invoice', 'SdI', at('11-04', '16:39'), [ // allow-italian: fixture data, shown as written
        'Fattura elettronica n. 96/E del 03/11/2026, consegnata dallo SdI il 04/11/2026', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: NOLEGGI ESEMPIO S.R.L., IT02468013579', // allow-italian: fixture data, shown as written
        BUYER,
        'Noleggio di escavatore con operatore, ottobre 2026: 120 ore x 80,00 euro · CIG derivato B8A1F7C402', // allow-italian: fixture data, shown as written
        'Imponibile: 9.600,00 euro', // allow-italian: fixture data, shown as written
        'IVA 22%: 2.112,00 euro', // allow-italian: fixture data, shown as written
        VAT_NOTE,
        'Totale documento: 11.712,00 euro', // allow-italian: fixture data, shown as written
      ]),
      paper('fogli', 'Fogli di lavoro dei capisquadra, ottobre', 'sheet', 'squadre di manutenzione', at('11-04', '16:45'), [ // allow-italian: fixture data, shown as written
        'Fogli di lavoro del Tecnico e manutenzione, ottobre 2026, escavatore a noleggio', // allow-italian: fixture data, shown as written
        'Ore registrate dai capisquadra: 112', // allow-italian: fixture data, shown as written
        'Differenza con la fattura: 8 ore', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Fornitore', 'Noleggi Esempio S.r.l.', 'fattura', 'NOLEGGI ESEMPIO S.R.L., IT02468013579', 97), // allow-italian: fixture data, shown as written
      read('Imponibile', '9.600,00 euro', 'fattura', 'Imponibile: 9.600,00 euro', 99), // allow-italian: fixture data, shown as written
      read('IVA', '2.112,00 euro', 'fattura', 'IVA 22%: 2.112,00 euro', 99), // allow-italian: fixture data, shown as written
      read('Totale', '11.712,00 euro', 'fattura', 'Totale documento: 11.712,00 euro', 99), // allow-italian: fixture data, shown as written
      read('Ore fatturate', '120', 'fattura', '120 ore x 80,00 euro', 97), // allow-italian: fixture data, shown as written
      read('Ore nei fogli di lavoro', '112', 'fogli', 'Ore registrate dai capisquadra: 112', 88), // allow-italian: fixture data, shown as written
      read('Differenze', '8 ore, 640,00 euro più IVA', 'fogli', 'Differenza con la fattura: 8 ore', 82), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Rifiutare la fattura allo SdI e chiedere una nota di credito per 8 ore (640,00 euro più IVA); il resto è in regola.', // allow-italian: fixture data, shown as written
    links: { contract: 'ct-noleggio-escavatori' }, // allow-italian: fixture data, shown as written
  },
  {
    id: 'FT-2409', flow: 'nocera-fatture', step: 's5', // allow-italian: fixture data, shown as written
    title: 'Manutenzione delle elettropompe dei pozzi, fattura 318/PA', // allow-italian: fixture data, shown as written
    detail: 'Fornitore Esempio S.r.l. · ordine 2026/0187 · 5.929,20 euro · scissione dei pagamenti', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-27', '11:05'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-27', '11:15'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-05', '16:00'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-ragioneria', "confronta le righe con l'ordine 2026/0187 e con il DURC", at('11-06', '09:50')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-ragioneria', due: '2026-11-26', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('fattura', 'Fattura 318/PA, elettropompe dei pozzi', 'invoice', 'SdI', at('10-27', '11:05'), [ // allow-italian: fixture data, shown as written
        'Fattura elettronica n. 318/PA del 26/10/2026, consegnata dallo SdI il 27/10/2026', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: FORNITORE ESEMPIO S.R.L., IT09876543210', // allow-italian: fixture data, shown as written
        BUYER,
        'Ordine n. 2026/0187 del 02/10/2026 · CIG B4F7A20C9E', // allow-italian: fixture data, shown as written
        'Manutenzione di elettropompa sommersa di pozzo irriguo, tenute e cuscinetti: 2 x 1.350,00 euro', // allow-italian: fixture data, shown as written
        'Quadro di comando e protezione per elettropompa, fornitura e posa: 1.480,00 euro', // allow-italian: fixture data, shown as written
        'Manodopera specializzata: 16 ore x 42,50 euro = 680,00 euro', // allow-italian: fixture data, shown as written
        'Imponibile: 4.860,00 euro', // allow-italian: fixture data, shown as written
        'IVA 22%: 1.069,20 euro', // allow-italian: fixture data, shown as written
        VAT_NOTE,
        'Totale documento: 5.929,20 euro', // allow-italian: fixture data, shown as written
        'Pagamento: bonifico a 30 giorni', // allow-italian: fixture data, shown as written
      ]),
      paper('durc', 'DURC del fornitore', 'form', 'Durc On Line', at('10-28', '09:12'), [ // allow-italian: fixture data, shown as written
        'Durc On Line, protocollo INAIL_51234567 · richiesta del 28/10/2026', // allow-italian: fixture data, shown as written
        'FORNITORE ESEMPIO S.R.L. risulta regolare nei confronti di I.N.P.S. e I.N.A.I.L.', // allow-italian: fixture data, shown as written
        'Scadenza validità 25/02/2027', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Fornitore', 'Fornitore Esempio S.r.l.', 'fattura', 'FORNITORE ESEMPIO S.R.L., IT09876543210', 97), // allow-italian: fixture data, shown as written
      read('CIG', 'B4F7A20C9E', 'fattura', 'CIG B4F7A20C9E', 98), // allow-italian: fixture data, shown as written
      read('Imponibile', '4.860,00 euro', 'fattura', 'Imponibile: 4.860,00 euro', 99), // allow-italian: fixture data, shown as written
      read('IVA', '1.069,20 euro', 'fattura', 'IVA 22%: 1.069,20 euro', 99), // allow-italian: fixture data, shown as written
      read('Totale', '5.929,20 euro', 'fattura', 'Totale documento: 5.929,20 euro', 99), // allow-italian: fixture data, shown as written
      read('Scadenza', '26/11/2026', 'fattura', 'Pagamento: bonifico a 30 giorni', 88), // allow-italian: fixture data, shown as written
      read('DURC', 'regolare fino al 25/02/2027', 'durc', 'Scadenza validità 25/02/2027', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: "Accettare la fattura allo SdI; liquidare 4.860,00 euro entro il 26/11, l'IVA di 1.069,20 euro la versa il Consorzio all'Erario (scissione dei pagamenti).", // allow-italian: fixture data, shown as written
  },
  {
    id: 'FT-2410', flow: 'nocera-fatture', step: 's6', // allow-italian: fixture data, shown as written
    title: 'Gasolio per i mezzi della manutenzione, ottobre', // allow-italian: fixture data, shown as written
    detail: 'Carburanti Esempio S.r.l. · fattura 1190/2026 · 15.225,60 euro · serve il visto', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-28', '09:30'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-28', '09:40'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-03', '11:00'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('11-05', '17:00'), 'cn-ragioneria'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-dg', "deve dare il visto: l'importo supera la soglia della Ragioneria", at('11-05', '17:00')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-dg', due: '2026-11-27', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('fattura', 'Fattura 1190/2026, gasolio', 'invoice', 'SdI', at('10-28', '09:29'), [ // allow-italian: fixture data, shown as written
        'Fattura elettronica n. 1190/2026 del 27/10/2026, consegnata dallo SdI il 28/10/2026', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: CARBURANTI ESEMPIO S.R.L., IT05544332211', // allow-italian: fixture data, shown as written
        BUYER,
        'Gasolio per i mezzi della manutenzione, ottobre 2026: 9.600 litri x 1,30 euro · CIG derivato B2C90E71A5', // allow-italian: fixture data, shown as written
        'Imponibile: 12.480,00 euro', // allow-italian: fixture data, shown as written
        'IVA 22%: 2.745,60 euro', // allow-italian: fixture data, shown as written
        VAT_NOTE,
        'Totale documento: 15.225,60 euro', // allow-italian: fixture data, shown as written
        'Pagamento: bonifico a 30 giorni', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Fornitore', 'Carburanti Esempio S.r.l.', 'fattura', 'CARBURANTI ESEMPIO S.R.L., IT05544332211', 97), // allow-italian: fixture data, shown as written
      read('Litri', '9.600', 'fattura', '9.600 litri x 1,30 euro', 96), // allow-italian: fixture data, shown as written
      read('Imponibile', '12.480,00 euro', 'fattura', 'Imponibile: 12.480,00 euro', 99), // allow-italian: fixture data, shown as written
      read('IVA', '2.745,60 euro', 'fattura', 'IVA 22%: 2.745,60 euro', 99), // allow-italian: fixture data, shown as written
      read('Totale', '15.225,60 euro', 'fattura', 'Totale documento: 15.225,60 euro', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Fattura in regola con ordine e CIG: la Ragioneria ha verificato; con il tuo visto la liquidazione parte entro il 27/11.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'FT-2406', flow: 'nocera-fatture', step: 's2', // allow-italian: fixture data, shown as written
    title: 'Ricambi per le elettropompe senza CIG, scadenza già passata', // allow-italian: fixture data, shown as written
    detail: 'Ricambi Esempio S.n.c. · fattura 211 · 2.745,00 euro', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-02', '10:00'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-02', '10:12'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-ragioneria', 'aspetta la nota di credito e la nuova fattura dal fornitore', at('10-20', '09:30')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-ragioneria', due: '2026-11-01', priority: 'alta', // allow-italian: fixture data, shown as written
    blocked: { reason: 'manca il CIG sulla fattura: chiesti al fornitore la nota di credito e una nuova fattura il 20/10', since: at('10-20', '09:30') }, // allow-italian: fixture data, shown as written
    originals: [
      paper('fattura', 'Fattura 211, ricambi per elettropompe', 'invoice', 'SdI', at('10-02', '09:58'), [ // allow-italian: fixture data, shown as written
        'Fattura elettronica n. 211 del 30/09/2026, consegnata dallo SdI il 02/10/2026', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: RICAMBI ESEMPIO S.N.C., IT03692581470', // allow-italian: fixture data, shown as written
        BUYER,
        'Ricambi per elettropompe sommerse dei pozzi irrigui · CIG: non indicato', // allow-italian: fixture data, shown as written
        'Imponibile: 2.250,00 euro', // allow-italian: fixture data, shown as written
        'IVA 22%: 495,00 euro', // allow-italian: fixture data, shown as written
        VAT_NOTE,
        'Totale documento: 2.745,00 euro', // allow-italian: fixture data, shown as written
        'Pagamento: bonifico a 30 giorni', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Fornitore', 'Ricambi Esempio S.n.c.', 'fattura', 'RICAMBI ESEMPIO S.N.C., IT03692581470', 97), // allow-italian: fixture data, shown as written
      read('CIG', 'non indicato', 'fattura', 'CIG: non indicato', 99), // allow-italian: fixture data, shown as written
      read('Imponibile', '2.250,00 euro', 'fattura', 'Imponibile: 2.250,00 euro', 99), // allow-italian: fixture data, shown as written
      read('IVA', '495,00 euro', 'fattura', 'IVA 22%: 495,00 euro', 99), // allow-italian: fixture data, shown as written
      read('Totale', '2.745,00 euro', 'fattura', 'Totale documento: 2.745,00 euro', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: "Appena arriva la nuova fattura con il CIG: abbinarla all'ordine e pagarla subito, la scadenza del 01/11 è passata.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'FT-2405', flow: 'nocera-fatture', step: 's7', // allow-italian: fixture data, shown as written
    title: 'Svuotamento e pulizia della Vasca Pignataro, liquidata', // allow-italian: fixture data, shown as written
    detail: 'Servizi Ambientali Esempio S.r.l. · fattura 156 · 8.906,00 euro · mandato emesso', place: 'Pagani', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-26', '09:00'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-26', '09:10'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
      entry('verifica', at('10-29', '11:00'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('10-30', '15:00'), 'cn-ragioneria'), // allow-italian: fixture data, shown as written
      entry('fatto', at('11-02', '12:20'), 'agent:ag-fatture'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-fatture', 'ha registrato la liquidazione in TeamSystem e preparato il mandato di pagamento', at('11-02', '12:20')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-ragioneria', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('fattura', 'Fattura 156, pulizia della Vasca Pignataro', 'invoice', 'SdI', at('10-26', '08:59'), [ // allow-italian: fixture data, shown as written
        'Fattura elettronica n. 156 del 23/10/2026, consegnata dallo SdI il 26/10/2026', // allow-italian: fixture data, shown as written
        'Cedente/prestatore: SERVIZI AMBIENTALI ESEMPIO S.R.L., IT07418529630', // allow-italian: fixture data, shown as written
        BUYER,
        'Svuotamento e pulizia della Vasca Pignataro, Pagani · CIG derivato B1F52A80D3', // allow-italian: fixture data, shown as written
        'Imponibile: 7.300,00 euro', // allow-italian: fixture data, shown as written
        'IVA 22%: 1.606,00 euro', // allow-italian: fixture data, shown as written
        VAT_NOTE,
        'Totale documento: 8.906,00 euro', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Fornitore', 'Servizi Ambientali Esempio S.r.l.', 'fattura', 'SERVIZI AMBIENTALI ESEMPIO S.R.L., IT07418529630', 97), // allow-italian: fixture data, shown as written
      read('Opera', 'Vasca Pignataro, Pagani', 'fattura', 'Vasca Pignataro, Pagani', 97), // allow-italian: fixture data, shown as written
      read('Imponibile', '7.300,00 euro', 'fattura', 'Imponibile: 7.300,00 euro', 99), // allow-italian: fixture data, shown as written
      read('IVA', '1.606,00 euro', 'fattura', 'IVA 22%: 1.606,00 euro', 99), // allow-italian: fixture data, shown as written
      read('Totale', '8.906,00 euro', 'fattura', 'Totale documento: 8.906,00 euro', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: "Liquidata il 02/11: 7.300,00 euro al fornitore, 1.606,00 euro di IVA all'Erario.", // allow-italian: fixture data, shown as written
  },
];

/* ---------- Turni irrigui (7) ---------- */

/** The lines of the request form of the site, with what the requester wrote; the rest is the same for everyone. */
const irrigationForm = (applicant: string, comune: string, parcel: string, basin: string, crop: string, area: string, days: string, method: string, signed: string): string[] => [
  'RICHIESTA DI TURNO IRRIGUO · modulo del sito del Consorzio, per gli utenti della rete irrigua collettiva', // allow-italian: fixture data, shown as written
  `Richiedente: ${applicant}`, // allow-italian: fixture data, shown as written
  `Comune: ${comune}`, // allow-italian: fixture data, shown as written
  `Foglio e particella: ${parcel}`, // allow-italian: fixture data, shown as written
  `Bacino di irrigazione ${basin} (numerazione di esempio)`, // allow-italian: fixture data, shown as written
  `Coltura: ${crop}`, // allow-italian: fixture data, shown as written
  `Superficie da irrigare: ${area}`, // allow-italian: fixture data, shown as written
  `Giorni richiesti: ${days}`, // allow-italian: fixture data, shown as written
  `Metodo: ${method}`, // allow-italian: fixture data, shown as written
  `Inviata il ${signed}`, // allow-italian: fixture data, shown as written
];

const IRRIGATION: OrbitCard[] = [
  {
    id: 'IR-2424', flow: 'nocera-irrigazione', step: 's1', // allow-italian: fixture data, shown as written
    title: 'Turno per il cavolfiore a Striano', // allow-italian: fixture data, shown as written
    detail: 'Striano · bacino n. 2 · 0,80 ha · lunedì 9 e martedì 10 novembre', place: 'Striano', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '10:20'), 'agent:ag-irrigazione')], // allow-italian: fixture data, shown as written
    worker: agentWorker('ag-irrigazione', 'legge la richiesta: bacino, particella, coltura e giorni', at('11-06', '10:21')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-irrigazione', due: '2026-11-09', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('modulo', 'Richiesta di turno, cavolfiore a Striano', 'form', 'modulo del sito', at('11-06', '10:19'), irrigationForm( // allow-italian: fixture data, shown as written
        'Azienda agricola Esempio Striano s.s.', 'Striano', 'foglio 11, particella 87', 'n. 2', 'cavolfiore', '0,80 ha', // allow-italian: fixture data, shown as written
        'lunedì 9 e martedì 10 novembre 2026, dalle 6 alle 12', 'a goccia', '06/11/2026 alle 10:19', // allow-italian: fixture data, shown as written
      )),
    ],
    values: [
      read('Bacino', 'n. 2', 'modulo', 'Bacino di irrigazione n. 2', 96), // allow-italian: fixture data, shown as written
      read('Particella', 'Striano, foglio 11, particella 87', 'modulo', 'foglio 11, particella 87', 97), // allow-italian: fixture data, shown as written
      read('Coltura', 'cavolfiore', 'modulo', 'Coltura: cavolfiore', 99), // allow-italian: fixture data, shown as written
      read('Giorni richiesti', '9 e 10 novembre, ore 6-12', 'modulo', 'lunedì 9 e martedì 10 novembre 2026, dalle 6 alle 12', 94), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Controllare bacino e particella in Prunes, poi proporre lunedì 9 novembre alle 6 se il bacino è libero.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'IR-2423', flow: 'nocera-irrigazione', step: 's2', // allow-italian: fixture data, shown as written
    title: 'Turno per gli spinaci a Pagani, particella di un altro', // allow-italian: fixture data, shown as written
    detail: 'Pagani · bacino n. 6 · 1,00 ha · particella intestata a un altro nome', place: 'Pagani', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '15:30'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-05', '15:40'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-irrigazione', 'ha chiesto la delega del proprietario al richiedente', at('11-05', '16:40')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-irrigazione', due: '2026-11-10', priority: 'normale', // allow-italian: fixture data, shown as written
    blocked: { reason: 'la particella è intestata a un altro nome in Prunes: chiesta la delega del proprietario al richiedente', since: at('11-05', '16:40') }, // allow-italian: fixture data, shown as written
    originals: [
      paper('modulo', 'Richiesta di turno, spinaci a Pagani', 'form', 'modulo del sito', at('11-05', '15:29'), irrigationForm( // allow-italian: fixture data, shown as written
        'Orto Esempio di un affittuario', 'Pagani', 'foglio 8, particella 402', 'n. 6', 'spinaci', '1,00 ha', // allow-italian: fixture data, shown as written
        'martedì 10 e mercoledì 11 novembre 2026, dalle 12 alle 18', 'a pioggia', '05/11/2026 alle 15:29', // allow-italian: fixture data, shown as written
      )),
    ],
    values: [
      read('Bacino', 'n. 6', 'modulo', 'Bacino di irrigazione n. 6', 96), // allow-italian: fixture data, shown as written
      read('Particella', 'Pagani, foglio 8, particella 402', 'modulo', 'foglio 8, particella 402', 82), // allow-italian: fixture data, shown as written
      read('Coltura', 'spinaci', 'modulo', 'Coltura: spinaci', 99), // allow-italian: fixture data, shown as written
      read('Richiedente', 'affittuario, non il proprietario', 'modulo', 'Richiedente: Orto Esempio di un affittuario', 70), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Con la delega del proprietario: turno martedì 10 novembre dalle 12 alle 18, avviso al richiedente.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'IR-2422', flow: 'nocera-irrigazione', step: 's4', // allow-italian: fixture data, shown as written
    title: 'Turno per la lattuga a Scafati', // allow-italian: fixture data, shown as written
    detail: 'Scafati · bacino n. 5 · 0,60 ha · mercoledì 11 e giovedì 12 novembre', place: 'Scafati', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '08:55'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-06', '09:00'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-irrigazione', 'sceglie giorno e ora fra i turni liberi del bacino n. 5', at('11-06', '09:10')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-irrigazione', due: '2026-11-11', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('modulo', 'Richiesta di turno, lattuga a Scafati', 'form', 'modulo del sito', at('11-06', '08:54'), irrigationForm( // allow-italian: fixture data, shown as written
        'Ortaggi Esempio s.s.', 'Scafati', 'foglio 3, particella 156', 'n. 5', 'lattuga', '0,60 ha', // allow-italian: fixture data, shown as written
        'mercoledì 11 e giovedì 12 novembre 2026, dalle 6 alle 12', 'a pioggia', '06/11/2026 alle 08:54', // allow-italian: fixture data, shown as written
      )),
    ],
    values: [
      read('Bacino', 'n. 5', 'modulo', 'Bacino di irrigazione n. 5', 96), // allow-italian: fixture data, shown as written
      read('Particella', 'Scafati, foglio 3, particella 156', 'modulo', 'foglio 3, particella 156', 96), // allow-italian: fixture data, shown as written
      read('Coltura', 'lattuga', 'modulo', 'Coltura: lattuga', 99), // allow-italian: fixture data, shown as written
      read('Giorni richiesti', '11 e 12 novembre, ore 6-12', 'modulo', 'mercoledì 11 e giovedì 12 novembre 2026, dalle 6 alle 12', 94), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Turno mercoledì 11 novembre dalle 6 alle 12 al pozzo del bacino; nessuno sovrapposto negli stessi giorni.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'IR-2421', flow: 'nocera-irrigazione', step: 's5', // allow-italian: fixture data, shown as written
    title: 'Turno per i broccoli a San Marzano sul Sarno, in parte sovrapposto', // allow-italian: fixture data, shown as written
    detail: 'San Marzano sul Sarno · bacino n. 4 · 1,40 ha · giovedì 12 novembre', place: 'San Marzano sul Sarno', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-04', '15:20'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-04', '15:30'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-05', '09:00'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-irrigazione', 'decide se spostare il turno alle 12 per non sovrapporlo', at('11-05', '10:15')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-irrigazione', due: '2026-11-12', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('modulo', 'Richiesta di turno, broccoli a San Marzano', 'form', 'modulo del sito', at('11-04', '15:19'), irrigationForm( // allow-italian: fixture data, shown as written
        'Fratelli Esempio s.s.', 'San Marzano sul Sarno', 'foglio 14, particella 63', 'n. 4', 'broccoli', '1,40 ha', // allow-italian: fixture data, shown as written
        'giovedì 12 novembre 2026, dalle 6 alle 12', 'a pioggia', '04/11/2026 alle 15:19', // allow-italian: fixture data, shown as written
      )),
      paper('calendario', 'Calendario dei turni del bacino n. 4', 'sheet', 'calendario dei turni', at('11-05', '08:58'), [ // allow-italian: fixture data, shown as written
        'Bacino n. 4 · giovedì 12/11/2026', // allow-italian: fixture data, shown as written
        'Turno già assegnato: dalle 6 alle 10, pozzo n. 12 (San Valentino Torio)', // allow-italian: fixture data, shown as written
        'Libero dalle 10', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Bacino', 'n. 4', 'modulo', 'Bacino di irrigazione n. 4', 96), // allow-italian: fixture data, shown as written
      read('Particella', 'San Marzano sul Sarno, foglio 14, particella 63', 'modulo', 'foglio 14, particella 63', 96), // allow-italian: fixture data, shown as written
      read('Coltura', 'broccoli', 'modulo', 'Coltura: broccoli', 99), // allow-italian: fixture data, shown as written
      read('Turni sovrapposti', '1, dalle 6 alle 10', 'calendario', 'Turno già assegnato: dalle 6 alle 10, pozzo n. 12', 81), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Spostare il turno a giovedì 12 novembre dalle 10 alle 16, quando il pozzo è libero, e avvisare il richiedente.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'IR-2419', flow: 'nocera-irrigazione', step: 's6', // allow-italian: fixture data, shown as written
    title: 'Turno di domenica per una serra a Poggiomarino', // allow-italian: fixture data, shown as written
    detail: 'Poggiomarino · bacino n. 3 · 0,50 ha · domenica 8 novembre, fuori calendario', place: 'Poggiomarino', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '11:15'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-05', '11:25'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-05', '14:40'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('11-05', '17:20'), 'cn-irrigazione'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-dg', 'deve approvare un turno di domenica, fuori dal calendario', at('11-05', '17:20')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-dg', due: '2026-11-07', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('modulo', 'Richiesta di turno, serra a Poggiomarino', 'form', 'modulo del sito', at('11-05', '11:14'), irrigationForm( // allow-italian: fixture data, shown as written
        'Serre Esempio s.s.', 'Poggiomarino', 'foglio 6, particella 221', 'n. 3', 'ortaggi in serra', '0,50 ha', // allow-italian: fixture data, shown as written
        'domenica 8 novembre 2026, dalle 6 alle 10', 'a goccia', '05/11/2026 alle 11:14', // allow-italian: fixture data, shown as written
      )),
    ],
    values: [
      read('Bacino', 'n. 3', 'modulo', 'Bacino di irrigazione n. 3', 96), // allow-italian: fixture data, shown as written
      read('Particella', 'Poggiomarino, foglio 6, particella 221', 'modulo', 'foglio 6, particella 221', 96), // allow-italian: fixture data, shown as written
      read('Giorni richiesti', 'domenica 8 novembre, ore 6-10', 'modulo', 'domenica 8 novembre 2026, dalle 6 alle 10', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Il pozzo è libero domenica dalle 6 alle 10 e il tecnico del bacino ha verificato: serve solo la tua approvazione, i turni di domenica sono fuori calendario.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'IR-2415', flow: 'nocera-irrigazione', step: 's7', // allow-italian: fixture data, shown as written
    title: 'Turno per gli spinaci a Boscoreale, assegnato', // allow-italian: fixture data, shown as written
    detail: 'Boscoreale · bacino n. 7 · 0,90 ha · mercoledì 4 novembre', place: 'Boscoreale', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-03', '07:50'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-03', '07:55'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-03', '11:10'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
      entry('fatto', at('11-04', '09:20'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-irrigazione', 'ha aggiornato il calendario e mandato un SMS al richiedente', at('11-04', '09:20')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-irrigazione', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('modulo', 'Richiesta di turno, spinaci a Boscoreale', 'form', 'modulo del sito', at('11-03', '07:49'), irrigationForm( // allow-italian: fixture data, shown as written
        'Agricola Esempio Vesuvio s.s.', 'Boscoreale', 'foglio 2, particella 330', 'n. 7', 'spinaci', '0,90 ha', // allow-italian: fixture data, shown as written
        'mercoledì 4 novembre 2026, dalle 6 alle 12', 'a pioggia', '03/11/2026 alle 07:49', // allow-italian: fixture data, shown as written
      )),
    ],
    values: [
      read('Bacino', 'n. 7', 'modulo', 'Bacino di irrigazione n. 7', 96), // allow-italian: fixture data, shown as written
      read('Particella', 'Boscoreale, foglio 2, particella 330', 'modulo', 'foglio 2, particella 330', 96), // allow-italian: fixture data, shown as written
      read('Coltura', 'spinaci', 'modulo', 'Coltura: spinaci', 99), // allow-italian: fixture data, shown as written
      read('Giorni richiesti', 'mercoledì 4 novembre, ore 6-12', 'modulo', 'mercoledì 4 novembre 2026, dalle 6 alle 12', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Turno assegnato come chiesto, mercoledì 4 novembre dalle 6 alle 12; SMS inviato al richiedente.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'IR-2414', flow: 'nocera-irrigazione', step: 's7', // allow-italian: fixture data, shown as written
    title: 'Turno per il finocchio a San Valentino Torio, assegnato', // allow-italian: fixture data, shown as written
    detail: 'San Valentino Torio · bacino n. 4 · 1,20 ha · pozzo n. 12 · 4 e 5 novembre', place: 'San Valentino Torio', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-02', '08:50'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-02', '08:55'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-02', '12:00'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
      entry('fatto', at('11-03', '14:05'), 'agent:ag-irrigazione'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-irrigazione', 'ha aggiornato il calendario e avvisato il richiedente', at('11-03', '14:05')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-irrigazione', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('modulo', 'Richiesta di turno, finocchio a San Valentino Torio', 'form', 'modulo del sito', at('11-02', '08:49'), irrigationForm( // allow-italian: fixture data, shown as written
        'Ortofrutticola Esempio s.s.', 'San Valentino Torio', 'foglio 5, particella 318', 'n. 4', 'finocchio', '1,20 ha', // allow-italian: fixture data, shown as written
        'mercoledì 4 e giovedì 5 novembre 2026, dalle 6 alle 12', 'a pioggia', '02/11/2026 alle 08:49', // allow-italian: fixture data, shown as written
      )),
    ],
    values: [
      read('Bacino', 'n. 4', 'modulo', 'Bacino di irrigazione n. 4', 96), // allow-italian: fixture data, shown as written
      read('Particella', 'San Valentino Torio, foglio 5, particella 318', 'modulo', 'foglio 5, particella 318', 97), // allow-italian: fixture data, shown as written
      read('Coltura', 'finocchio', 'modulo', 'Coltura: finocchio', 99), // allow-italian: fixture data, shown as written
      read('Giorni richiesti', '4 e 5 novembre, ore 6-12', 'modulo', 'mercoledì 4 e giovedì 5 novembre 2026, dalle 6 alle 12', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Turno assegnato come chiesto, con il pozzo n. 12; avviso al richiedente.', // allow-italian: fixture data, shown as written
  },
];

/* ---------- Segnalazioni dal territorio (8) ---------- allow-italian: quotes the words on screen */

const REPORTS: OrbitCard[] = [
  {
    id: 'SG-2424', flow: 'nocera-segnalazioni', step: 's1', // allow-italian: fixture data, shown as written
    title: 'Rifiuti e ramaglie nel Canale Fosso Imperatore', // allow-italian: fixture data, shown as written
    detail: 'Nocera Inferiore · mail della polizia locale · tratto accanto al parcheggio del mercato', place: 'Nocera Inferiore', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '10:12'), 'agent:ag-segnalazioni')], // allow-italian: fixture data, shown as written
    worker: agentWorker('ag-segnalazioni', 'legge la mail: luogo, canale e tipo di problema', at('11-06', '10:13')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-tecnico', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('mail', 'Mail della polizia locale', 'mail', 'mail del Comune', at('11-06', '10:11'), [ // allow-italian: fixture data, shown as written
        'Da: polizia.locale@x.example.it', // allow-italian: fixture data, shown as written
        'Oggetto: rifiuti e ramaglie nel Canale Fosso Imperatore, tratto accanto al parcheggio del mercato', // allow-italian: fixture data, shown as written
        'Nei controlli di stamattina abbiamo trovato sacchi di rifiuti e ramaglie che ostruiscono metà della sezione del canale.', // allow-italian: fixture data, shown as written
        'Chiediamo la rimozione prima del mercato di sabato.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Luogo', 'Nocera Inferiore, accanto al parcheggio del mercato', 'mail', 'tratto accanto al parcheggio del mercato', 91), // allow-italian: fixture data, shown as written
      read('Canale', 'Canale Fosso Imperatore', 'mail', 'Canale Fosso Imperatore', 98), // allow-italian: fixture data, shown as written
      read('Tipo di problema', 'rifiuti e ramaglie in alveo', 'mail', 'sacchi di rifiuti e ramaglie che ostruiscono metà della sezione del canale', 93), // allow-italian: fixture data, shown as written
      read('Entro', 'prima del mercato di sabato 07/11', 'mail', 'prima del mercato di sabato', 85), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Squadra di manutenzione domani mattina, prima del mercato; i rifiuti dei sacchi vanno poi al Comune.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-2423', flow: 'nocera-segnalazioni', step: 's3', // allow-italian: fixture data, shown as written
    title: 'Schiuma e pesci morti nel Canale Bottaro', // allow-italian: fixture data, shown as written
    detail: 'Scafati · telefonata di un residente · vicino al ponte della ferrovia', place: 'Scafati', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '09:58'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-06', '10:05'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-segnalazioni', 'localizza il tratto sulla mappa del reticolo', at('11-06', '10:05')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-tecnico', priority: 'alta', // allow-italian: fixture data, shown as written
    originals: [
      paper('telefonata', 'Telefonata al Consorzio', 'call', 'telefono del Consorzio', at('11-06', '09:57'), [ // allow-italian: fixture data, shown as written
        'Telefonata delle 09:52, durata 4 minuti, operatore del Consorzio', // allow-italian: fixture data, shown as written
        'Un residente di Scafati segnala una schiuma bianca e un forte odore nel Canale Bottaro, vicino al ponte della ferrovia.', // allow-italian: fixture data, shown as written
        'Dice che succede da ieri sera e che ci sono pesci morti.', // allow-italian: fixture data, shown as written
        'Ha lasciato il numero per essere richiamato.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Luogo', 'Scafati, vicino al ponte della ferrovia', 'telefonata', 'vicino al ponte della ferrovia', 74), // allow-italian: fixture data, shown as written
      read('Canale', 'Canale Bottaro', 'telefonata', 'nel Canale Bottaro', 96), // allow-italian: fixture data, shown as written
      read('Tipo di problema', 'possibile scarico inquinante', 'telefonata', 'una schiuma bianca e un forte odore', 85), // allow-italian: fixture data, shown as written
      read('Da quando', 'da ieri sera', 'telefonata', 'succede da ieri sera', 90), // allow-italian: fixture data, shown as written
    ],
    proposal: "Sopralluogo oggi del Tecnico con l'ufficiale idraulico: se è uno scarico, il verbale passa a Polizia idraulica.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-2422', flow: 'nocera-segnalazioni', step: 's2', // allow-italian: fixture data, shown as written
    title: 'Griglia del Canale Torello, seconda segnalazione', // allow-italian: fixture data, shown as written
    detail: 'Castel San Giorgio · WhatsApp · stessa griglia di SG-2420', place: 'Castel San Giorgio', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '09:55'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-06', '09:57'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-segnalazioni', 'confronta il luogo con le segnalazioni già aperte', at('11-06', '09:58')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-tecnico', priority: 'alta', // allow-italian: fixture data, shown as written
    originals: [
      paper('whatsapp', 'WhatsApp di un residente', 'mail', 'WhatsApp del Consorzio', at('11-06', '09:55'), [ // allow-italian: fixture data, shown as written
        "09:55 Buongiorno, la griglia sul Canale Torello a Castel San Giorgio è piena e l'acqua arriva sulla strada del ponticello.", // allow-italian: fixture data, shown as written
        '09:56 Posizione condivisa: Castel San Giorgio, ponticello sul Canale Torello (posizione di esempio)', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Canale', 'Canale Torello', 'whatsapp', 'la griglia sul Canale Torello', 97), // allow-italian: fixture data, shown as written
      read('Luogo', 'Castel San Giorgio, ponticello sul Canale Torello', 'whatsapp', 'Castel San Giorgio, ponticello sul Canale Torello', 96), // allow-italian: fixture data, shown as written
      read('Tipo di problema', 'griglia piena, acqua sulla strada', 'whatsapp', "l'acqua arriva sulla strada del ponticello", 92), // allow-italian: fixture data, shown as written
    ],
    proposal: 'È la stessa griglia di SG-2420: unire le due segnalazioni e rispondere che la squadra è in arrivo.', // allow-italian: fixture data, shown as written
    links: { card: 'SG-2420' }, // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-2418', flow: 'nocera-segnalazioni', step: 's4', // allow-italian: fixture data, shown as written
    title: 'Vegetazione e detriti nel Torrente Solofrana', // allow-italian: fixture data, shown as written
    detail: 'Mercato San Severino · mail della protezione civile comunale · a monte della Vasca Ciorani', place: 'Mercato San Severino', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '06:50'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-06', '07:05'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-segnalazioni', 'sceglie la squadra e la priorità del sopralluogo', at('11-06', '07:05')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-tecnico', due: '2026-11-09', priority: 'alta', // allow-italian: fixture data, shown as written
    originals: [
      paper('mail', 'Mail della protezione civile comunale', 'mail', 'mail del Comune', at('11-06', '06:49'), [ // allow-italian: fixture data, shown as written
        'Da: protezione.civile@x.example.it', // allow-italian: fixture data, shown as written
        'Oggetto: vegetazione e detriti in alveo, Torrente Solofrana, a monte della Vasca Ciorani', // allow-italian: fixture data, shown as written
        "Il tratto interessato è lungo circa 400 metri e la sezione si è ridotta in modo evidente dopo le piogge.", // allow-italian: fixture data, shown as written
        "Con l'allerta meteo prevista per domenica si teme un'esondazione alla prossima piena.", // allow-italian: fixture data, shown as written
        "Si chiede un intervento entro lunedì.", // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Luogo', 'a monte della Vasca Ciorani, Mercato San Severino', 'mail', 'a monte della Vasca Ciorani', 95), // allow-italian: fixture data, shown as written
      read('Canale', 'Torrente Solofrana', 'mail', 'Torrente Solofrana', 98), // allow-italian: fixture data, shown as written
      read('Tipo di problema', 'vegetazione e detriti in alveo', 'mail', 'vegetazione e detriti in alveo', 97), // allow-italian: fixture data, shown as written
      read('Tratto del canale', 'circa 400 metri', 'mail', 'lungo circa 400 metri', 82), // allow-italian: fixture data, shown as written
      read('Entro', 'lunedì 09/11', 'mail', 'Si chiede un intervento entro lunedì.', 94), // allow-italian: fixture data, shown as written
    ],
    proposal: "Squadra con taglio della vegetazione e un escavatore lunedì 9 novembre, prima dell'allerta; priorità alta.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-2420', flow: 'nocera-segnalazioni', step: 's5', // allow-italian: fixture data, shown as written
    title: 'Griglia ostruita sul Canale Torello, acqua sulla strada', // allow-italian: fixture data, shown as written
    detail: 'Castel San Giorgio · WhatsApp del Consorzio · ponticello sul Canale Torello', place: 'Castel San Giorgio', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '07:46'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-06', '07:55'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-06', '08:30'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-tecnico', "verifica l'urgenza: acqua sulla strada e un cortile allagato", at('11-06', '09:30')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-tecnico', due: '2026-11-07', priority: 'alta', // allow-italian: fixture data, shown as written
    originals: [
      paper('whatsapp', 'WhatsApp di un cittadino', 'mail', 'WhatsApp del Consorzio', at('11-06', '07:46'), [ // allow-italian: fixture data, shown as written
        'Cittadino (esempio) · canale WhatsApp del Consorzio · venerdì 6 novembre 2026', // allow-italian: fixture data, shown as written
        "07:46 Buongiorno, scrivo per segnalare che a Castel San Giorgio la griglia del Canale Torello sotto il ponticello è completamente ostruita da rami e plastica. L'acqua è uscita sulla strada.", // allow-italian: fixture data, shown as written
        '07:47 foto di esempio · griglia ostruita e acqua sulla strada', // allow-italian: fixture data, shown as written
        '07:48 Posizione condivisa: Castel San Giorgio, ponticello sul Canale Torello (posizione di esempio)', // allow-italian: fixture data, shown as written
        "07:49 Stanotte ha piovuto molto e le auto passano a fatica. C'è anche un'abitazione con il cortile allagato.", // allow-italian: fixture data, shown as written
        '07:52 Consorzio: grazie, la segnalazione è registrata con il numero 2420. Un operatore la prende in carico in giornata. Per un pericolo immediato chiami il 112.', // allow-italian: fixture data, shown as written
        "08:05 Grazie. La squadra di manutenzione farà il sopralluogo entro domani mattina. Se l'acqua sale ancora, ci scriva qui.", // allow-italian: fixture data, shown as written
        '08:07 Adesso è ferma, ma la griglia è ancora piena.', // allow-italian: fixture data, shown as written
      ]),
      paper('foto', 'Foto della griglia', 'photo', 'allegato su WhatsApp', at('11-06', '07:47'), [ // allow-italian: fixture data, shown as written
        'Foto: griglia del Canale Torello sotto il ponticello, ostruita da rami e plastica; acqua sulla carreggiata.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Luogo', 'Castel San Giorgio, ponticello sul Canale Torello', 'whatsapp', 'Castel San Giorgio, ponticello sul Canale Torello', 96), // allow-italian: fixture data, shown as written
      read('Canale', 'Canale Torello', 'whatsapp', 'la griglia del Canale Torello', 98), // allow-italian: fixture data, shown as written
      read('Tipo di problema', 'griglia ostruita, acqua sulla strada', 'whatsapp', 'completamente ostruita da rami e plastica', 95), // allow-italian: fixture data, shown as written
      read('Danni', 'un cortile allagato', 'whatsapp', "un'abitazione con il cortile allagato", 84), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Squadra di manutenzione sul posto oggi per liberare la griglia, senza aspettare domani mattina; priorità alta per il cortile allagato.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-2419', flow: 'nocera-segnalazioni', step: 's6', // allow-italian: fixture data, shown as written
    title: 'Frana di sponda sul Canale Lauro, intervento fuori programma', // allow-italian: fixture data, shown as written
    detail: 'Castel San Giorgio · rapporto del sorvegliante · 14.600,00 euro stimati', place: 'Castel San Giorgio', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-05', '17:40'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-05', '17:50'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-06', '08:15'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('11-06', '09:20'), 'cn-tecnico'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-dg', 'deve approvare un intervento fuori programma da 14.600 euro', at('11-06', '09:20')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-dg', due: '2026-11-09', priority: 'alta', // allow-italian: fixture data, shown as written
    originals: [
      paper('rapporto', 'Rapporto del sorvegliante', 'sheet', 'sorvegliante di Castel San Giorgio', at('11-05', '17:38'), [ // allow-italian: fixture data, shown as written
        'Rapporto del sorvegliante di Castel San Giorgio, 05/11/2026', // allow-italian: fixture data, shown as written
        'Canale Lauro, sponda sinistra: franato un tratto di circa 12 metri, la sezione si è ridotta di un terzo.', // allow-italian: fixture data, shown as written
        'Serve il ripristino con escavatore e posa di massi: 3 giorni di lavoro con la squadra.', // allow-italian: fixture data, shown as written
        'Costo stimato: 14.600,00 euro, fuori dal programma di manutenzione.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Luogo', 'Canale Lauro, sponda sinistra', 'rapporto', 'Canale Lauro, sponda sinistra', 97), // allow-italian: fixture data, shown as written
      read('Tipo di problema', 'frana di sponda, circa 12 metri', 'rapporto', 'franato un tratto di circa 12 metri', 95), // allow-italian: fixture data, shown as written
      read('Squadra', 'squadra di manutenzione con escavatore a noleggio, 3 giorni', 'rapporto', '3 giorni di lavoro con la squadra', 88), // allow-italian: fixture data, shown as written
      read('Costo stimato', '14.600,00 euro', 'rapporto', 'Costo stimato: 14.600,00 euro', 96), // allow-italian: fixture data, shown as written
    ],
    proposal: "Intervento da lunedì 9 novembre con l'escavatore del noleggio in corso; il Tecnico ha verificato, serve la tua approvazione perché è fuori programma.", // allow-italian: fixture data, shown as written
    links: { contract: 'ct-noleggio-escavatori' }, // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-2416', flow: 'nocera-segnalazioni', step: 's4', // allow-italian: fixture data, shown as written
    title: 'Cedimento di sponda del Torrente Lavinaio, fondo privato', // allow-italian: fixture data, shown as written
    detail: 'Bracigliano · telefonata del Comune · intervento di difesa del suolo', place: 'Bracigliano', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-03', '08:40'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-03', '08:50'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-tecnico', "aspetta l'autorizzazione del proprietario per entrare nel fondo", at('11-04', '11:30')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-tecnico', due: '2026-11-05', priority: 'alta', // allow-italian: fixture data, shown as written
    blocked: { reason: "il tratto è dentro un fondo privato: serve l'autorizzazione del proprietario, chiesta al Comune il 04/11", since: at('11-04', '11:30') }, // allow-italian: fixture data, shown as written
    originals: [
      paper('telefonata', 'Telefonata del Comune di Bracigliano', 'call', 'telefono del Consorzio', at('11-03', '08:38'), [ // allow-italian: fixture data, shown as written
        "Telefonata delle 08:31, durata 5 minuti, il responsabile dell'area tecnica del Comune", // allow-italian: fixture data, shown as written
        'Segnala un cedimento della sponda destra del Torrente Lavinaio per circa 15 metri, a pochi metri da una strada comunale.', // allow-italian: fixture data, shown as written
        "Il tratto è dentro un fondo privato; il Comune chiede un intervento prima delle prossime piogge.", // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Luogo', 'Bracigliano, sponda destra', 'telefonata', 'sponda destra del Torrente Lavinaio', 92), // allow-italian: fixture data, shown as written
      read('Canale', 'Torrente Lavinaio', 'telefonata', 'Torrente Lavinaio', 98), // allow-italian: fixture data, shown as written
      read('Tipo di problema', 'cedimento di sponda, circa 15 metri', 'telefonata', 'per circa 15 metri', 90), // allow-italian: fixture data, shown as written
      read('Tratto del canale', 'dentro un fondo privato', 'telefonata', 'Il tratto è dentro un fondo privato', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: "Appena c'è l'accesso al fondo: ripristino della sponda come difesa del suolo, con la squadra e l'escavatore già previsti dalla convenzione.", // allow-italian: fixture data, shown as written
    links: { contract: 'ct-convenzione-difesa-suolo' }, // allow-italian: fixture data, shown as written
  },
  {
    id: 'SG-2415', flow: 'nocera-segnalazioni', step: 's7', // allow-italian: fixture data, shown as written
    title: 'Plastica e rami nel Canale dei Mulini, ripulito', // allow-italian: fixture data, shown as written
    detail: 'Castel San Giorgio · mail di un residente · squadra intervenuta il 04/11', place: 'Castel San Giorgio', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-03', '12:05'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-03', '12:15'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-03', '15:20'), 'agent:ag-segnalazioni'), // allow-italian: fixture data, shown as written
      entry('fatto', at('11-04', '16:10'), 'cn-tecnico'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-tecnico', 'ha chiuso dopo il passaggio della squadra e risposto a chi ha segnalato', at('11-04', '16:10')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-tecnico', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('mail', 'Mail di un residente', 'mail', 'mail del residente', at('11-03', '12:04'), [ // allow-italian: fixture data, shown as written
        'Da: residente.esempio@x.example.it', // allow-italian: fixture data, shown as written
        'Oggetto: plastica e rami nel Canale dei Mulini', // allow-italian: fixture data, shown as written
        'Passando lungo il Canale dei Mulini, a Castel San Giorgio, ho visto molta plastica e rami che si fermano sotto il ponte della strada comunale.', // allow-italian: fixture data, shown as written
        'Vi chiedo di intervenire prima che arrivino le piogge.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Luogo', 'Castel San Giorgio, ponte della strada comunale', 'mail', 'sotto il ponte della strada comunale', 92), // allow-italian: fixture data, shown as written
      read('Canale', 'Canale dei Mulini', 'mail', 'Canale dei Mulini', 98), // allow-italian: fixture data, shown as written
      read('Tipo di problema', 'plastica e rami', 'mail', 'molta plastica e rami', 94), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Fatto il 04/11: la squadra ha ripulito il tratto e il Tecnico ha risposto al residente con le foto del dopo.', // allow-italian: fixture data, shown as written
  },
];

/* ---------- Concessioni idrauliche (4) ---------- */

const CONCESSIONS: OrbitCard[] = [
  {
    id: 'CO-2398', flow: 'nocera-concessioni', step: 's7', // allow-italian: fixture data, shown as written
    title: 'Attraversamento del Canale Lauro con una tubazione', // allow-italian: fixture data, shown as written
    detail: "Castel San Giorgio · società (esempio) · canone 380,00 euro l'anno · parere favorevole", place: 'Castel San Giorgio', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-19', '10:10'), 'agent:ag-concessioni'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-19', '10:20'), 'agent:ag-concessioni'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-03', '15:40'), 'agent:ag-concessioni'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('11-05', '12:00'), 'cn-tecnico'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-dg', 'deve firmare la concessione con il parere favorevole del Tecnico', at('11-05', '12:00')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-dg', due: '2026-11-13', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('disciplinare', 'Disciplinare di concessione, bozza', 'letter', "bozza dell'agente", at('11-05', '11:30'), [ // allow-italian: fixture data, shown as written
        'Disciplinare di concessione n. 12/2026: attraversamento del Canale Lauro con una tubazione, Castel San Giorgio', // allow-italian: fixture data, shown as written
        'Concessionario: Idrica Esempio S.r.l.', // allow-italian: fixture data, shown as written
        'Il concessionario versa un canone annuo di euro 380,00', // allow-italian: fixture data, shown as written
        "Il concessionario è tenuto alla manutenzione dell'opera e solleva il Consorzio da ogni responsabilità.", // allow-italian: fixture data, shown as written
      ]),
      paper('parere', 'Parere del Tecnico dopo il sopralluogo', 'letter', 'Tecnico e manutenzione', at('11-03', '15:30'), [ // allow-italian: fixture data, shown as written
        'Parere del Tecnico, sopralluogo del 03/11/2026 sul Canale Lauro', // allow-italian: fixture data, shown as written
        'Parere favorevole, con la prescrizione di posare la tubazione sotto il fondo del canale.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Opera', 'attraversamento con tubazione', 'disciplinare', 'attraversamento del Canale Lauro con una tubazione', 96), // allow-italian: fixture data, shown as written
      read('Canale', 'Canale Lauro', 'disciplinare', 'Canale Lauro', 98), // allow-italian: fixture data, shown as written
      read('Richiedente', 'Idrica Esempio S.r.l.', 'disciplinare', 'Concessionario: Idrica Esempio S.r.l.', 97), // allow-italian: fixture data, shown as written
      read('Canone', "380,00 euro l'anno", 'disciplinare', 'canone annuo di euro 380,00', 94), // allow-italian: fixture data, shown as written
      read('Parere', 'favorevole, tubazione sotto il fondo del canale', 'parere', 'Parere favorevole, con la prescrizione di posare la tubazione sotto il fondo del canale', 96), // allow-italian: fixture data, shown as written
    ],
    proposal: "Firmare la concessione con la prescrizione del Tecnico e inviarla via PEC; il canone è di 380,00 euro l'anno.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'CO-2392', flow: 'nocera-concessioni', step: 's4', // allow-italian: fixture data, shown as written
    title: 'Scarico di acque piovane nel Canale Fosso Imperatore', // allow-italian: fixture data, shown as written
    detail: 'Nocera Inferiore · capannoni (esempio) · tavole DWG senza la quota di scarico', place: 'Nocera Inferiore', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-03', '09:30'), 'agent:ag-concessioni'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-04', '15:00'), 'agent:ag-concessioni'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-concessioni', 'legge le tavole DWG e verifica la quota di scarico', at('11-04', '15:00')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-tecnico', due: '2026-12-03', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('richiesta', 'Richiesta di scarico', 'letter', 'PEC della società', at('11-03', '09:29'), [ // allow-italian: fixture data, shown as written
        'Oggetto: richiesta di concessione per lo scarico delle acque meteoriche del piazzale nel Canale Fosso Imperatore, Nocera Inferiore', // allow-italian: fixture data, shown as written
        'Richiedente: Capannoni Esempio S.r.l., proprietaria del fondo al foglio 17, particella 340', // allow-italian: fixture data, shown as written
        'Lo scarico avviene con un tubo da 400 mm; si allegano le tavole in formato DWG.', // allow-italian: fixture data, shown as written
      ]),
      paper('tavole', 'Tavola 2 in formato DWG', 'sheet', 'allegato alla PEC', at('11-03', '09:29'), [ // allow-italian: fixture data, shown as written
        'Tavola 2, pianta e sezione dello scarico (file DWG)', // allow-italian: fixture data, shown as written
        'Quota del fondo del canale: indicata', // allow-italian: fixture data, shown as written
        'Quota di scarico sul ciglio: non indicata', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Opera', 'scarico di acque meteoriche con tubo da 400 mm', 'richiesta', 'Lo scarico avviene con un tubo da 400 mm', 94), // allow-italian: fixture data, shown as written
      read('Canale', 'Canale Fosso Imperatore', 'richiesta', 'Canale Fosso Imperatore', 98), // allow-italian: fixture data, shown as written
      read('Richiedente', 'Capannoni Esempio S.r.l.', 'richiesta', 'Capannoni Esempio S.r.l.', 97), // allow-italian: fixture data, shown as written
      read('Documenti mancanti', 'quota di scarico sul ciglio', 'tavole', 'Quota di scarico sul ciglio: non indicata', 80), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Chiedere alla società la quota di scarico sul ciglio; il termine del procedimento resta sospeso fino a quando arriva.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'CO-2386', flow: 'nocera-concessioni', step: 's6', // allow-italian: fixture data, shown as written
    title: 'Ponticello carrabile sul Canale Macchione', // allow-italian: fixture data, shown as written
    detail: 'Castel San Giorgio · società agricola (esempio) · foglio 9, particella 512 · integrazioni ricevute', place: 'Castel San Giorgio', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-14', '10:22'), 'agent:ag-concessioni'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-14', '10:30'), 'agent:ag-concessioni'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-04', '10:00'), 'agent:ag-concessioni'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-tecnico', 'prepara il sopralluogo di lunedì 9 novembre sul Canale Macchione', at('11-05', '09:20')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-tecnico', due: '2026-11-25', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('domanda', 'Domanda di concessione, protocollo 2026/0017488', 'letter', 'PEC della società', at('10-14', '10:22'), [ // allow-italian: fixture data, shown as written
        'Prot. n. 2026/0017488 del 14/10/2026', // allow-italian: fixture data, shown as written
        'Oggetto: domanda di concessione per la realizzazione di un attraversamento del Canale Macchione con ponticello carrabile, in Comune di Castel San Giorgio.', // allow-italian: fixture data, shown as written
        'SOCIETÀ AGRICOLA ESEMPIO S.r.l., proprietaria del fondo censito al Catasto terreni del Comune di Castel San Giorgio al foglio 9, particella 512', // allow-italian: fixture data, shown as written
        "ponticello carrabile in calcestruzzo armato, di luce netta 4,00 m e larghezza 5,00 m, per l'accesso dei mezzi agricoli al fondo", // allow-italian: fixture data, shown as written
        'ai sensi del R.D. 368/1904 e del Regolamento di Polizia Idraulica del Consorzio', // allow-italian: fixture data, shown as written
      ]),
      paper('integrazione', 'Integrazione ricevuta il 03/11', 'letter', 'PEC della società', at('11-03', '12:15'), [ // allow-italian: fixture data, shown as written
        'Integrazioni alla domanda prot. n. 2026/0017488, ricevute il 03/11/2026', // allow-italian: fixture data, shown as written
        'Trasmessi: sezione trasversale quotata, verifica idraulica della sezione di deflusso, titolo di proprietà delle aree su entrambe le sponde.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Opera', 'ponticello carrabile in calcestruzzo, luce 4,00 m, larghezza 5,00 m', 'domanda', 'di luce netta 4,00 m e larghezza 5,00 m', 96), // allow-italian: fixture data, shown as written
      read('Canale', 'Canale Macchione', 'domanda', 'Canale Macchione', 98), // allow-italian: fixture data, shown as written
      read('Particella', 'Castel San Giorgio, foglio 9, particella 512', 'domanda', 'foglio 9, particella 512', 97), // allow-italian: fixture data, shown as written
      read('Richiedente', 'Società agricola Esempio S.r.l.', 'domanda', 'SOCIETÀ AGRICOLA ESEMPIO S.r.l.', 97), // allow-italian: fixture data, shown as written
      read('Documenti mancanti', 'nessuno dopo il 03/11', 'integrazione', 'sezione trasversale quotata, verifica idraulica della sezione di deflusso, titolo di proprietà', 90), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Sopralluogo lunedì 9 novembre e parere entro la decisione del 25/11; con le integrazioni la domanda è completa.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'CO-2380', flow: 'nocera-concessioni', step: 's8', // allow-italian: fixture data, shown as written
    title: 'Scarico nel Canale Mulino Pagano, concessione rilasciata', // allow-italian: fixture data, shown as written
    detail: 'Mercato San Severino · impresa (esempio) · concessione 9/2026 · protocollo 2026/0018290', place: 'Mercato San Severino', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('09-22', '11:00'), 'agent:ag-concessioni'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('09-22', '11:10'), 'agent:ag-concessioni'), // allow-italian: fixture data, shown as written
      entry('verifica', at('10-27', '10:30'), 'agent:ag-concessioni'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('10-30', '09:45'), 'cn-tecnico'), // allow-italian: fixture data, shown as written
      entry('fatto', at('11-03', '11:30'), 'agent:ag-concessioni'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-concessioni', "ha inviato la concessione via PEC e l'ha protocollata in Halley", at('11-03', '11:30')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-tecnico', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('concessione', 'Concessione 9/2026, scarico nel Canale Mulino Pagano', 'letter', 'Direzione, firmata', at('11-03', '11:00'), [ // allow-italian: fixture data, shown as written
        'Concessione n. 9/2026: scarico di acque meteoriche nel Canale Mulino Pagano, Mercato San Severino', // allow-italian: fixture data, shown as written
        'Concessionario: Edilizia Esempio S.r.l.', // allow-italian: fixture data, shown as written
        'Canone annuo: euro 290,00', // allow-italian: fixture data, shown as written
        'Firmata digitalmente dalla Direzione il 03/11/2026 · protocollo 2026/0018290', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Opera', 'scarico di acque meteoriche', 'concessione', 'scarico di acque meteoriche nel Canale Mulino Pagano', 96), // allow-italian: fixture data, shown as written
      read('Canale', 'Canale Mulino Pagano', 'concessione', 'Canale Mulino Pagano', 98), // allow-italian: fixture data, shown as written
      read('Richiedente', 'Edilizia Esempio S.r.l.', 'concessione', 'Concessionario: Edilizia Esempio S.r.l.', 97), // allow-italian: fixture data, shown as written
      read('Canone', "290,00 euro l'anno", 'concessione', 'Canone annuo: euro 290,00', 95), // allow-italian: fixture data, shown as written
      read('Numero di protocollo', '2026/0018290', 'concessione', 'protocollo 2026/0018290', 97), // allow-italian: fixture data, shown as written
    ],
    proposal: "Concessione firmata e inviata via PEC il 03/11: il canone di 290,00 euro l'anno passa alla Ragioneria.", // allow-italian: fixture data, shown as written
  },
];

/* ---------- Polizia idraulica (4) ---------- */

/** The opening of every report of the ufficiale idraulico (the authority of hydraulic police since L.R. 7/2025, art. 10 c.2). */
const officerOpening = (day: string, hour: string, stream: string, comune: string) =>
  `Il giorno ${day} 2026, alle ore ${hour}, l'ufficiale idraulico del Consorzio di Bonifica Integrale Comprensorio Sarno, Autorità di Polizia Idraulica ai sensi dell'art. 10, comma 2, della L.R. Campania 7/2025, durante il servizio di vigilanza sul ${stream} in Comune di ${comune}, ha accertato`; // allow-italian: fixture data, shown as written

const POLICE: OrbitCard[] = [
  {
    id: 'VP-2401', flow: 'nocera-polizia', step: 's4', // allow-italian: fixture data, shown as written
    title: 'Rifiuti in alveo, trasgressore senza indirizzo', // allow-italian: fixture data, shown as written
    detail: "Pagani · verbale 40/2026 · Alveo Comune Nocerino · notifica entro il 25/01/2027", place: 'Pagani', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-02', '09:05'), 'agent:ag-polizia'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-02', '09:20'), 'agent:ag-polizia'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-polizia', "aspetta dal Comune l'indirizzo di residenza del trasgressore", at('11-03', '12:00')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-polizia', due: '2027-01-25', priority: 'normale', // allow-italian: fixture data, shown as written
    blocked: { reason: "il trasgressore non ha un domicilio digitale: chiesto l'indirizzo di residenza al Comune di Pagani il 03/11", since: at('11-03', '12:00') }, // allow-italian: fixture data, shown as written
    originals: [
      paper('verbale', 'Verbale di accertamento n. 40/2026', 'letter', "ufficiale idraulico", at('11-02', '09:04'), [ // allow-italian: fixture data, shown as written
        'VERBALE DI ACCERTAMENTO DI VIOLAZIONE AMMINISTRATIVA n. 40/2026', // allow-italian: fixture data, shown as written
        officerOpening('27 ottobre', '08:50', 'tratto di Alveo Comune Nocerino', 'Pagani'), // allow-italian: fixture data, shown as written
        "il deposito di circa 3 metri cubi di rifiuti ingombranti e di inerti nell'alveo, sulla sponda sinistra, scaricati da un furgone (esempio) riconosciuto dalla targa.", // allow-italian: fixture data, shown as written
        "Il fatto viola il Regolamento di Polizia Idraulica del Consorzio, che vieta il deposito di rifiuti nell'alveo e sulle sponde.", // allow-italian: fixture data, shown as written
        "Il presente verbale sarà notificato al trasgressore entro 90 giorni dall'accertamento (art. 14 L. 689/1981), tramite la piattaforma SEND.", // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Violazione', "deposito di circa 3 metri cubi di rifiuti nell'alveo", 'verbale', "il deposito di circa 3 metri cubi di rifiuti ingombranti e di inerti nell'alveo", 94), // allow-italian: fixture data, shown as written
      read('Norma violata', 'Regolamento di Polizia Idraulica del Consorzio', 'verbale', 'Il fatto viola il Regolamento di Polizia Idraulica del Consorzio', 90), // allow-italian: fixture data, shown as written
      read('Soggetto', 'proprietario del furgone, identificato dalla targa', 'verbale', 'riconosciuto dalla targa', 76), // allow-italian: fixture data, shown as written
      read('Termine di notifica', 'entro 25/01/2027', 'verbale', "entro 90 giorni dall'accertamento", 86), // allow-italian: fixture data, shown as written
    ],
    proposal: "Notifica via SEND appena c'è l'indirizzo; senza domicilio digitale la notifica passa per posta e la scadenza del 25/01 resta quella.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'VP-2395', flow: 'nocera-polizia', step: 's6', // allow-italian: fixture data, shown as written
    title: 'Smovimento di terreno a 2 metri dal ciglio del Torrente Lavinaio', // allow-italian: fixture data, shown as written
    detail: 'Bracigliano · verbale 37/2026 · impresa edile (esempio) · notifica entro il 18/01/2027', place: 'Bracigliano', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-21', '09:15'), 'agent:ag-polizia'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-21', '09:30'), 'agent:ag-polizia'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-04', '09:00'), 'agent:ag-polizia'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-legale', 'verifica la norma citata e la sanzione prima della firma', at('11-05', '10:10')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-legale', due: '2027-01-18', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('verbale', 'Verbale di accertamento n. 37/2026', 'letter', 'ufficiale idraulico', at('10-21', '09:15'), [ // allow-italian: fixture data, shown as written
        'Prot. n. 2026/0017764 del 21/10/2026', // allow-italian: fixture data, shown as written
        'VERBALE DI ACCERTAMENTO DI VIOLAZIONE AMMINISTRATIVA n. 37/2026', // allow-italian: fixture data, shown as written
        officerOpening('20 ottobre', '10:40', 'Torrente Lavinaio', 'Bracigliano'), // allow-italian: fixture data, shown as written
        'in sponda destra, in corrispondenza del fondo censito al foglio 7, particella 233, il deposito di materiale inerte e lo smovimento del terreno a una distanza di circa 2 metri dal ciglio della sponda, per un tratto di circa 25 metri.', // allow-italian: fixture data, shown as written
        'Il fatto viola l\'art. 96, lettera f), del R.D. 523/1904, che vieta lo smovimento del terreno a distanza inferiore a 4 metri dal ciglio.', // allow-italian: fixture data, shown as written
        "Dalle visure il fondo risulta di proprietà di un'impresa edile (esempio), qui indicata come trasgressore.", // allow-italian: fixture data, shown as written
        "Il presente verbale sarà notificato al trasgressore entro 90 giorni dall'accertamento (art. 14 L. 689/1981), tramite la piattaforma SEND.", // allow-italian: fixture data, shown as written
        'La sanzione è determinata secondo la L.R. Campania 13/1983.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Violazione', 'smovimento del terreno a circa 2 metri dal ciglio, per circa 25 metri', 'verbale', 'lo smovimento del terreno a una distanza di circa 2 metri dal ciglio della sponda', 94), // allow-italian: fixture data, shown as written
      read('Norma violata', 'art. 96 lettera f) del R.D. 523/1904, minimo 4 metri', 'verbale', "Il fatto viola l'art. 96, lettera f), del R.D. 523/1904", 95), // allow-italian: fixture data, shown as written
      read('Soggetto', 'impresa edile (esempio), proprietaria del fondo', 'verbale', "Dalle visure il fondo risulta di proprietà di un'impresa edile (esempio)", 88), // allow-italian: fixture data, shown as written
      read('Tratto del canale', 'Bracigliano, foglio 7, particella 233, sponda destra', 'verbale', 'foglio 7, particella 233', 96), // allow-italian: fixture data, shown as written
      read('Termine di notifica', 'entro 18/01/2027', 'verbale', "entro 90 giorni dall'accertamento", 86), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Verbale completo di norma e termini: notifica via SEND entro il 18/01/2027; la sanzione la fissa la L.R. 13/1983.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'VP-2402', flow: 'nocera-polizia', step: 's7', // allow-italian: fixture data, shown as written
    title: 'Scarico non autorizzato nel Canale Buonaiuto', // allow-italian: fixture data, shown as written
    detail: 'San Marzano sul Sarno · verbale 41/2026 · officina (esempio) · notifica entro il 26/01/2027', place: 'San Marzano sul Sarno', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-29', '09:00'), 'agent:ag-polizia'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-29', '09:10'), 'agent:ag-polizia'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-03', '10:00'), 'agent:ag-polizia'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('11-05', '11:00'), 'cn-legale'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-dg', 'deve firmare la notifica del verbale via SEND', at('11-05', '11:00')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-dg', due: '2027-01-26', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('verbale', 'Verbale di accertamento n. 41/2026', 'letter', 'ufficiale idraulico', at('10-29', '08:55'), [ // allow-italian: fixture data, shown as written
        'VERBALE DI ACCERTAMENTO DI VIOLAZIONE AMMINISTRATIVA n. 41/2026', // allow-italian: fixture data, shown as written
        officerOpening('28 ottobre', '09:15', 'Canale Buonaiuto', 'San Marzano sul Sarno'), // allow-italian: fixture data, shown as written
        "uno scarico di acque di lavaggio di un'officina (esempio) direttamente nel canale, senza concessione.", // allow-italian: fixture data, shown as written
        'Il fatto viola il R.D. 368/1904 e il Regolamento di Polizia Idraulica del Consorzio, che vietano lo scarico nei canali senza concessione.', // allow-italian: fixture data, shown as written
        "Il presente verbale sarà notificato al trasgressore entro 90 giorni dall'accertamento (art. 14 L. 689/1981), tramite la piattaforma SEND.", // allow-italian: fixture data, shown as written
        'La sanzione è determinata secondo la L.R. Campania 13/1983.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Violazione', "scarico di acque di lavaggio di un'officina nel canale, senza concessione", 'verbale', "uno scarico di acque di lavaggio di un'officina (esempio) direttamente nel canale, senza concessione", 93), // allow-italian: fixture data, shown as written
      read('Norma violata', 'R.D. 368/1904 e Regolamento di Polizia Idraulica', 'verbale', 'Il fatto viola il R.D. 368/1904 e il Regolamento di Polizia Idraulica del Consorzio', 90), // allow-italian: fixture data, shown as written
      read('Tratto del canale', 'Canale Buonaiuto, San Marzano sul Sarno', 'verbale', 'sul Canale Buonaiuto in Comune di San Marzano sul Sarno', 96), // allow-italian: fixture data, shown as written
      read('Sanzione', 'secondo la L.R. Campania 13/1983', 'verbale', 'La sanzione è determinata secondo la L.R. Campania 13/1983.', 85), // allow-italian: fixture data, shown as written
      read('Termine di notifica', 'entro 26/01/2027', 'verbale', "entro 90 giorni dall'accertamento", 86), // allow-italian: fixture data, shown as written
    ],
    proposal: "L'ufficiale idraulico e il Legale hanno verificato: firma della notifica via SEND, che parte appena firmata.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'VP-2399', flow: 'nocera-polizia', step: 's8', // allow-italian: fixture data, shown as written
    title: 'Fascia di rispetto del Canale Torello occupata, notificata con SEND', // allow-italian: fixture data, shown as written
    detail: 'Castel San Giorgio · verbale 35/2026 · impresa (esempio) · notifica del 03/11', place: 'Castel San Giorgio', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-13', '09:20'), 'agent:ag-polizia'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-13', '09:35'), 'agent:ag-polizia'), // allow-italian: fixture data, shown as written
      entry('verifica', at('10-26', '10:00'), 'agent:ag-polizia'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('10-30', '12:00'), 'cn-legale'), // allow-italian: fixture data, shown as written
      entry('fatto', at('11-03', '16:40'), 'agent:ag-polizia'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-polizia', 'ha notificato il verbale con SEND e segnato la data di perfezionamento', at('11-03', '16:40')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-polizia', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('verbale', 'Verbale di accertamento n. 35/2026', 'letter', 'ufficiale idraulico', at('10-13', '09:15'), [ // allow-italian: fixture data, shown as written
        'VERBALE DI ACCERTAMENTO DI VIOLAZIONE AMMINISTRATIVA n. 35/2026', // allow-italian: fixture data, shown as written
        officerOpening('12 ottobre', '11:20', 'Canale Torello', 'Castel San Giorgio'), // allow-italian: fixture data, shown as written
        "l'occupazione della fascia di rispetto di 4 metri con un deposito di materiali edili (esempio), senza autorizzazione.", // allow-italian: fixture data, shown as written
      ]),
      paper('send', 'Attestazione SEND', 'form', 'SEND', at('11-03', '16:40'), [ // allow-italian: fixture data, shown as written
        'SEND · Servizio Notifiche Digitali · notifica presa in carico', // allow-italian: fixture data, shown as written
        'Mittente Consorzio di Bonifica Integrale Comprensorio Sarno', // allow-italian: fixture data, shown as written
        'Oggetto Verbale di accertamento n. 35/2026', // allow-italian: fixture data, shown as written
        'Presa in carico 03/11/2026 16:35', // allow-italian: fixture data, shown as written
        'La notifica si perfeziona per il destinatario il settimo giorno successivo alla consegna al domicilio digitale, oppure prima, se accede alla piattaforma (art. 26 D.L. 76/2020).', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Violazione', 'occupazione della fascia di rispetto con materiali edili', 'verbale', "l'occupazione della fascia di rispetto di 4 metri con un deposito di materiali edili", 94), // allow-italian: fixture data, shown as written
      read('Tratto del canale', 'Canale Torello, Castel San Giorgio', 'verbale', 'sul Canale Torello in Comune di Castel San Giorgio', 96), // allow-italian: fixture data, shown as written
      read('Notifica', 'presa in carico da SEND il 03/11/2026 alle 16:35', 'send', 'Presa in carico 03/11/2026 16:35', 99), // allow-italian: fixture data, shown as written
      read('Data di perfezionamento', 'il settimo giorno dopo la consegna', 'send', 'il settimo giorno successivo alla consegna al domicilio digitale', 85), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Notificato il 03/11: gli scritti difensivi si aspettano per 30 giorni dal perfezionamento.', // allow-italian: fixture data, shown as written
  },
];

/* ---------- Contributi e sgravi (5) ---------- */

const CONTRIBUTIONS: OrbitCard[] = [
  {
    id: 'RC-2425', flow: 'nocera-contributi', step: 's1', // allow-italian: fixture data, shown as written
    title: 'Sgravio per un terreno espropriato', // allow-italian: fixture data, shown as written
    detail: 'Roccapiemonte · proprietario (esempio) · avviso 2026/0054410/01 · 96,30 euro', place: 'Roccapiemonte', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '09:40'), 'agent:ag-contributi')], // allow-italian: fixture data, shown as written
    worker: agentWorker('ag-contributi', "legge l'istanza: contribuente, tributo, anno e richiesta", at('11-06', '09:41')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-catasto', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('istanza', 'Istanza di sgravio, terreno espropriato', 'letter', 'PEC del proprietario', at('11-06', '09:38'), [ // allow-italian: fixture data, shown as written
        'Oggetto: istanza di sgravio del contributo consortile 2026, terreno espropriato', // allow-italian: fixture data, shown as written
        'Avviso di pagamento n. 2026/0054410/01 del 30/09/2026, codice contribuente C-0054410, euro 96,30', // allow-italian: fixture data, shown as written
        "Il terreno al foglio 4, particella 118, è stato espropriato con decreto del 22/06/2025 per la realizzazione di una strada.", // allow-italian: fixture data, shown as written
        "Chiede lo sgravio totale dell'avviso.", // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Contribuente', 'codice C-0054410', 'istanza', 'codice contribuente C-0054410', 97), // allow-italian: fixture data, shown as written
      read('Tributo', 'contributo consortile', 'istanza', 'contributo consortile 2026', 96), // allow-italian: fixture data, shown as written
      read('Anno', '2026', 'istanza', 'contributo consortile 2026', 98), // allow-italian: fixture data, shown as written
      read('Richiesta', 'sgravio totale per esproprio del 22/06/2025', 'istanza', 'espropriato con decreto del 22/06/2025', 90), // allow-italian: fixture data, shown as written
    ],
    proposal: "Cercare in Prunes il contribuente e la particella; se il decreto è anteriore all'avviso 2026, sgravio totale di 96,30 euro.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'RC-2422', flow: 'nocera-contributi', step: 's4', // allow-italian: fixture data, shown as written
    title: 'Sgravio parziale per una superficie sbagliata', // allow-italian: fixture data, shown as written
    detail: 'Fisciano · avviso 2026/0028871/01 · 178,50 euro · superficie 0.32.00 ha invece di 0.52.00', place: 'Fisciano', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-04', '10:00'), 'agent:ag-contributi'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-05', '14:05'), 'agent:ag-contributi'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-contributi', 'ricalcola il contributo sulla superficie della visura e scrive la bozza', at('11-05', '14:05')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-catasto', due: '2026-12-04', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('istanza', 'Istanza di sgravio parziale', 'letter', 'PEC del proprietario', at('11-04', '09:58'), [ // allow-italian: fixture data, shown as written
        'Oggetto: istanza di sgravio parziale del contributo 2026 per errata superficie', // allow-italian: fixture data, shown as written
        'Avviso n. 2026/0028871/01, codice contribuente C-0028871, importo euro 178,50', // allow-italian: fixture data, shown as written
        "L'avviso riporta una superficie di 0.52.00 ettari; la visura catastale aggiornata indica 0.32.00 ettari.", // allow-italian: fixture data, shown as written
        'Terreno a Fisciano, foglio 19, particella 76.', // allow-italian: fixture data, shown as written
      ]),
      paper('conteggio', "Conteggio preparato dall'agente", 'sheet', 'agente contributi e sgravi', at('11-05', '14:20'), [ // allow-italian: fixture data, shown as written
        'Conteggio sulla superficie della visura, 0.32.00 ettari', // allow-italian: fixture data, shown as written
        'Contributo ricalcolato: 109,85 euro · sgravio di 68,65 euro', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Contribuente', 'codice C-0028871', 'istanza', 'codice contribuente C-0028871', 97), // allow-italian: fixture data, shown as written
      read('Anno', '2026', 'istanza', 'contributo 2026', 98), // allow-italian: fixture data, shown as written
      read('Richiesta', 'sgravio parziale per superficie errata', 'istanza', 'istanza di sgravio parziale del contributo 2026 per errata superficie', 95), // allow-italian: fixture data, shown as written
      read('Immobili', 'Fisciano, foglio 19, particella 76, 0.32.00 ettari', 'istanza', 'la visura catastale aggiornata indica 0.32.00 ettari', 90), // allow-italian: fixture data, shown as written
      read('Importo dovuto', '109,85 euro, sgravio di 68,65 euro', 'conteggio', 'Contributo ricalcolato: 109,85 euro', 88), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Sgravio parziale di 68,65 euro sulla superficie corretta; la bozza del provvedimento è pronta per la verifica del Catasto e ruoli.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'RC-2416', flow: 'nocera-contributi', step: 's5', // allow-italian: fixture data, shown as written
    title: 'Sgravio 2026 per un terreno venduto nel 2025', // allow-italian: fixture data, shown as written
    detail: 'Mercato San Severino · Immobiliare Esempio S.r.l. · avviso 2026/0063390/01 · 217,40 euro', place: 'Mercato San Severino', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-04', '11:37'), 'agent:ag-contributi'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-04', '11:50'), 'agent:ag-contributi'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-05', '16:20'), 'agent:ag-contributi'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-catasto', 'confronta la trascrizione del 20/03/2025 con la visura e con Prunes', at('11-06', '09:00')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-catasto', due: '2026-12-04', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('istanza', 'Istanza di sgravio e voltura', 'letter', 'PEC della società', at('11-04', '11:37'), [ // allow-italian: fixture data, shown as written
        'IMMOBILIARE ESEMPIO S.r.l., Mercato San Severino (SA)', // allow-italian: fixture data, shown as written
        'Oggetto: istanza di sgravio del contributo consortile 2026 e richiesta di voltura. Avviso di pagamento n. 2026/0063390/01 del 30/09/2026, codice contribuente C-0063390.', // allow-italian: fixture data, shown as written
        'relativo al contributo consortile per l\'anno 2026 di euro 217,40, riferito al terreno censito al Catasto terreni del Comune di Mercato San Severino, foglio 22, particella 1187', // allow-italian: fixture data, shown as written
        'il terreno è stato venduto con atto di compravendita del 12/03/2025, trascritto presso il Servizio di Pubblicità Immobiliare di Salerno il 20/03/2025', // allow-italian: fixture data, shown as written
        "chiede lo sgravio totale dell'avviso n. 2026/0063390/01 e la voltura della partita all'acquirente indicato nell'atto allegato.", // allow-italian: fixture data, shown as written
      ]),
      paper('visura', 'Visura catastale aggiornata', 'sheet', 'allegato alla PEC', at('11-04', '11:37'), [ // allow-italian: fixture data, shown as written
        'Visura storica per immobile · Mercato San Severino, foglio 22, particella 1187', // allow-italian: fixture data, shown as written
        'Intestato dal 12/03/2025 a: acquirente (esempio)', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Contribuente', 'Immobiliare Esempio S.r.l., codice C-0063390', 'istanza', 'codice contribuente C-0063390', 98), // allow-italian: fixture data, shown as written
      read('Avviso di pagamento', '2026/0063390/01, 217,40 euro', 'istanza', 'Avviso di pagamento n. 2026/0063390/01 del 30/09/2026', 97), // allow-italian: fixture data, shown as written
      read('Immobili', 'Mercato San Severino, foglio 22, particella 1187', 'istanza', 'foglio 22, particella 1187', 97), // allow-italian: fixture data, shown as written
      read('Richiesta', "sgravio totale e voltura all'acquirente", 'istanza', "chiede lo sgravio totale dell'avviso n. 2026/0063390/01", 95), // allow-italian: fixture data, shown as written
      read('Vendita', 'atto del 12/03/2025, trascritto il 20/03/2025', 'istanza', 'atto di compravendita del 12/03/2025', 94), // allow-italian: fixture data, shown as written
      read('Intestatario attuale', 'dal 12/03/2025, acquirente', 'visura', 'Intestato dal 12/03/2025', 92), // allow-italian: fixture data, shown as written
    ],
    proposal: "Sgravio totale di 217,40 euro e voltura della partita all'acquirente: all'emissione dell'avviso 2026 la società non era più proprietaria.", // allow-italian: fixture data, shown as written
  },
  {
    id: 'RC-2419', flow: 'nocera-contributi', step: 's6', // allow-italian: fixture data, shown as written
    title: 'Diniego di sgravio, fondo servito dal Canale Fraina', // allow-italian: fixture data, shown as written
    detail: 'Sarno · azienda agricola (esempio) · contributo 2025 · 284,00 euro confermati', place: 'Sarno', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-30', '10:20'), 'agent:ag-contributi'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-30', '10:30'), 'agent:ag-contributi'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-03', '09:00'), 'agent:ag-contributi'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('11-05', '10:40'), 'cn-catasto'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-dg', 'deve firmare il diniego di sgravio', at('11-05', '10:40')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-dg', due: '2026-11-30', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('istanza', 'Istanza di sgravio', 'letter', "PEC dell'azienda", at('10-30', '10:19'), [ // allow-italian: fixture data, shown as written
        'Oggetto: istanza di sgravio del contributo consortile 2025, codice contribuente C-0031207', // allow-italian: fixture data, shown as written
        'Il fondo di Sarno, foglio 12, particella 95, non trarrebbe alcun vantaggio dalle opere del Consorzio.', // allow-italian: fixture data, shown as written
        'Chiede lo sgravio totale del contributo di euro 284,00.', // allow-italian: fixture data, shown as written
      ]),
      paper('bozza', 'Bozza del diniego', 'letter', "bozza dell'agente", at('11-03', '08:50'), [ // allow-italian: fixture data, shown as written
        'Provvedimento di diniego di sgravio, contributo 2025, codice contribuente C-0031207', // allow-italian: fixture data, shown as written
        'Il fondo ricade nel perimetro di contribuenza e il suo scolo è servito dal Canale Fraina: si nega lo sgravio e si conferma l\'importo di euro 284,00.', // allow-italian: fixture data, shown as written
        'Contro il provvedimento è ammesso ricorso alla Corte di giustizia tributaria di primo grado di Salerno entro 60 giorni dalla notifica.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Contribuente', 'codice C-0031207', 'istanza', 'codice contribuente C-0031207', 97), // allow-italian: fixture data, shown as written
      read('Anno', '2025', 'istanza', 'contributo consortile 2025', 98), // allow-italian: fixture data, shown as written
      read('Richiesta', 'sgravio totale di 284,00 euro', 'istanza', 'Chiede lo sgravio totale del contributo di euro 284,00', 96), // allow-italian: fixture data, shown as written
      read('Motivo', 'il fondo non trarrebbe vantaggio dalle opere', 'istanza', 'non trarrebbe alcun vantaggio dalle opere del Consorzio', 90), // allow-italian: fixture data, shown as written
      read('Importo dovuto', '284,00 euro, confermato', 'bozza', "si conferma l'importo di euro 284,00", 93), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Diniego motivato: il fondo è nel perimetro di contribuenza e servito dal Canale Fraina; il Catasto e ruoli ha verificato, serve la tua firma.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'RC-2404', flow: 'nocera-contributi', step: 's7', // allow-italian: fixture data, shown as written
    title: 'Rimborso notificato con SEND, contributo pagato due volte', // allow-italian: fixture data, shown as written
    detail: 'Nocera Superiore · Impresa Esempio S.r.l. · 342,60 euro · notifica perfezionata il 12/11', place: 'Nocera Superiore', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-26', '10:40'), 'agent:ag-contributi'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-26', '10:50'), 'agent:ag-contributi'), // allow-italian: fixture data, shown as written
      entry('verifica', at('10-29', '15:00'), 'agent:ag-contributi'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('11-03', '11:00'), 'cn-catasto'), // allow-italian: fixture data, shown as written
      entry('fatto', at('11-04', '15:30'), 'agent:ag-contributi'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-contributi', "ha notificato il provvedimento con SEND e passato l'ordine di pagamento alla Ragioneria", at('11-04', '15:30')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-catasto', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('provvedimento', 'Provvedimento di rimborso, protocollo 2026/0018318', 'letter', 'Direzione, firmato', at('11-03', '11:00'), [ // allow-italian: fixture data, shown as written
        'Prot. n. 2026/0018318 del 03/11/2026', // allow-italian: fixture data, shown as written
        'Oggetto: provvedimento di rimborso del contributo consortile 2025 versato due volte. Vostra istanza prot. n. 2026/0017983 del 26/10/2026, codice contribuente C-0057104.', // allow-italian: fixture data, shown as written
        "accertato in Prunes che l'avviso risulta pagato il 14/04/2026 e di nuovo il 16/04/2026, per euro 342,60 ciascuna volta;", // allow-italian: fixture data, shown as written
        'il rimborso di euro 342,60 a favore della Impresa Esempio S.r.l., mediante bonifico sul conto indicato nell\'istanza, entro 30 giorni dalla notifica del presente provvedimento.', // allow-italian: fixture data, shown as written
      ]),
      paper('send', 'Attestazione SEND', 'form', 'SEND', at('11-05', '09:03'), [ // allow-italian: fixture data, shown as written
        'SEND · Servizio Notifiche Digitali · attestazione opponibile ai terzi', // allow-italian: fixture data, shown as written
        'Oggetto Provvedimento di rimborso del contributo consortile 2025', // allow-italian: fixture data, shown as written
        'Presa in carico 04/11/2026 15:22', // allow-italian: fixture data, shown as written
        'Consegna al domicilio digitale 05/11/2026 09:03', // allow-italian: fixture data, shown as written
        'La notifica si perfeziona per il destinatario il settimo giorno successivo alla consegna al domicilio digitale, oppure prima, se accede alla piattaforma (art. 26 D.L. 76/2020).', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Contribuente', 'Impresa Esempio S.r.l., codice C-0057104', 'provvedimento', 'codice contribuente C-0057104', 98), // allow-italian: fixture data, shown as written
      read('Anno', '2025', 'provvedimento', 'contributo consortile 2025', 98), // allow-italian: fixture data, shown as written
      read('Importo dovuto', 'rimborso di 342,60 euro', 'provvedimento', 'il rimborso di euro 342,60', 97), // allow-italian: fixture data, shown as written
      read('Pagato due volte', '14/04/2026 e 16/04/2026', 'provvedimento', "l'avviso risulta pagato il 14/04/2026 e di nuovo il 16/04/2026", 96), // allow-italian: fixture data, shown as written
      read('Notifica', 'consegnata il 05/11/2026 alle 09:03', 'send', 'Consegna al domicilio digitale 05/11/2026 09:03', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Notifica perfezionata il 12/11 (settimo giorno dopo la consegna del 05/11); il rimborso di 342,60 euro parte entro 30 giorni.', // allow-italian: fixture data, shown as written
  },
];

/* ---------- Personale (5) ---------- */

/** Every employee here is a matricola with a qualifica, never a name: they are examples. */
const STAFF: OrbitCard[] = [
  {
    id: 'PE-2406', flow: 'nocera-personale', step: 's1', // allow-italian: fixture data, shown as written
    title: 'Visita medica periodica in scadenza, operaio', // allow-italian: fixture data, shown as written
    detail: 'Matricola 0388 · operaio addetto ai canali (esempio) · scadenza 28/11/2026', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '07:00'), 'agent:ag-personale')], // allow-italian: fixture data, shown as written
    worker: agentWorker('ag-personale', 'ha letto da Publisys le scadenze di oggi', at('11-06', '07:00')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-personale', due: '2026-11-28', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('elenco', 'Elenco delle scadenze di Publisys', 'sheet', 'Publisys, ogni giorno alle 7', at('11-06', '07:00'), [ // allow-italian: fixture data, shown as written
        'Publisys · visite mediche e certificati · elenco del 06/11/2026, ore 07:00', // allow-italian: fixture data, shown as written
        'Matricola 0388, operaio addetto ai canali (esempio): visita medica periodica, scadenza 28/11/2026', // allow-italian: fixture data, shown as written
        'Ultima visita: 28/11/2025, idoneo senza limitazioni', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Dipendente', 'matricola 0388, operaio addetto ai canali', 'elenco', 'Matricola 0388, operaio addetto ai canali (esempio)', 97), // allow-italian: fixture data, shown as written
      read('Scadenza', '28/11/2026, visita medica periodica', 'elenco', 'visita medica periodica, scadenza 28/11/2026', 98), // allow-italian: fixture data, shown as written
      read('Ultima visita', '28/11/2025, idoneo', 'elenco', 'Ultima visita: 28/11/2025, idoneo senza limitazioni', 96), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Prenotare la visita dal medico competente entro il 20/11 e mandare la lettera al dipendente.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PE-2405', flow: 'nocera-personale', step: 's3', // allow-italian: fixture data, shown as written
    title: 'Contratto a termine in scadenza il 30/11, operaio', // allow-italian: fixture data, shown as written
    detail: 'Matricola 0431 · operaio addetto ai canali (esempio) · 12 mesi di contratto', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-06', '07:00'), 'agent:ag-personale'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-06', '07:05'), 'agent:ag-personale'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-personale', 'prepara la scheda della scadenza e la bozza di lettera', at('11-06', '07:05')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-personale', due: '2026-11-30', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('scheda', 'Scheda del contratto, da Publisys', 'sheet', 'Publisys', at('11-06', '07:00'), [ // allow-italian: fixture data, shown as written
        'Publisys · contratti a termine · elenco del 06/11/2026', // allow-italian: fixture data, shown as written
        'Matricola 0431, operaio addetto ai canali (esempio)', // allow-italian: fixture data, shown as written
        'Contratto a tempo determinato dal 01/12/2025 al 30/11/2026', // allow-italian: fixture data, shown as written
        'Durata fin qui: 12 mesi · scade fra 24 giorni', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Dipendente', 'matricola 0431, operaio addetto ai canali', 'scheda', 'Matricola 0431, operaio addetto ai canali (esempio)', 97), // allow-italian: fixture data, shown as written
      read('Contratto', 'a termine, dal 01/12/2025 al 30/11/2026', 'scheda', 'dal 01/12/2025 al 30/11/2026', 98), // allow-italian: fixture data, shown as written
      read('Durata fin qui', '12 mesi', 'scheda', 'Durata fin qui: 12 mesi', 98), // allow-italian: fixture data, shown as written
      read('Scadenza', '30/11/2026', 'scheda', 'scade fra 24 giorni', 92), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Scheda pronta per il Personale, che decide fra rinnovo, proroga o chiusura; la lettera segue la scelta.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PE-2404', flow: 'nocera-personale', step: 's4', // allow-italian: fixture data, shown as written
    title: 'Idoneità alla guida in scadenza, visita da prenotare', // allow-italian: fixture data, shown as written
    detail: 'Matricola 0215 · conducente di escavatore (esempio) · scadenza 20/11/2026', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-04', '07:00'), 'agent:ag-personale'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-04', '07:05'), 'agent:ag-personale'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-05', '08:10'), 'agent:ag-personale'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-personale', 'deve decidere se prenotare la visita o sospendere l\'uso del mezzo', at('11-05', '08:10')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-personale', due: '2026-11-20', priority: 'alta', // allow-italian: fixture data, shown as written
    originals: [
      paper('scheda', 'Scheda del certificato, da Publisys', 'sheet', 'Publisys', at('11-04', '07:00'), [ // allow-italian: fixture data, shown as written
        'Publisys · certificati · elenco del 04/11/2026', // allow-italian: fixture data, shown as written
        'Matricola 0215, conducente di escavatore (esempio): certificato di idoneità alla guida dei mezzi, scadenza 20/11/2026', // allow-italian: fixture data, shown as written
        'Senza il certificato rinnovato il dipendente non può guidare il mezzo dopo la scadenza.', // allow-italian: fixture data, shown as written
      ]),
      paper('lettera', 'Bozza di lettera al dipendente', 'letter', "bozza dell'agente", at('11-04', '07:30'), [ // allow-italian: fixture data, shown as written
        'Gentile dipendente, il certificato di idoneità alla guida dei mezzi scade il 20/11/2026.', // allow-italian: fixture data, shown as written
        'La visita presso il medico competente va fatta entro il 13/11/2026.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Dipendente', 'matricola 0215, conducente di escavatore', 'scheda', 'Matricola 0215, conducente di escavatore (esempio)', 97), // allow-italian: fixture data, shown as written
      read('Scadenza', '20/11/2026, certificato di idoneità alla guida', 'scheda', 'certificato di idoneità alla guida dei mezzi, scadenza 20/11/2026', 98), // allow-italian: fixture data, shown as written
      read('Visita entro', '13/11/2026', 'lettera', 'La visita presso il medico competente va fatta entro il 13/11/2026.', 92), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Rinnovo: prenotare la visita entro il 13/11 e consegnare la lettera; dopo il 20/11 il dipendente non può guidare il mezzo.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PE-2402', flow: 'nocera-personale', step: 's5', // allow-italian: fixture data, shown as written
    title: 'Proroga di sei mesi a un impiegato a termine', // allow-italian: fixture data, shown as written
    detail: 'Matricola 0507 · impiegato amministrativo (esempio) · da 12 a 18 mesi', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-30', '07:00'), 'agent:ag-personale'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-30', '07:05'), 'agent:ag-personale'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-04', '09:30'), 'agent:ag-personale'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('11-05', '17:30'), 'cn-personale'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-dg', 'deve approvare la proroga prima della lettera', at('11-05', '17:30')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-dg', due: '2026-11-30', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('scheda', 'Scheda del contratto, da Publisys', 'sheet', 'Publisys', at('10-30', '07:00'), [ // allow-italian: fixture data, shown as written
        'Publisys · contratti a termine · elenco del 30/10/2026', // allow-italian: fixture data, shown as written
        'Matricola 0507, impiegato amministrativo (esempio)', // allow-italian: fixture data, shown as written
        'Contratto a tempo determinato dal 01/12/2025 al 30/11/2026', // allow-italian: fixture data, shown as written
      ]),
      paper('decisione', 'Decisione del Personale', 'letter', 'Personale', at('11-05', '17:20'), [ // allow-italian: fixture data, shown as written
        'Il Personale propone la proroga di 6 mesi, fino al 31/05/2027.', // allow-italian: fixture data, shown as written
        'La proroga porta la durata complessiva a 18 mesi, sotto il limite di 24 mesi (art. 19 D.Lgs. 81/2015).', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Dipendente', 'matricola 0507, impiegato amministrativo', 'scheda', 'Matricola 0507, impiegato amministrativo (esempio)', 97), // allow-italian: fixture data, shown as written
      read('Scadenza', '30/11/2026', 'scheda', 'al 30/11/2026', 98), // allow-italian: fixture data, shown as written
      read('Proroga', '6 mesi, fino al 31/05/2027', 'decisione', 'proroga di 6 mesi, fino al 31/05/2027', 97), // allow-italian: fixture data, shown as written
      read('Durata complessiva', '18 mesi, limite di 24', 'decisione', 'durata complessiva a 18 mesi, sotto il limite di 24 mesi', 95), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Approvare la proroga fino al 31/05/2027: resta sotto il limite di 24 mesi e la lettera parte subito dopo.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'PE-2401', flow: 'nocera-personale', step: 's6', // allow-italian: fixture data, shown as written
    title: 'Fine di un contratto a termine, comunicazione obbligatoria inviata', // allow-italian: fixture data, shown as written
    detail: 'Matricola 0377 · operaio (esempio) · cessazione del 31/10/2026 · comunicazione del 03/11', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-02', '07:00'), 'agent:ag-personale'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-02', '07:05'), 'agent:ag-personale'), // allow-italian: fixture data, shown as written
      entry('verifica', at('10-02', '14:00'), 'agent:ag-personale'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('10-05', '10:00'), 'cn-personale'), // allow-italian: fixture data, shown as written
      entry('fatto', at('11-03', '10:00'), 'cn-personale'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-personale', 'ha consegnato la lettera e inviato la comunicazione obbligatoria di cessazione', at('11-03', '10:00')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-personale', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('ricevuta', 'Ricevuta della comunicazione obbligatoria', 'form', 'portale delle comunicazioni obbligatorie', at('11-03', '10:00'), [ // allow-italian: fixture data, shown as written
        'Comunicazione obbligatoria di cessazione del rapporto di lavoro, inviata il 03/11/2026', // allow-italian: fixture data, shown as written
        'Matricola 0377, operaio (esempio): cessazione del contratto a termine il 31/10/2026', // allow-italian: fixture data, shown as written
        'Datore di lavoro: Consorzio di Bonifica Integrale Comprensorio Sarno', // allow-italian: fixture data, shown as written
        'La comunicazione è dovuta entro 5 giorni dalla cessazione.', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Dipendente', 'matricola 0377, operaio', 'ricevuta', 'Matricola 0377, operaio (esempio)', 97), // allow-italian: fixture data, shown as written
      read('Scadenza', 'contratto cessato il 31/10/2026', 'ricevuta', 'cessazione del contratto a termine il 31/10/2026', 98), // allow-italian: fixture data, shown as written
      read('Comunicazione obbligatoria', 'cessazione, inviata il 03/11/2026', 'ricevuta', 'inviata il 03/11/2026', 98), // allow-italian: fixture data, shown as written
      read('Termine', 'entro 5 giorni dalla cessazione', 'ricevuta', 'entro 5 giorni dalla cessazione', 94), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Chiusa il 03/11, dentro i 5 giorni: la lettera è stata consegnata e la comunicazione è in archivio.', // allow-italian: fixture data, shown as written
  },
];

/* ---------- Contratti, gare e incarichi (6) ---------- */

const TENDERS: OrbitCard[] = [
  {
    id: 'CT-2398', flow: 'nocera-contratti', step: 's1', // allow-italian: fixture data, shown as written
    title: 'Schema di convenzione per la difesa del suolo a Siano', // allow-italian: fixture data, shown as written
    detail: 'Siano · Vallone Truda e Vallone Orneto · convenzione di 3 anni · 120.000,00 euro', place: 'Siano', // allow-italian: fixture data, shown as written
    history: [entry('arrivo', at('11-06', '09:50'), 'agent:ag-contratti')], // allow-italian: fixture data, shown as written
    worker: agentWorker('ag-contratti', 'legge lo schema: oggetto, importo, durata e obblighi', at('11-06', '09:51')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-legale', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('schema', 'Schema di convenzione, difesa del suolo', 'letter', 'PEC del Comune di Siano', at('11-06', '09:48'), [ // allow-italian: fixture data, shown as written
        "Oggetto: schema di convenzione per l'esercizio delle funzioni di difesa del suolo, ai sensi dell'art. 4 della L.R. Campania 7/2025", // allow-italian: fixture data, shown as written
        'Ambito: Vallone Truda e Vallone Orneto, Comune di Siano', // allow-italian: fixture data, shown as written
        'Durata: 3 anni dalla firma', // allow-italian: fixture data, shown as written
        'Importo massimo degli interventi: euro 120.000,00', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Oggetto', 'difesa del suolo sul Vallone Truda e sul Vallone Orneto', 'schema', 'Ambito: Vallone Truda e Vallone Orneto, Comune di Siano', 94), // allow-italian: fixture data, shown as written
      read('Importo', '120.000,00 euro', 'schema', 'Importo massimo degli interventi: euro 120.000,00', 96), // allow-italian: fixture data, shown as written
      read('Durata', '3 anni dalla firma', 'schema', 'Durata: 3 anni dalla firma', 97), // allow-italian: fixture data, shown as written
      read('Requisiti', 'funzioni delegate, art. 4 della L.R. 7/2025', 'schema', "ai sensi dell'art. 4 della L.R. Campania 7/2025", 90), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Confrontare lo schema con la convenzione già in vigore e preparare la bozza di determina per la firma della Direzione.', // allow-italian: fixture data, shown as written
    links: { contract: 'ct-convenzione-difesa-suolo' }, // allow-italian: fixture data, shown as written
  },
  {
    id: 'CT-2403', flow: 'nocera-contratti', step: 's5', // allow-italian: fixture data, shown as written
    title: "Primo incarico del lotto 1 dell'accordo quadro di ingegneria", // allow-italian: fixture data, shown as written
    detail: 'Canale Lauro · progettazione esecutiva del ripristino della sponda · 38.500,00 euro', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-03', '10:00'), 'agent:ag-contratti'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-04', '10:00'), 'agent:ag-contratti'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-contratti', 'scrive la bozza di determina con oggetto, importo e CIG derivato', at('11-04', '10:05')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-legale', due: '2026-11-16', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('richiesta', 'Richiesta di incarico del Tecnico', 'mail', 'Tecnico e manutenzione', at('11-03', '09:58'), [ // allow-italian: fixture data, shown as written
        "Oggetto: richiesta di incarico sul lotto 1 dell'accordo quadro per i servizi di ingegneria 2026-2028", // allow-italian: fixture data, shown as written
        'Servizio: progettazione esecutiva del ripristino della sponda del Canale Lauro, Castel San Giorgio', // allow-italian: fixture data, shown as written
        'Importo stimato: euro 38.500,00, oltre cassa previdenziale e IVA · CIG derivato B7C21A94D3', // allow-italian: fixture data, shown as written
        "Requisiti: l'operatore è l'aggiudicatario del lotto 1 dell'accordo quadro", // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Oggetto', 'progettazione esecutiva del ripristino della sponda del Canale Lauro', 'richiesta', 'progettazione esecutiva del ripristino della sponda del Canale Lauro', 97), // allow-italian: fixture data, shown as written
      read('Importo', '38.500,00 euro, più cassa e IVA', 'richiesta', 'Importo stimato: euro 38.500,00', 96), // allow-italian: fixture data, shown as written
      read('CIG', 'B7C21A94D3', 'richiesta', 'CIG derivato B7C21A94D3', 98), // allow-italian: fixture data, shown as written
      read('Requisiti', "aggiudicatario del lotto 1 dell'accordo quadro", 'richiesta', "l'operatore è l'aggiudicatario del lotto 1 dell'accordo quadro", 95), // allow-italian: fixture data, shown as written
      read('Procedura', "affidamento sul lotto 1 dell'accordo quadro", 'richiesta', "incarico sul lotto 1 dell'accordo quadro", 92), // allow-italian: fixture data, shown as written
    ],
    proposal: "Determina di affidamento dell'incarico sul lotto 1, 38.500,00 euro più cassa e IVA, con il CIG derivato; la verifica del RUP viene dopo.", // allow-italian: fixture data, shown as written
    links: { contract: 'ct-ingegneria-lotto1' }, // allow-italian: fixture data, shown as written
  },
  {
    id: 'CT-2397', flow: 'nocera-contratti', step: 's4', // allow-italian: fixture data, shown as written
    title: 'Gabbioni e geotessile per le sponde, CIG non ancora rilasciato', // allow-italian: fixture data, shown as written
    detail: 'Fornitura · 78.000,00 euro · richiesta di preventivi su Traspare', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-03', '10:00'), 'agent:ag-contratti'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-04', '09:30'), 'agent:ag-contratti'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-legale', 'aspetta il CIG dalla piattaforma di gara', at('11-04', '16:00')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-legale', due: '2026-11-20', priority: 'normale', // allow-italian: fixture data, shown as written
    blocked: { reason: 'la piattaforma Traspare non ha ancora rilasciato il CIG: richiesto il 04/11', since: at('11-04', '16:00') }, // allow-italian: fixture data, shown as written
    originals: [
      paper('capitolato', 'Capitolato della fornitura', 'tender', 'Tecnico e manutenzione', at('11-03', '09:58'), [ // allow-italian: fixture data, shown as written
        'Capitolato speciale: fornitura di gabbioni metallici e geotessile per il ripristino delle sponde dei canali', // allow-italian: fixture data, shown as written
        'Importo a base di gara: euro 78.000,00, oltre IVA', // allow-italian: fixture data, shown as written
        'Procedura: sotto soglia, richiesta di preventivi ad almeno tre operatori sulla piattaforma Traspare', // allow-italian: fixture data, shown as written
        "Consegna entro 30 giorni dall'ordine.", // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Oggetto', 'fornitura di gabbioni e geotessile per le sponde', 'capitolato', 'fornitura di gabbioni metallici e geotessile per il ripristino delle sponde dei canali', 97), // allow-italian: fixture data, shown as written
      read('Importo', '78.000,00 euro, più IVA', 'capitolato', 'Importo a base di gara: euro 78.000,00, oltre IVA', 97), // allow-italian: fixture data, shown as written
      read('Procedura', 'sotto soglia, preventivi ad almeno tre operatori', 'capitolato', 'richiesta di preventivi ad almeno tre operatori', 93), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Appena arriva il CIG: aprire la richiesta di preventivi su Traspare, con scadenza delle offerte dopo 10 giorni.', // allow-italian: fixture data, shown as written
  },
  {
    id: 'CT-2404', flow: 'nocera-contratti', step: 's7', // allow-italian: fixture data, shown as written
    title: "Incarico a un legale dell'albo, causa di lavoro", // allow-italian: fixture data, shown as written
    detail: "Tribunale di Salerno, sezione lavoro · compenso 6.800,00 euro · scelta dall'albo", // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-02', '09:00'), 'agent:ag-contratti'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-02', '09:10'), 'agent:ag-contratti'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-05', '11:20'), 'cn-tecnico'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-legale', 'verifica la determina: compenso, requisiti e rotazione', at('11-06', '09:25')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-legale', due: '2026-11-13', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('determina', 'Bozza di determina di incarico', 'letter', "bozza dell'agente", at('11-05', '11:00'), [ // allow-italian: fixture data, shown as written
        'Determina di incarico di patrocinio legale: causa di lavoro davanti al Tribunale di Salerno, sezione lavoro', // allow-italian: fixture data, shown as written
        "Il legale è scelto dall'albo per incarichi di assistenza e patrocinio legale, istituito a maggio 2026.", // allow-italian: fixture data, shown as written
        'Compenso: euro 6.800,00, oltre CPA e IVA, secondo i parametri forensi', // allow-italian: fixture data, shown as written
        'Rotazione: nessun incarico al legale negli ultimi 12 mesi', // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Oggetto', 'patrocinio in una causa di lavoro, Tribunale di Salerno', 'determina', 'causa di lavoro davanti al Tribunale di Salerno, sezione lavoro', 96), // allow-italian: fixture data, shown as written
      read('Importo', '6.800,00 euro, più CPA e IVA', 'determina', 'Compenso: euro 6.800,00, oltre CPA e IVA', 96), // allow-italian: fixture data, shown as written
      read('Procedura', "scelta dall'albo, con rotazione", 'determina', "Il legale è scelto dall'albo per incarichi di assistenza e patrocinio legale", 92), // allow-italian: fixture data, shown as written
      read('Requisiti', "iscrizione all'albo, nessun incarico negli ultimi 12 mesi", 'determina', 'nessun incarico al legale negli ultimi 12 mesi', 90), // allow-italian: fixture data, shown as written
    ],
    proposal: "Compenso nei parametri e rotazione rispettata: se l'avvocato interno conferma, la determina passa alla Direzione.", // allow-italian: fixture data, shown as written
    links: { contract: 'ct-albo-legali' }, // allow-italian: fixture data, shown as written
  },
  {
    id: 'CT-2400', flow: 'nocera-contratti', step: 's8', // allow-italian: fixture data, shown as written
    title: "Rilievi del Torrente Calvagnola sul lotto 2 dell'accordo quadro", // allow-italian: fixture data, shown as written
    detail: 'Fisciano · rilievo topografico e verifica idraulica · 24.900,00 euro', place: 'Fisciano', // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('11-02', '10:00'), 'agent:ag-contratti'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('11-02', '10:10'), 'agent:ag-contratti'), // allow-italian: fixture data, shown as written
      entry('verifica', at('11-04', '09:30'), 'cn-tecnico'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('11-05', '16:00'), 'cn-legale'), // allow-italian: fixture data, shown as written
    ],
    worker: personWorker('cn-dg', 'deve firmare la determina di affidamento', at('11-05', '16:00')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-dg', due: '2026-11-10', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('determina', 'Determina di affidamento, lotto 2', 'letter', 'bozza verificata', at('11-05', '15:30'), [ // allow-italian: fixture data, shown as written
        "Determina di affidamento sul lotto 2 dell'accordo quadro per i servizi di ingegneria 2026-2028", // allow-italian: fixture data, shown as written
        'Servizio: rilievo topografico e verifica idraulica del Torrente Calvagnola, Fisciano', // allow-italian: fixture data, shown as written
        'Importo: euro 24.900,00, oltre cassa previdenziale e IVA · CIG derivato B5D80F31E2', // allow-italian: fixture data, shown as written
        "Il responsabile del procedimento ha verificato i requisiti dell'operatore; l'avvocato interno ha verificato la determina.", // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Oggetto', 'rilievo e verifica idraulica del Torrente Calvagnola', 'determina', 'rilievo topografico e verifica idraulica del Torrente Calvagnola', 97), // allow-italian: fixture data, shown as written
      read('Importo', '24.900,00 euro, più cassa e IVA', 'determina', 'Importo: euro 24.900,00', 96), // allow-italian: fixture data, shown as written
      read('CIG', 'B5D80F31E2', 'determina', 'CIG derivato B5D80F31E2', 98), // allow-italian: fixture data, shown as written
      read('Requisiti', 'verificati dal RUP', 'determina', 'ha verificato i requisiti', 93), // allow-italian: fixture data, shown as written
    ],
    proposal: "Determina verificata dal responsabile del procedimento e dall'avvocato interno: serve la firma, poi protocollo in Halley e pubblicazione all'albo.", // allow-italian: fixture data, shown as written
    links: { contract: 'ct-ingegneria-lotto2' }, // allow-italian: fixture data, shown as written
  },
  {
    id: 'CT-2390', flow: 'nocera-contratti', step: 's9', // allow-italian: fixture data, shown as written
    title: 'Determina per il noleggio degli escavatori di novembre e dicembre', // allow-italian: fixture data, shown as written
    detail: "Noleggi Esempio S.r.l. · 240 ore · 19.200,00 euro · pubblicata all'albo", // allow-italian: fixture data, shown as written
    history: [
      entry('arrivo', at('10-28', '10:00'), 'agent:ag-contratti'), // allow-italian: fixture data, shown as written
      entry('lavorazione', at('10-28', '10:10'), 'agent:ag-contratti'), // allow-italian: fixture data, shown as written
      entry('verifica', at('10-30', '09:00'), 'cn-tecnico'), // allow-italian: fixture data, shown as written
      entry('approvazione', at('11-03', '15:00'), 'cn-legale'), // allow-italian: fixture data, shown as written
      entry('fatto', at('11-04', '14:30'), 'agent:ag-contratti'), // allow-italian: fixture data, shown as written
    ],
    worker: agentWorker('ag-contratti', "ha protocollato la determina in Halley, l'ha pubblicata all'albo e ha fissato le scadenze", at('11-04', '14:30')), // allow-italian: fixture data, shown as written
    reviewer: 'cn-legale', priority: 'normale', // allow-italian: fixture data, shown as written
    originals: [
      paper('determina', 'Determina di impegno, protocollo 2026/0018340', 'letter', 'Direzione, firmata', at('11-04', '14:00'), [ // allow-italian: fixture data, shown as written
        'Prot. n. 2026/0018340 del 04/11/2026', // allow-italian: fixture data, shown as written
        'Determina di impegno per il noleggio di escavatori con operatore, novembre e dicembre 2026', // allow-italian: fixture data, shown as written
        'Fornitore: Noleggi Esempio S.r.l. · 240 ore x 80,00 euro = euro 19.200,00, oltre IVA · CIG derivato B8A1F7C402', // allow-italian: fixture data, shown as written
        "Pubblicata all'albo del Consorzio il 04/11/2026.", // allow-italian: fixture data, shown as written
      ]),
    ],
    values: [
      read('Oggetto', 'noleggio di escavatori con operatore, novembre e dicembre', 'determina', 'noleggio di escavatori con operatore, novembre e dicembre 2026', 97), // allow-italian: fixture data, shown as written
      read('Importo', '19.200,00 euro, più IVA', 'determina', '240 ore x 80,00 euro = euro 19.200,00, oltre IVA', 97), // allow-italian: fixture data, shown as written
      read('CIG', 'B8A1F7C402', 'determina', 'CIG derivato B8A1F7C402', 98), // allow-italian: fixture data, shown as written
      read('Numero di protocollo', '2026/0018340', 'determina', 'Prot. n. 2026/0018340 del 04/11/2026', 99), // allow-italian: fixture data, shown as written
    ],
    proposal: 'Firmata, protocollata e pubblicata il 04/11: le fatture del noleggio si abbinano a questa determina.', // allow-italian: fixture data, shown as written
    links: { contract: 'ct-noleggio-escavatori' }, // allow-italian: fixture data, shown as written
  },
];

export const NOCERA_CARDS: OrbitCard[] = [...PEC, ...INVOICES, ...IRRIGATION, ...REPORTS, ...CONCESSIONS, ...POLICE, ...CONTRIBUTIONS, ...STAFF, ...TENDERS];
