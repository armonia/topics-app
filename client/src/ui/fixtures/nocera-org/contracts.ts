/**
 * The contracts of the Consorzio edition, with their versions, clauses,
 * obligations, comments, attachments, variants and approvals. Same shape as
 * `../sarim-org/contracts.ts`.
 *
 * What is real: that the Consorzio tendered a framework agreement in 2 lots for
 * engineering services of the 2026-2028 works programme (CUC del Lago di allow-italian: quotes the words on screen
 * Occhito, notice of 25/09/2026, bids due 12/10/2026), that it updated the
 * roll of lawyers for legal assistance and representation (resolution n. 16 of
 * 28/01/2026), that its irrigation network runs on 55 wells, and the articles
 * of L.R. 7/2025 the clauses lean on. The award of the two lots is not on the
 * site: counterparties, amounts, repertory numbers, dates of signature and
 * clause texts below are examples, and a counterparty ends with «(esempio)». allow-italian: quotes the words on screen
 * Only the electricity supply carries a tender code, the one printed on the
 * invoice card FT-2412.
 *
 * The cards of `cards.ts` were written around these ids and rule the states:
 * both lots are in force (a first order of each is on the board), the lawyers'
 * rules are in force (two engagements run under them), the electricity supply
 * is «In rinnovo» (option to extend, as a public body cannot renew tacitly),
 * the excavator hire has expired and November and December run on a new
 * determination, the Siano convention is a draft the agent is reading.
 *
 * A clause id follows its printed number (`art-9` is «9») and never changes
 * between versions: a later version rewrites words, not ids. Every obligation
 * quotes the words of its clause verbatim, so the screen can highlight them.
 */
import type { ApprovalStep, Clause, Contract, ContractAttachment } from '../sarim-org/types';

/** A clause as printed; the id follows the number. */
const art = (n: number, title: string, text: string): Clause => ({ id: `art-${n}`, n: String(n), title, text });

/** A later version: the same clauses, some texts rewritten. */
function revise(clauses: Clause[], texts: Record<string, string>): Clause[] {
  return clauses.map((c) => (c.id in texts ? { ...c, text: texts[c.id] } : c));
}

const step = (id: string, who: string, action: ApprovalStep['action'], state: ApprovalStep['state'], at?: string, note?: string): ApprovalStep => ({
  id, who, action, state, ...(at ? { at } : {}), ...(note ? { note } : {}),
});

/** The signed copy of a version: the header lines of the signed document. */
const signedCopy = (id: string, version: number, at: string, lines: string[]): ContractAttachment => ({
  id, name: `Contratto firmato, versione ${version}`, kind: 'firmato', version, at, lines, // allow-italian: fixture data, shown as written
});

const NOCERA_PARTY = 'Consorzio di Bonifica Integrale Comprensorio Sarno, con sede in Via Giuseppe Atzori snc, 84014 Nocera Inferiore (SA)'; // allow-italian: fixture data, shown as written
const COURT_CLAUSE = 'Per le controversie è competente il Foro di Nocera Inferiore.'; // allow-italian: fixture data, shown as written
const LOTS_PERIOD = "L'accordo quadro dura 24 mesi dalla firma, dal 2 novembre 2026 al 1° novembre 2028."; // allow-italian: fixture data, shown as written

/** The clauses of the reference version of each contract (the one in force, or the latest), by contract id. */
const BASE: Record<string, Clause[]> = {
  'ct-ingegneria-lotto1': [
    art(1, 'Oggetto', "Il Consorzio affida all'Aggiudicatario del lotto 1 l'accordo quadro per i servizi di ingegneria relativi alla progettazione, alla direzione dei lavori, al coordinamento della sicurezza e alle prestazioni accessorie degli interventi del Piano Triennale OO.PP. 2026/2028, a seguito della procedura di gara svolta dalla CUC del Lago di Occhito."), // allow-italian: fixture data, shown as written
    art(2, 'Durata e proroga', `${LOTS_PERIOD} Il Consorzio può prorogarlo di ulteriori 12 mesi, dandone comunicazione all'Aggiudicatario almeno 90 giorni prima della scadenza.`), // allow-italian: fixture data, shown as written
    art(3, 'Ordinativi e incarichi', "Ogni incarico è affidato con un ordinativo del RUP che indica l'intervento, le prestazioni richieste, il termine di consegna e il compenso, calcolato con il ribasso offerto in gara. L'accordo quadro non obbliga il Consorzio a raggiungere l'importo massimo."), // allow-italian: fixture data, shown as written
    art(4, 'Prestazioni', "L'Aggiudicatario svolge la progettazione di fattibilità tecnico-economica ed esecutiva, la direzione dei lavori, il coordinamento della sicurezza in progettazione e in esecuzione, la contabilità e l'assistenza al collaudo, con il gruppo di lavoro indicato in offerta. Ogni sostituzione di un professionista è autorizzata dal RUP."), // allow-italian: fixture data, shown as written
    art(5, 'Importo e pagamenti', "L'importo massimo dell'accordo quadro è pari a euro 1.240.000,00 oltre IVA e oneri previdenziali. Il compenso di ogni incarico è pagato per stati di avanzamento delle prestazioni, entro 30 giorni dal ricevimento della fattura elettronica, dopo il visto del RUP. La fattura riporta il numero dell'ordinativo. L'Aggiudicatario assume gli obblighi di tracciabilità dei flussi finanziari della legge 136/2010."), // allow-italian: fixture data, shown as written
    art(6, 'Penali', "Per ogni giorno di ritardo nella consegna di un livello di progettazione si applica una penale pari all'1 per mille dell'importo dell'incarico. Le penali nel complesso non superano il 10% dell'importo dell'incarico."), // allow-italian: fixture data, shown as written
    art(7, 'Garanzie e polizza professionale', "Prima della firma l'Aggiudicatario consegna la garanzia definitiva e la polizza di responsabilità civile professionale, con massimale adeguato agli interventi da progettare. La polizza resta valida per tutta la durata dell'accordo quadro."), // allow-italian: fixture data, shown as written
    art(8, 'Subappalto', "Il subappalto è ammesso solo per indagini, rilievi e prestazioni accessorie, nei limiti dell'art. 119 del D.Lgs. 36/2023 e previa autorizzazione del RUP. La progettazione non si subappalta."), // allow-italian: fixture data, shown as written
    art(9, 'Controversie', COURT_CLAUSE), // allow-italian: fixture data, shown as written
  ],
  'ct-ingegneria-lotto2': [
    art(1, 'Oggetto', "Il Consorzio affida all'Aggiudicatario del lotto 2 l'accordo quadro per i servizi di ingegneria relativi alla verifica della progettazione e alla verifica del processo di gestione informativa e dei modelli BIM degli interventi del Piano Triennale OO.PP. 2026/2028, a seguito della procedura di gara svolta dalla CUC del Lago di Occhito."), // allow-italian: fixture data, shown as written
    art(2, 'Durata', `${LOTS_PERIOD} Non è prevista proroga.`), // allow-italian: fixture data, shown as written
    art(3, 'Ordinativi e incompatibilità', "Ogni incarico di verifica è affidato con un ordinativo del RUP che indica il progetto da verificare. L'Aggiudicatario non può verificare un progetto che ha redatto, né un progetto redatto dall'aggiudicatario del lotto 1."), // allow-italian: fixture data, shown as written
    art(4, 'Verifica dei modelli BIM', "Per ogni progetto l'Aggiudicatario verifica il processo di gestione informativa e i modelli BIM secondo il capitolato informativo del Consorzio e consegna la relazione di verifica, con il rapporto di validazione dei modelli, entro 15 giorni dall'ordinativo, o nel termine più lungo che l'ordinativo indica per i modelli complessi, comunque non oltre 25 giorni."), // allow-italian: fixture data, shown as written
    art(5, 'Importo e pagamenti', "L'importo massimo dell'accordo quadro è pari a euro 310.000,00 oltre IVA e oneri previdenziali. Il compenso di ogni incarico è pagato alla consegna della relazione di verifica, entro 30 giorni dal ricevimento della fattura elettronica, dopo il visto del RUP. L'Aggiudicatario assume gli obblighi di tracciabilità dei flussi finanziari della legge 136/2010."), // allow-italian: fixture data, shown as written
    art(6, 'Penali', "Per ogni giorno di ritardo nella consegna della relazione di verifica si applica una penale pari all'1 per mille dell'importo dell'incarico. Le penali nel complesso non superano il 10% dell'importo dell'incarico."), // allow-italian: fixture data, shown as written
    art(7, 'Garanzie e polizza professionale', "Prima della firma l'Aggiudicatario consegna la garanzia definitiva e la polizza di responsabilità civile professionale. La polizza resta valida per tutta la durata dell'accordo quadro."), // allow-italian: fixture data, shown as written
    art(8, 'Proprietà dei modelli', "I modelli BIM e le relazioni di verifica sono di proprietà del Consorzio. L'Aggiudicatario non li usa per altri scopi e li restituisce a fine incarico nel formato aperto IFC."), // allow-italian: fixture data, shown as written
    art(9, 'Controversie', COURT_CLAUSE), // allow-italian: fixture data, shown as written
  ],
  'ct-albo-legali': [
    art(1, 'Oggetto', "Il presente disciplinare regola gli incarichi di assistenza e patrocinio legale che il Consorzio affida ai professionisti iscritti all'albo aggiornato con la Deliberazione di Deputazione Amministrativa n. 16 del 28.01.2026. Ogni incarico è affidato con una determina che richiama il disciplinare."), // allow-italian: fixture data, shown as written
    art(2, 'Durata', "Il disciplinare vale dalla firma fino alla cancellazione del professionista dall'albo o alla sua revoca. Ogni incarico dura fino alla definizione del grado di giudizio per cui è affidato."), // allow-italian: fixture data, shown as written
    art(3, 'Scelta e rotazione', "Il Consorzio sceglie il professionista dall'albo secondo il tipo di causa e la competenza richiesta, con rotazione: non riceve un nuovo incarico chi ne ha avuto uno negli ultimi 12 mesi, salvo che la causa richieda una competenza che nessun altro iscritto ha."), // allow-italian: fixture data, shown as written
    art(4, 'Compenso e pagamenti', "Il compenso di ogni incarico è determinato nei parametri forensi vigenti, con le riduzioni offerte all'iscrizione, e indicato nella determina. Il Consorzio destina agli incarichi dell'albo uno stanziamento massimo di euro 60.000,00 oltre IVA e contributo previdenziale all'anno. Le spese vive documentate sono rimborsate a parte. Il compenso è pagato per il 30% alla costituzione in giudizio e per il saldo al deposito della sentenza, entro 30 giorni dal ricevimento della fattura."), // allow-italian: fixture data, shown as written
    art(5, 'Termini degli atti', "Per ogni atto con un termine, come la costituzione in giudizio entro 60 giorni dalla notifica del ricorso o l'opposizione a un decreto ingiuntivo entro 40 giorni dalla notifica, l'Avvocato lo deposita nel termine e ne dà prova al Consorzio almeno 5 giorni prima della scadenza."), // allow-italian: fixture data, shown as written
    art(6, 'Informazione al Consorzio', "Dopo ogni udienza l'Avvocato informa per iscritto l'avvocato interno del Consorzio entro 7 giorni, con l'esito e le date delle udienze successive."), // allow-italian: fixture data, shown as written
    art(7, 'Incompatibilità e polizza', "L'Avvocato dichiara di non avere conflitti di interesse con la controparte e mantiene per tutta la durata la polizza di responsabilità civile professionale, di cui consegna copia ogni anno."), // allow-italian: fixture data, shown as written
    art(8, 'Revoca e foro', "Il Consorzio può revocare un incarico in ogni momento pagando le attività svolte. Per le controversie è competente il Foro di Nocera Inferiore."), // allow-italian: fixture data, shown as written
  ],
  'ct-energia-pozzi': [
    art(1, 'Oggetto', "Il Fornitore somministra al Consorzio l'energia elettrica per i 55 punti di prelievo degli impianti di sollevamento dell'acqua irrigua, uno per ogni pozzo della rete irrigua, secondo l'elenco dei punti di prelievo allegato."), // allow-italian: fixture data, shown as written
    art(2, 'Durata e rinnovo', "L'accordo dura 24 mesi, dal 1° aprile 2025 al 31 marzo 2027. Il Consorzio può rinnovarlo per ulteriori 12 mesi alle stesse condizioni, comunicandolo al Fornitore via PEC almeno 90 giorni prima della scadenza."), // allow-italian: fixture data, shown as written
    art(3, 'Punti di prelievo', "L'elenco dei punti di prelievo indica per ciascuno la potenza impegnata e il bacino di irrigazione. Il Consorzio può togliere un punto di prelievo, o aggiungerne uno nuovo, con una comunicazione via PEC; il prezzo resta quello dell'accordo."), // allow-italian: fixture data, shown as written
    art(4, 'Prezzo e importo', "Il prezzo dell'energia è pari al prezzo medio mensile all'ingrosso pubblicato dal GME più uno spread fisso di euro 0,0085 per kWh. Trasporto, oneri di sistema, accise e IVA sono addebitati a parte senza ricarico. Il corrispettivo annuo è stimato in euro 380.000,00 oltre IVA, sui consumi dell'ultima stagione irrigua."), // allow-italian: fixture data, shown as written
    art(5, 'Letture e fatture', "Il Consorzio comunica le letture dei contatori entro il giorno 5 di ogni mese. Il Fornitore emette una fattura mensile con il dettaglio dei 55 punti di prelievo e il CIG del contratto."), // allow-italian: fixture data, shown as written
    art(6, 'Pagamenti', "Il Consorzio paga entro 30 giorni dal ricevimento della fattura elettronica, nel rispetto del D.Lgs. 231/2002 e degli obblighi di tracciabilità della legge 136/2010."), // allow-italian: fixture data, shown as written
    art(7, 'Continuità della fornitura', "Il Fornitore garantisce la continuità della fornitura nei mesi da maggio a settembre. In caso di interruzione oltre 6 ore su un punto di prelievo si applica una penale di euro 400 per ogni punto e per ogni giorno intero."), // allow-italian: fixture data, shown as written
    art(8, 'Impianti da fonti rinnovabili', "Quando entra in esercizio un impianto fotovoltaico del Consorzio su un punto di prelievo, la quantità di energia che il Fornitore deve somministrare su quel punto si riduce di pari misura senza penale, dal mese successivo alla comunicazione del Consorzio."), // allow-italian: fixture data, shown as written
    art(9, 'Controversie', COURT_CLAUSE), // allow-italian: fixture data, shown as written
  ],
  'ct-noleggio-escavatori': [
    art(1, 'Oggetto', "Il Fornitore noleggia al Consorzio, con operatore e carburante a proprio carico, escavatori e autocarri per la manutenzione ordinaria dei canali di bonifica, negli interventi di espurgo e di taglio della vegetazione indicati dal Responsabile tecnico."), // allow-italian: fixture data, shown as written
    art(2, 'Durata', 'Il contratto dura 12 mesi, dal 1° ottobre 2025 al 30 settembre 2026, senza rinnovo.'), // allow-italian: fixture data, shown as written
    art(3, 'Importo e tariffe', "L'importo massimo è pari a euro 186.000,00 oltre IVA, per un massimo di 2.325 ore, con la tariffa di euro 80,00 all'ora per l'escavatore con operatore e carburante. Le tariffe degli altri mezzi sono nell'elenco allegato."), // allow-italian: fixture data, shown as written
    art(4, 'Ordini di intervento', 'Il Consorzio ordina ogni intervento con un ordine scritto che indica canale, comune, mezzo e giorni. Il Fornitore porta il mezzo sul canale entro 48 ore dall\'ordine.'), // allow-italian: fixture data, shown as written
    art(5, 'Fogli di lavoro', 'Il capo squadra del Consorzio firma ogni giorno il foglio di lavoro del mezzo. Il Fornitore fattura ogni mese solo le ore dei fogli firmati, con il riferimento agli ordini.'), // allow-italian: fixture data, shown as written
    art(6, 'Pagamenti', 'Il Consorzio paga entro 30 giorni dal ricevimento della fattura elettronica, dopo la verifica del DURC e dei fogli di lavoro, nel rispetto della legge 136/2010 sulla tracciabilità.'), // allow-italian: fixture data, shown as written
    art(7, 'Penale per fermo del mezzo', 'Se il mezzo resta fermo per guasto oltre 24 ore, il Fornitore lo sostituisce con un mezzo equivalente; in mancanza si applica una penale di euro 250 per ogni giorno di fermo.'), // allow-italian: fixture data, shown as written
    art(8, 'Chiusura', 'Alla scadenza il Consorzio e il Fornitore firmano il verbale di chiusura con le ore totali; il Fornitore emette la fattura finale entro 30 giorni dalla scadenza.'), // allow-italian: fixture data, shown as written
    art(9, 'Sicurezza e foro', 'Il Fornitore rispetta il DUVRI per i lavori in alveo e sulle sponde. Per le controversie è competente il Foro di Nocera Inferiore.'), // allow-italian: fixture data, shown as written
  ],
  'ct-convenzione-difesa-suolo': [
    art(1, 'Oggetto', "Il Comune di Siano affida al Consorzio, in attuazione della L.R. Campania 7/2025 sulla difesa del suolo (art. 4), la progettazione e l'esecuzione degli interventi di sistemazione idrogeologica del Vallone Truda e del Vallone Orneto indicati nell'elenco allegato."), // allow-italian: fixture data, shown as written
    art(2, 'Durata e firma', 'La convenzione dura 3 anni dalla firma, prevista il 30 novembre 2026, fino al 29 novembre 2029.'), // allow-italian: fixture data, shown as written
    art(3, 'Programma degli interventi', 'Il Consorzio presenta il programma degli interventi con il cronoprogramma entro 60 giorni dalla firma. Il Comune lo approva con delibera di Giunta.'), // allow-italian: fixture data, shown as written
    art(4, 'Finanziamento e pagamenti', "Il Comune mette a disposizione euro 120.000,00 oltre IVA, trasferiti per il 30% alla firma e per il resto per stati di avanzamento. Il Consorzio non usa per questi interventi i tributi pagati dai proprietari degli immobili, che la L.R. 7/2025 (art. 21) riserva alla gestione e alla manutenzione ordinaria delle opere di bonifica."), // allow-italian: fixture data, shown as written
    art(5, 'Rendiconto', 'Ogni sei mesi il Consorzio trasmette al Comune il rendiconto con lo stato degli interventi e delle spese, entro il 31 maggio e il 30 novembre.'), // allow-italian: fixture data, shown as written
    art(6, 'Direzione e collaudo', 'Il RUP è nominato dal Comune. Il Consorzio nomina il direttore dei lavori e consegna al Comune il certificato di collaudo di ogni intervento.'), // allow-italian: fixture data, shown as written
    art(7, 'Penali', "Per ogni giorno di ritardo sul cronoprogramma approvato si applica una penale pari all'1 per mille dell'importo dell'intervento. Le penali nel complesso non superano il 10% dell'importo dell'intervento."), // allow-italian: fixture data, shown as written
    art(8, 'Garanzia e polizza', "Prima dell'avvio degli interventi il Consorzio consegna al Comune la polizza di responsabilità civile verso terzi per i lavori in alveo e sui versanti."), // allow-italian: fixture data, shown as written
    art(9, 'Recesso e foro', 'Se i fondi regionali non sono confermati, il Comune può recedere con preavviso di 30 giorni, pagando gli interventi già eseguiti. Per le controversie è competente il Foro di Nocera Inferiore.'), // allow-italian: fixture data, shown as written
  ],
};

export const NOCERA_CONTRACTS: Contract[] = [
  {
    id: 'ct-ingegneria-lotto1', title: 'Accordo quadro ingegneria 2026-2028, lotto 1: progettazione e direzione dei lavori', kind: 'appalto', // allow-italian: fixture data, shown as written
    counterparty: 'Raggruppamento di professionisti, lotto 1 (esempio)', counterpartyKind: 'Professionisti', // allow-italian: fixture data, shown as written
    object: 'Progettazione, direzione dei lavori, coordinamento della sicurezza e prestazioni accessorie degli interventi del Piano Triennale OO.PP. 2026/2028', // allow-italian: fixture data, shown as written
    value: 1240000, valuePeriod: 'totale', start: '2026-11-02', end: '2028-11-01', renewal: { kind: 'opzione', months: 12, noticeDays: 90 }, // allow-italian: fixture data, shown as written
    status: 'attivo', owner: 'cn-legale', area: 'legale', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'cn-legale', draftedBy: 'agent:ag-contratti', at: '2026-10-14T17:30:00+02:00', reason: "Schema dall'avviso e dal disciplinare di gara", clauses: revise(BASE['ct-ingegneria-lotto1'], { // allow-italian: fixture data, shown as written
        'art-2': "L'accordo quadro dura 24 mesi dalla data della firma. Il Consorzio può prorogarlo di ulteriori 12 mesi, dandone comunicazione all'Aggiudicatario almeno 90 giorni prima della scadenza.", // allow-italian: fixture data, shown as written
        'art-3': "Ogni incarico è affidato con un ordinativo del RUP che indica l'intervento, le prestazioni richieste e il compenso, calcolato con il ribasso offerto in gara. L'accordo quadro non obbliga il Consorzio a raggiungere l'importo massimo.", // allow-italian: fixture data, shown as written
        'art-5': "L'importo massimo dell'accordo quadro è pari a euro 1.240.000,00 oltre IVA e oneri previdenziali. Il compenso di ogni incarico è pagato per stati di avanzamento delle prestazioni, entro 30 giorni dal ricevimento della fattura elettronica, dopo il visto del RUP. L'Aggiudicatario assume gli obblighi di tracciabilità dei flussi finanziari della legge 136/2010.", // allow-italian: fixture data, shown as written
        'art-6': "Per ogni giorno di ritardo nella consegna di un livello di progettazione si applica una penale pari all'1 per mille dell'importo dell'incarico.", // allow-italian: fixture data, shown as written
      }) },
      { n: 2, author: 'cn-legale', at: '2026-10-30T12:00:00+01:00', reason: 'Accordo quadro firmato', clauses: BASE['ct-ingegneria-lotto1'], signed: true }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-ing1-1', clause: 'art-7', version: 2, what: 'Garanzia definitiva e polizza professionale, consegnate prima della firma', owner: 'cn-legale', kind: 'garanzia', due: '2026-10-28', done: true, quote: "Prima della firma l'Aggiudicatario consegna la garanzia definitiva e la polizza di responsabilità civile professionale" }, // allow-italian: fixture data, shown as written
      { id: 'ob-ing1-2', clause: 'art-3', version: 2, what: 'Ordinativo del RUP con termine di consegna per ogni incarico', owner: 'cn-tecnico', kind: 'ricorrente', every: 'a ogni incarico', quote: 'il termine di consegna e il compenso' }, // allow-italian: fixture data, shown as written
      { id: 'ob-ing1-3', clause: 'art-5', version: 2, what: 'Pagamento degli stati di avanzamento, con il numero di ordinativo in fattura', owner: 'cn-ragioneria', kind: 'ricorrente', every: 'entro 30 giorni dalla fattura, dopo il visto del RUP', quote: 'entro 30 giorni dal ricevimento della fattura elettronica, dopo il visto del RUP' }, // allow-italian: fixture data, shown as written
      { id: 'ob-ing1-4', clause: 'art-6', version: 2, what: 'Ritardo nella consegna di un livello di progettazione: 1 per mille al giorno', owner: 'cn-tecnico', kind: 'penale', quote: "si applica una penale pari all'1 per mille dell'importo dell'incarico" }, // allow-italian: fixture data, shown as written
      { id: 'ob-ing1-5', clause: 'art-2', version: 2, what: 'Decidere la proroga di 12 mesi', owner: 'cn-legale', kind: 'rinnovo', due: '2028-08-03', quote: 'almeno 90 giorni prima della scadenza' }, // allow-italian: fixture data, shown as written
    ],
    comments: [
      { id: 'cm-ing1-1', clause: 'art-5', version: 1, author: 'cn-ragioneria', at: '2026-10-16T10:10:00+02:00', text: "Il pagamento per stati di avanzamento va legato al visto del RUP e al numero dell'ordinativo, altrimenti alla Ragioneria arrivano fatture che non sappiamo a quale incarico collegare.", resolved: true, replies: [ // allow-italian: fixture data, shown as written
        { author: 'cn-legale', at: '2026-10-16T11:05:00+02:00', text: "Aggiunto nella versione 2: la fattura riporta il numero dell'ordinativo." }, // allow-italian: fixture data, shown as written
      ] },
      { id: 'cm-ing1-2', clause: 'art-3', version: 1, author: 'cn-tecnico', at: '2026-10-20T15:00:00+02:00', text: "Il termine di consegna scritto nell'ordinativo serve: senza, la penale dell'articolo 6 non si può applicare.", resolved: true, replies: [ // allow-italian: fixture data, shown as written
        { author: 'cn-legale', at: '2026-10-20T16:20:00+02:00', text: "Sì, è nella versione 2: lo mette il RUP in ogni ordinativo." }, // allow-italian: fixture data, shown as written
      ] },
      { id: 'cm-ing1-3', clause: 'art-3', version: 2, author: 'cn-tecnico', at: '2026-11-03T14:10:00+01:00', text: "Primo incarico: ripristino della sponda del Canale Lauro, 38.500 euro (CT-2403). L'ordinativo porta il termine di consegna, come dice l'articolo 3." }, // allow-italian: fixture data, shown as written
    ],
    attachments: [
      signedCopy('at-ing1-v2', 2, '2026-10-30T12:00:00+01:00', [
        'Accordo quadro per i servizi di ingegneria della Programmazione triennale 2026-2028, lotto 1', // allow-italian: fixture data, shown as written
        `Tra il ${NOCERA_PARTY}, e Raggruppamento di professionisti, lotto 1 (esempio)`, // allow-italian: fixture data, shown as written
        'Importo massimo: euro 1.240.000,00 oltre IVA. Durata: 24 mesi, dal 02/11/2026 al 01/11/2028, con proroga di 12 mesi', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 30/10/2026', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-ing1-avviso', name: 'Avviso di proroga dei termini di gara', kind: 'allegato', version: 1, at: '2026-09-25T12:00:00+02:00', lines: [ // allow-italian: fixture data, shown as written
        'CUC del Lago di Occhito', // allow-italian: fixture data, shown as written
        'Procedura di gara per l\'affidamento di un accordo quadro, suddiviso in 2 lotti, per i servizi di ingegneria relativi alle opere inserite nella Programmazione triennale 2026-2028', // allow-italian: fixture data, shown as written
        'Atto gestionale del Responsabile della CUC n. 217 del 25.09.2026: i termini di gara sono stati modificati', // allow-italian: fixture data, shown as written
        'Data di scadenza per i chiarimenti: 05.10.2026, ore 12:00. Data di scadenza del bando: 12.10.2026, ore 12:00', // allow-italian: fixture data, shown as written
      ] },
      { id: 'at-ing1-lotto', name: 'Descrizione del lotto 1', kind: 'allegato', version: 1, at: '2026-09-25T12:05:00+02:00', lines: [ // allow-italian: fixture data, shown as written
        'Lotto 1: accordo quadro per l\'affidamento dei servizi di ingegneria relativi alla progettazione, la direzione dei lavori, il coordinamento della sicurezza e le prestazioni accessorie relative agli interventi del Piano Triennale OO.PP. 2026/2028', // allow-italian: fixture data, shown as written
        'Importo massimo, aggiudicatario e ribasso: esempi, l\'esito della gara non è sul sito del Consorzio', // allow-italian: fixture data, shown as written
      ] },
    ],
    variants: [],
    approvals: [
      step('ap-1', 'cn-legale', 'redige', 'fatto', '2026-10-20T17:00:00+02:00', "Bozza dell'agente contratti e gare rivista: articoli 3, 5 e 6"), // allow-italian: fixture data, shown as written
      step('ap-2', 'cn-tecnico', 'rivede', 'fatto', '2026-10-23T11:20:00+02:00', 'Prestazioni e ordinativi uguali al disciplinare'), // allow-italian: fixture data, shown as written
      step('ap-3', 'cn-dg', 'approva', 'fatto', '2026-10-28T09:45:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-4', 'cn-dg', 'firma', 'fatto', '2026-10-30T12:00:00+01:00', 'Firma digitale'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['nocera-contratti'], cards: ['CT-2403'] },
    tags: ['CUC del Lago di Occhito', 'Programmazione triennale OO.PP. 2026-2028', 'D.Lgs. 36/2023'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'ct-ingegneria-lotto2', title: 'Accordo quadro ingegneria 2026-2028, lotto 2: verifica della progettazione e BIM', kind: 'appalto', // allow-italian: fixture data, shown as written
    counterparty: 'Società di ingegneria, lotto 2 (esempio)', counterpartyKind: 'Professionisti', // allow-italian: fixture data, shown as written
    object: 'Verifica della progettazione e del processo di gestione informativa e dei modelli BIM degli interventi del Piano Triennale OO.PP. 2026/2028', // allow-italian: fixture data, shown as written
    value: 310000, valuePeriod: 'totale', start: '2026-11-02', end: '2028-11-01', renewal: { kind: 'nessuno', months: 0, noticeDays: 0 }, // allow-italian: fixture data, shown as written
    status: 'attivo', owner: 'cn-legale', area: 'legale', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'cn-legale', draftedBy: 'agent:ag-contratti', at: '2026-10-14T17:50:00+02:00', reason: "Schema dall'avviso e dal disciplinare di gara", clauses: revise(BASE['ct-ingegneria-lotto2'], { // allow-italian: fixture data, shown as written
        'art-2': "L'accordo quadro dura 24 mesi dalla data della firma. Non è prevista proroga.", // allow-italian: fixture data, shown as written
        'art-4': "Per ogni progetto l'Aggiudicatario verifica il processo di gestione informativa e i modelli BIM secondo il capitolato informativo del Consorzio e consegna la relazione di verifica, con il rapporto di validazione dei modelli, entro 15 giorni dall'ordinativo.", // allow-italian: fixture data, shown as written
      }) },
      { n: 2, author: 'cn-legale', at: '2026-10-30T12:10:00+01:00', reason: 'Accordo quadro firmato', clauses: BASE['ct-ingegneria-lotto2'], signed: true }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-ing2-1', clause: 'art-3', version: 2, what: "Controllo dell'incompatibilità con i progettisti del lotto 1 prima di ogni ordinativo", owner: 'cn-tecnico', kind: 'ricorrente', every: 'a ogni ordinativo', quote: "L'Aggiudicatario non può verificare un progetto che ha redatto" }, // allow-italian: fixture data, shown as written
      { id: 'ob-ing2-2', clause: 'art-4', version: 2, what: 'Relazione di verifica e rapporto di validazione dei modelli BIM', owner: 'cn-tecnico', kind: 'ricorrente', every: "entro 15 giorni dall'ordinativo, fino a 25 per i modelli complessi", quote: "entro 15 giorni dall'ordinativo" }, // allow-italian: fixture data, shown as written
      { id: 'ob-ing2-3', clause: 'art-6', version: 2, what: 'Ritardo nella relazione di verifica: 1 per mille al giorno', owner: 'cn-tecnico', kind: 'penale', quote: "si applica una penale pari all'1 per mille dell'importo dell'incarico" }, // allow-italian: fixture data, shown as written
      { id: 'ob-ing2-4', clause: 'art-7', version: 2, what: 'Garanzia definitiva e polizza professionale, consegnate prima della firma', owner: 'cn-legale', kind: 'garanzia', due: '2026-10-28', done: true, quote: "Prima della firma l'Aggiudicatario consegna la garanzia definitiva" }, // allow-italian: fixture data, shown as written
    ],
    comments: [
      { id: 'cm-ing2-1', clause: 'art-4', version: 1, author: 'cn-tecnico', at: '2026-10-21T12:20:00+02:00', text: "15 giorni bastano per un progetto semplice; per un modello BIM complesso ne servono 25. Lo scriviamo nell'ordinativo o cambiamo qui il termine?", resolved: true, replies: [ // allow-italian: fixture data, shown as written
        { author: 'cn-legale', at: '2026-10-21T14:00:00+02:00', text: "Scritto nella versione 2: l'ordinativo può indicare un termine più lungo, fino a 25 giorni." }, // allow-italian: fixture data, shown as written
      ] },
    ],
    attachments: [
      signedCopy('at-ing2-v2', 2, '2026-10-30T12:10:00+01:00', [
        'Accordo quadro per i servizi di ingegneria della Programmazione triennale 2026-2028, lotto 2', // allow-italian: fixture data, shown as written
        `Tra il ${NOCERA_PARTY}, e Società di ingegneria, lotto 2 (esempio)`, // allow-italian: fixture data, shown as written
        'Importo massimo: euro 310.000,00 oltre IVA. Durata: 24 mesi, dal 02/11/2026 al 01/11/2028', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 30/10/2026', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-ing2-lotto', name: 'Descrizione del lotto 2', kind: 'allegato', version: 1, at: '2026-09-25T12:05:00+02:00', lines: [ // allow-italian: fixture data, shown as written
        'Lotto 2: accordo quadro per l\'affidamento dei servizi di ingegneria relativi alla verifica della progettazione nonché la verifica del processo di gestione informativa e degli attinenti modelli BIM relativi agli interventi del Piano Triennale OO.PP. 2026/2028', // allow-italian: fixture data, shown as written
        'Importo massimo, aggiudicatario e ribasso: esempi, l\'esito della gara non è sul sito del Consorzio', // allow-italian: fixture data, shown as written
      ] },
    ],
    variants: [],
    approvals: [
      step('ap-1', 'cn-legale', 'redige', 'fatto', '2026-10-20T17:20:00+02:00', "Bozza dell'agente contratti e gare rivista: articoli 2 e 4"), // allow-italian: fixture data, shown as written
      step('ap-2', 'cn-tecnico', 'rivede', 'fatto', '2026-10-23T11:40:00+02:00', 'Tempi di verifica e formato dei modelli'), // allow-italian: fixture data, shown as written
      step('ap-3', 'cn-dg', 'approva', 'fatto', '2026-10-28T09:50:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-4', 'cn-dg', 'firma', 'fatto', '2026-10-30T12:10:00+01:00', 'Firma digitale'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['nocera-contratti'], cards: ['CT-2400'] },
    tags: ['CUC del Lago di Occhito', 'BIM', 'verifica del progetto'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'ct-albo-legali', title: "Disciplinare degli incarichi legali dall'albo", kind: 'servizio', // allow-italian: fixture data, shown as written
    counterparty: "Professionisti iscritti all'albo (esempio)", counterpartyKind: 'Professionisti', // allow-italian: fixture data, shown as written
    object: "Disciplinare firmato da ogni professionista dell'albo per gli incarichi di assistenza e patrocinio legale: scelta con rotazione, compenso, termini degli atti", // allow-italian: fixture data, shown as written
    value: 60000, valuePeriod: 'anno', start: '2026-02-10', end: '', renewal: { kind: 'nessuno', months: 0, noticeDays: 0 }, // allow-italian: fixture data, shown as written
    status: 'attivo', owner: 'cn-legale', area: 'legale', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'cn-legale', at: '2026-02-10T12:00:00+01:00', reason: 'Disciplinare firmato dopo la Deliberazione n. 16 del 28/01/2026', signed: true, clauses: revise(BASE['ct-albo-legali'], { // allow-italian: fixture data, shown as written
        'art-3': "Il Consorzio sceglie il professionista dall'albo secondo il tipo di causa e la competenza richiesta.", // allow-italian: fixture data, shown as written
      }) },
      { n: 2, author: 'cn-legale', at: '2026-09-15T11:30:00+02:00', reason: 'Rotazione: nessun nuovo incarico a chi ne ha avuto uno negli ultimi 12 mesi', signed: true, clauses: BASE['ct-albo-legali'] }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-alb-1', clause: 'art-3', version: 2, what: 'Rotazione: nessun nuovo incarico a chi ne ha avuto uno negli ultimi 12 mesi', owner: 'cn-legale', kind: 'ricorrente', every: 'a ogni incarico', quote: 'non riceve un nuovo incarico chi ne ha avuto uno negli ultimi 12 mesi' }, // allow-italian: fixture data, shown as written
      { id: 'ob-alb-2', clause: 'art-5', version: 2, what: "Opposizione al decreto ingiuntivo 1487/2026: prova del deposito 5 giorni prima del 14/12", owner: 'cn-legale', kind: 'scadenza', due: '2026-12-09', quote: 'ne dà prova al Consorzio almeno 5 giorni prima della scadenza' }, // allow-italian: fixture data, shown as written
      { id: 'ob-alb-3', clause: 'art-6', version: 2, what: "Informazione scritta all'avvocato interno dopo ogni udienza", owner: 'cn-legale', kind: 'ricorrente', every: 'entro 7 giorni da ogni udienza', quote: "informa per iscritto l'avvocato interno del Consorzio entro 7 giorni" }, // allow-italian: fixture data, shown as written
      { id: 'ob-alb-4', clause: 'art-4', version: 2, what: 'Saldo del compenso al deposito della sentenza', owner: 'cn-ragioneria', kind: 'ricorrente', every: 'entro 30 giorni dalla fattura', quote: 'entro 30 giorni dal ricevimento della fattura' }, // allow-italian: fixture data, shown as written
      { id: 'ob-alb-5', clause: 'art-7', version: 2, what: 'Copia annuale della polizza di responsabilità civile professionale', owner: 'cn-legale', kind: 'garanzia', due: '2027-02-10', every: 'ogni anno, il 10 febbraio', quote: 'di cui consegna copia ogni anno' }, // allow-italian: fixture data, shown as written
    ],
    comments: [
      { id: 'cm-alb-1', clause: 'art-3', version: 2, author: 'cn-dg', at: '2026-09-10T10:00:00+02:00', text: 'La rotazione la voglio scritta nel disciplinare, non solo nella determina di ogni incarico.', resolved: true, replies: [ // allow-italian: fixture data, shown as written
        { author: 'cn-legale', at: '2026-09-10T12:00:00+02:00', text: 'Fatto nella versione 2, articolo 3: 12 mesi, con l\'eccezione per la competenza che nessun altro iscritto ha.' }, // allow-italian: fixture data, shown as written
      ] },
      { id: 'cm-alb-2', clause: 'art-5', version: 2, author: 'cn-legale', at: '2026-11-05T12:10:00+01:00', text: "Per il decreto ingiuntivo di PEC-2412 l'opposizione scade il 14/12: la prova del deposito si chiede al legale entro il 09/12." }, // allow-italian: fixture data, shown as written
    ],
    attachments: [
      signedCopy('at-alb-v1', 1, '2026-02-10T12:00:00+01:00', [
        "Disciplinare degli incarichi di assistenza e patrocinio legale dall'albo", // allow-italian: fixture data, shown as written
        `Tra il ${NOCERA_PARTY}, e il professionista iscritto all'albo (esempio)`, // allow-italian: fixture data, shown as written
        'Albo aggiornato con Deliberazione di Deputazione Amministrativa n. 16 del 28.01.2026', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 10/02/2026', // allow-italian: fixture data, shown as written
      ]),
      signedCopy('at-alb-v2', 2, '2026-09-15T11:30:00+02:00', [
        "Atto modificativo n. 1 al disciplinare degli incarichi legali del 10/02/2026", // allow-italian: fixture data, shown as written
        'Articolo modificato: 3 (scelta e rotazione)', // allow-italian: fixture data, shown as written
        'Nessun nuovo incarico a chi ne ha avuto uno negli ultimi 12 mesi, salvo competenza che nessun altro iscritto ha', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 15/09/2026', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-alb-albo', name: "Albo dei professionisti", kind: 'allegato', version: 1, at: '2026-01-28T12:00:00+01:00', lines: [ // allow-italian: fixture data, shown as written
        "Albo aperto ai professionisti, singoli o associati, per l'affidamento degli incarichi di assistenza e patrocinio legale dinanzi alle Autorità Giudiziarie e per l'attività stragiudiziale", // allow-italian: fixture data, shown as written
        'In esecuzione della Deliberazione di Deputazione Amministrativa n. 16 del 28.01.2026', // allow-italian: fixture data, shown as written
        "L'elenco degli iscritti è nella documentazione dell'albo", // allow-italian: fixture data, shown as written
      ] },
    ],
    variants: [],
    approvals: [
      step('ap-1', 'cn-legale', 'redige', 'fatto', '2026-09-08T16:00:00+02:00', 'Rotazione scritta nel disciplinare'), // allow-italian: fixture data, shown as written
      step('ap-2', 'cn-ragioneria', 'rivede', 'fatto', '2026-09-10T11:00:00+02:00', 'Stanziamento annuo e pagamenti'), // allow-italian: fixture data, shown as written
      step('ap-3', 'cn-dg', 'approva', 'fatto', '2026-09-12T09:30:00+02:00'), // allow-italian: fixture data, shown as written
      step('ap-4', 'cn-dg', 'firma', 'fatto', '2026-09-15T11:30:00+02:00', 'Firma digitale'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['nocera-contratti', 'nocera-pec'], cards: ['PEC-2412', 'CT-2404'] },
    tags: ['albo dei professionisti', 'rotazione degli incarichi', 'Deputazione Amministrativa n. 16 del 28.01.2026'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'ct-energia-pozzi', title: 'Fornitura di energia elettrica per i pozzi irrigui', kind: 'fornitura', // allow-italian: fixture data, shown as written
    counterparty: 'Energia Esempio S.p.A. (esempio)', counterpartyKind: 'Fornitore', // allow-italian: fixture data, shown as written
    object: "Energia elettrica per i 55 punti di prelievo degli impianti di sollevamento dell'acqua irrigua, uno per ogni pozzo", // allow-italian: fixture data, shown as written
    value: 380000, valuePeriod: 'anno', start: '2025-04-01', end: '2027-03-31', renewal: { kind: 'opzione', months: 12, noticeDays: 90 }, // allow-italian: fixture data, shown as written
    status: 'rinnovo', owner: 'cn-ragioneria', area: 'ragioneria', cig: 'B6D3E18F27', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'cn-ragioneria', at: '2025-03-18T11:00:00+01:00', reason: 'Accordo firmato', signed: true, clauses: revise(BASE['ct-energia-pozzi'], { // allow-italian: fixture data, shown as written
        'art-3': "L'elenco dei punti di prelievo indica per ciascuno la potenza impegnata e il bacino di irrigazione. Il Consorzio può aggiungere un punto di prelievo con una comunicazione via PEC; il prezzo resta quello dell'accordo.", // allow-italian: fixture data, shown as written
        'art-8': 'Il Consorzio non può ridurre la quantità di energia concordata su un punto di prelievo.', // allow-italian: fixture data, shown as written
      }) },
      { n: 2, author: 'cn-ragioneria', at: '2026-02-10T12:00:00+01:00', reason: "Impianti fotovoltaici: riduzione dell'energia senza penale", signed: true, clauses: BASE['ct-energia-pozzi'] }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-en-1', clause: 'art-2', version: 2, what: 'Rinnovo di 12 mesi, da comunicare via PEC o lasciare scadere', owner: 'cn-ragioneria', kind: 'rinnovo', due: '2026-12-31', quote: 'almeno 90 giorni prima della scadenza' }, // allow-italian: fixture data, shown as written
      { id: 'ob-en-2', clause: 'art-5', version: 2, what: 'Letture dei contatori dei pozzi di novembre', owner: 'cn-irrigazione', kind: 'ricorrente', due: '2026-12-05', every: 'entro il 5 di ogni mese', quote: 'entro il giorno 5 di ogni mese' }, // allow-italian: fixture data, shown as written
      { id: 'ob-en-3', clause: 'art-6', version: 2, what: 'Pagamento della fattura di ottobre (FT-2412)', owner: 'cn-ragioneria', kind: 'ricorrente', due: '2026-12-04', every: 'entro 30 giorni dalla fattura', quote: 'entro 30 giorni dal ricevimento della fattura elettronica' }, // allow-italian: fixture data, shown as written
      { id: 'ob-en-4', clause: 'art-7', version: 2, what: 'Interruzione oltre 6 ore da maggio a settembre: euro 400 al giorno per punto', owner: 'cn-irrigazione', kind: 'penale', quote: 'si applica una penale di euro 400 per ogni punto e per ogni giorno intero' }, // allow-italian: fixture data, shown as written
      { id: 'ob-en-5', clause: 'art-8', version: 2, what: "Comunicazione al Fornitore dell'entrata in esercizio di un impianto fotovoltaico", owner: 'cn-irrigazione', kind: 'scadenza', quote: 'dal mese successivo alla comunicazione del Consorzio' }, // allow-italian: fixture data, shown as written
    ],
    comments: [
      { id: 'cm-en-1', clause: 'art-8', version: 2, author: 'cn-irrigazione', at: '2026-02-03T10:20:00+01:00', text: 'Gli impianti fotovoltaici sono in progettazione o in installazione: la riduzione senza penale ci serve scritta prima che partano.', resolved: true, replies: [ // allow-italian: fixture data, shown as written
        { author: 'cn-ragioneria', at: '2026-02-03T12:00:00+01:00', text: 'Scritta nella versione 2, articolo 8.' }, // allow-italian: fixture data, shown as written
      ] },
      { id: 'cm-en-2', clause: 'art-2', version: 2, author: 'cn-dg', at: '2026-10-30T09:30:00+01:00', text: 'Prima di rinnovare voglio due offerte di confronto sullo spread.', replies: [ // allow-italian: fixture data, shown as written
        { author: 'cn-ragioneria', at: '2026-11-03T10:40:00+01:00', text: 'Chieste a due fornitori, risposte entro il 20/11.' }, // allow-italian: fixture data, shown as written
      ] },
    ],
    attachments: [
      signedCopy('at-en-v1', 1, '2025-03-18T11:00:00+01:00', [
        `Scrittura privata tra il ${NOCERA_PARTY}, e Energia Esempio S.p.A. (esempio)`, // allow-italian: fixture data, shown as written
        'Fornitura di energia elettrica per i punti di prelievo degli impianti irrigui, dal 01/04/2025 al 31/03/2027', // allow-italian: fixture data, shown as written
        'Corrispettivo annuo stimato: euro 380.000,00 oltre IVA. Prezzo: media mensile del GME più spread fisso', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 18/03/2025', // allow-italian: fixture data, shown as written
      ]),
      signedCopy('at-en-v2', 2, '2026-02-10T12:00:00+01:00', [
        "Atto modificativo n. 1 all'accordo del 18/03/2025", // allow-italian: fixture data, shown as written
        'Articoli modificati: 3 (punti di prelievo) e 8 (impianti da fonti rinnovabili)', // allow-italian: fixture data, shown as written
        'Il Consorzio può togliere un punto di prelievo, o aggiungerne uno, e ridurre la quantità senza penale quando un impianto fotovoltaico entra in esercizio', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 10/02/2026', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-en-punti', name: 'Elenco dei punti di prelievo', kind: 'allegato', version: 1, at: '2025-03-18T11:00:00+01:00', lines: [ // allow-italian: fixture data, shown as written
        'Elenco dei punti di prelievo degli impianti di sollevamento, per bacino di irrigazione', // allow-italian: fixture data, shown as written
        'Per ogni punto: pozzo, contatore, potenza impegnata', // allow-italian: fixture data, shown as written
        '55 punti di prelievo, uno per ogni pozzo della rete irrigua consortile', // allow-italian: fixture data, shown as written
      ] },
    ],
    variants: [
      { id: 'var-energia-2', title: 'Impianti fotovoltaici: riduzione senza penale', reason: 'Il Consorzio sta progettando o installando impianti fotovoltaici sugli impianti di sollevamento (L.R. 7/2025, art. 10, comma 1)', version: 2, status: 'firmata', at: '2026-01-27T10:00:00+01:00' }, // allow-italian: fixture data, shown as written
    ],
    approvals: [
      step('ap-1', 'cn-ragioneria', 'redige', 'fatto', '2026-01-28T10:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-2', 'cn-irrigazione', 'rivede', 'fatto', '2026-02-03T12:30:00+01:00', 'Punti di prelievo e impianti previsti'), // allow-italian: fixture data, shown as written
      step('ap-3', 'cn-dg', 'approva', 'fatto', '2026-02-06T09:30:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-4', 'cn-dg', 'firma', 'fatto', '2026-02-10T12:00:00+01:00', 'Firma digitale'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['nocera-contratti', 'nocera-fatture'], cards: ['FT-2412'] },
    tags: ['55 pozzi', 'L.R. 7/2025, art. 10 comma 1'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'ct-noleggio-escavatori', title: 'Noleggio di escavatori e autocarri per la manutenzione dei canali', kind: 'fornitura', // allow-italian: fixture data, shown as written
    counterparty: 'Noleggi Esempio S.r.l. (esempio)', counterpartyKind: 'Fornitore', // allow-italian: fixture data, shown as written
    object: 'Noleggio a caldo di escavatori e autocarri per gli espurghi e i tagli di vegetazione dei canali di bonifica, in aggiunta ai mezzi del Consorzio', // allow-italian: fixture data, shown as written
    value: 186000, valuePeriod: 'totale', start: '2025-10-01', end: '2026-09-30', renewal: { kind: 'nessuno', months: 0, noticeDays: 0 }, // allow-italian: fixture data, shown as written
    status: 'scaduto', owner: 'cn-ragioneria', area: 'ragioneria', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'cn-ragioneria', at: '2025-09-24T11:00:00+02:00', reason: 'Contratto firmato', clauses: BASE['ct-noleggio-escavatori'], signed: true }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-nol-1', clause: 'art-8', version: 1, what: 'Verbale di chiusura e fattura finale del Fornitore', owner: 'cn-tecnico', kind: 'scadenza', due: '2026-10-30', quote: 'entro 30 giorni dalla scadenza' }, // allow-italian: fixture data, shown as written
      { id: 'ob-nol-2', clause: 'art-5', version: 1, what: 'Foglio di lavoro firmato dal capo squadra per ogni giornata', owner: 'cn-tecnico', kind: 'ricorrente', every: 'ogni giorno di noleggio', quote: 'firma ogni giorno il foglio di lavoro del mezzo' }, // allow-italian: fixture data, shown as written
      { id: 'ob-nol-3', clause: 'art-5', version: 1, what: 'Ore fatturate uguali alle ore dei fogli di lavoro firmati', owner: 'cn-ragioneria', kind: 'ricorrente', every: 'a ogni fattura', quote: 'fattura ogni mese solo le ore dei fogli firmati' }, // allow-italian: fixture data, shown as written
      { id: 'ob-nol-4', clause: 'art-7', version: 1, what: 'Mezzo fermo oltre 24 ore senza sostituto: euro 250 al giorno', owner: 'cn-tecnico', kind: 'penale', quote: 'si applica una penale di euro 250 per ogni giorno di fermo' }, // allow-italian: fixture data, shown as written
      { id: 'ob-nol-5', clause: 'art-4', version: 1, what: "Mezzo sul canale entro 48 ore dall'ordine", owner: 'cn-tecnico', kind: 'ricorrente', every: 'per ogni ordine di intervento', quote: "entro 48 ore dall'ordine" }, // allow-italian: fixture data, shown as written
    ],
    comments: [
      { id: 'cm-nol-1', clause: 'art-2', version: 1, author: 'cn-tecnico', at: '2026-11-02T09:40:00+01:00', text: 'Il contratto è finito il 30/09 ma la squadra lavora con il noleggio anche a novembre: frana del Canale Lauro (SG-2419).', replies: [ // allow-italian: fixture data, shown as written
        { author: 'cn-legale', at: '2026-11-02T12:10:00+01:00', text: "Novembre e dicembre li copre la determina CT-2390: 240 ore a 80 euro. Per ottobre non c'è un atto che copra il periodo dopo la scadenza: lo segnalo alla Ragioneria insieme alla fattura FT-2413." }, // allow-italian: fixture data, shown as written
      ] },
    ],
    attachments: [
      signedCopy('at-nol-v1', 1, '2025-09-24T11:00:00+02:00', [
        `Scrittura privata tra il ${NOCERA_PARTY}, e Noleggi Esempio S.r.l. (esempio)`, // allow-italian: fixture data, shown as written
        'Noleggio a caldo di escavatori e autocarri, dal 01/10/2025 al 30/09/2026', // allow-italian: fixture data, shown as written
        'Importo massimo: euro 186.000,00 oltre IVA, escavatore con operatore a 80,00 euro all\'ora', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 24/09/2025', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-nol-tariffe', name: 'Tariffe orarie', kind: 'allegato', version: 1, at: '2025-09-24T11:00:00+02:00', lines: [ // allow-italian: fixture data, shown as written
        'Tariffe orarie, allegato al contratto: escavatore cingolato con operatore e carburante 80,00 euro, miniescavatore, autocarro con gru', // allow-italian: fixture data, shown as written
        'Fisse per tutta la durata', // allow-italian: fixture data, shown as written
      ] },
    ],
    variants: [],
    approvals: [
      step('ap-1', 'cn-ragioneria', 'redige', 'fatto', '2025-09-12T10:00:00+02:00'), // allow-italian: fixture data, shown as written
      step('ap-2', 'cn-tecnico', 'rivede', 'fatto', '2025-09-15T14:00:00+02:00', 'Mezzi, ore e tempi di intervento'), // allow-italian: fixture data, shown as written
      step('ap-3', 'cn-dg', 'approva', 'fatto', '2025-09-19T09:00:00+02:00'), // allow-italian: fixture data, shown as written
      step('ap-4', 'cn-dg', 'firma', 'fatto', '2025-09-24T11:00:00+02:00', 'Firma digitale'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['nocera-contratti', 'nocera-fatture', 'nocera-segnalazioni'], cards: ['FT-2413', 'SG-2419', 'CT-2390'] },
    tags: ['manutenzione ordinaria', 'L.R. 7/2025, art. 21'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'ct-convenzione-difesa-suolo', title: 'Convenzione di difesa del suolo con il Comune di Siano', kind: 'servizio', // allow-italian: fixture data, shown as written
    counterparty: 'Comune di Siano (esempio)', counterpartyKind: 'Comune', // allow-italian: fixture data, shown as written
    object: 'Sistemazione idrogeologica del Vallone Truda e del Vallone Orneto per 3 anni, difesa del suolo delegabile (L.R. 7/2025, art. 4)', // allow-italian: fixture data, shown as written
    value: 120000, valuePeriod: 'totale', start: '2026-11-30', end: '2029-11-29', renewal: { kind: 'nessuno', months: 0, noticeDays: 0 }, // allow-italian: fixture data, shown as written
    status: 'revisione', owner: 'cn-legale', area: 'legale', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'agent:ag-contratti', at: '2026-11-06T09:50:00+01:00', reason: 'Schema di convenzione ricevuto dal Comune di Siano', clauses: BASE['ct-convenzione-difesa-suolo'] }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-conv-1', clause: 'art-2', version: 1, what: 'Firma della convenzione', owner: 'cn-legale', kind: 'scadenza', due: '2026-11-30', quote: 'prevista il 30 novembre 2026' }, // allow-italian: fixture data, shown as written
      { id: 'ob-conv-2', clause: 'art-3', version: 1, what: 'Programma degli interventi e cronoprogramma al Comune', owner: 'cn-tecnico', kind: 'scadenza', quote: 'entro 60 giorni dalla firma' }, // allow-italian: fixture data, shown as written
      { id: 'ob-conv-3', clause: 'art-4', version: 1, what: 'Incasso del 30% alla firma', owner: 'cn-ragioneria', kind: 'scadenza', quote: 'trasferiti per il 30% alla firma' }, // allow-italian: fixture data, shown as written
      { id: 'ob-conv-4', clause: 'art-5', version: 1, what: 'Rendiconto semestrale degli interventi e delle spese', owner: 'cn-tecnico', kind: 'rendiconto', due: '2027-05-31', every: 'entro il 31 maggio e il 30 novembre', quote: 'entro il 31 maggio e il 30 novembre' }, // allow-italian: fixture data, shown as written
      { id: 'ob-conv-5', clause: 'art-7', version: 1, what: "Ritardo sul cronoprogramma: 1 per mille dell'importo dell'intervento al giorno", owner: 'cn-tecnico', kind: 'penale', quote: "si applica una penale pari all'1 per mille dell'importo dell'intervento" }, // allow-italian: fixture data, shown as written
      { id: 'ob-conv-6', clause: 'art-8', version: 1, what: "Polizza di responsabilità civile verso terzi prima dell'avvio", owner: 'cn-legale', kind: 'garanzia', due: '2026-12-15', quote: "Prima dell'avvio degli interventi il Consorzio consegna al Comune la polizza" }, // allow-italian: fixture data, shown as written
    ],
    comments: [
      { id: 'cm-conv-1', clause: 'art-4', version: 1, author: 'cn-ragioneria', at: '2026-11-06T10:05:00+01:00', text: "Il 30% alla firma sono 36.000 euro: prima della firma va registrato l'accertamento in entrata." }, // allow-italian: fixture data, shown as written
    ],
    attachments: [
      { id: 'at-conv-schema', name: 'Schema di convenzione del Comune', kind: 'allegato', version: 1, at: '2026-11-06T09:50:00+01:00', lines: [ // allow-italian: fixture data, shown as written
        'Comune di Siano, Provincia di Salerno (esempio)', // allow-italian: fixture data, shown as written
        'Schema di convenzione con il Consorzio per la difesa del suolo sul Vallone Truda e sul Vallone Orneto', // allow-italian: fixture data, shown as written
        'Importo: euro 120.000,00 oltre IVA. Durata: 3 anni dalla firma', // allow-italian: fixture data, shown as written
      ] },
      { id: 'at-conv-elenco', name: 'Elenco degli interventi', kind: 'allegato', version: 1, at: '2026-11-06T09:50:00+01:00', lines: [ // allow-italian: fixture data, shown as written
        'Elenco degli interventi della convenzione, esempio', // allow-italian: fixture data, shown as written
        "Sistemazione idrogeologica del Vallone Truda e del Vallone Orneto (opere dell'art. 6, comma 2 della L.R. 7/2025)", // allow-italian: fixture data, shown as written
        'Rilievi, progetto, esecuzione e collaudo di ogni intervento', // allow-italian: fixture data, shown as written
      ] },
    ],
    variants: [],
    approvals: [
      step('ap-1', 'cn-legale', 'rivede', 'in-attesa', undefined, 'Confronto con le convenzioni già in vigore'), // allow-italian: fixture data, shown as written
      step('ap-2', 'cn-tecnico', 'rivede', 'da-fare', undefined, 'Interventi e cronoprogramma'), // allow-italian: fixture data, shown as written
      step('ap-3', 'cn-dg', 'approva', 'da-fare'), // allow-italian: fixture data, shown as written
      step('ap-4', 'cn-dg', 'firma', 'da-fare', undefined, 'Firma digitale entro il 30/11'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['nocera-contratti'], cards: ['CT-2398'] },
    tags: ['difesa del suolo', 'L.R. 7/2025, art. 4', 'L.R. 7/2025, art. 21'], // allow-italian: fixture data, shown as written
  },
];
