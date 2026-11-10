/**
 * The contracts of the SARIM edition, with their versions, clauses, obligations,
 * comments, attachments, variants and approvals.
 *
 * Seven are real contracts: counterparty, object, value, CIG and dates come from
 * public sources (TED, the ARERA portal, sarimambiente.it) and
 * `scripts/ui-fixtures/sarim-contracts.ts` pins them, so a typo fails the gate.
 * Their clause texts, repertorio numbers, policies and signature dates are
 * examples. The other six are examples with anonymous counterparties.
 *
 * A clause id follows its printed number (`art-9` is «9») and never changes
 * between versions: a later version rewrites words, not ids. Every obligation
 * quotes the words of its clause verbatim, so the screen can highlight them.
 */
import type { ApprovalStep, Clause, Contract, ContractAttachment } from './types';

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

const SARIM_PARTY = 'S.A.R.I.M. SRL, P.IVA 02596800652, sede legale in Corso Vittorio Emanuele 171, 84122 Salerno'; // allow-italian: fixture data, shown as written
const COURT_CLAUSE = 'Per le controversie è competente il foro nella cui circoscrizione ha sede il Comune. È esclusa la competenza arbitrale.'; // allow-italian: fixture data, shown as written

/** The clauses of the reference version of each contract (the one in force, or the only one), by contract id. */
const BASE: Record<string, Clause[]> = {
  'c-castellabate': [
    art(1, 'Oggetto', 'Il Comune di Castellabate affida a S.A.R.I.M. SRL, aggiudicataria della procedura aperta svolta dalla CUC Unione dei Comuni Montedoro (CIG B8B7C39D2A), il servizio di gestione integrata dei rifiuti urbani e di spazzamento delle strade su tutto il territorio comunale.'), // allow-italian: fixture data, shown as written
    art(2, 'Durata e avvio', "Il contratto ha durata di quattro anni, dal 1° aprile 2026 al 31 marzo 2030. L'avvio del servizio risulta dal verbale di consegna firmato dal RUP e dall'Appaltatore."), // allow-italian: fixture data, shown as written
    art(3, 'Documenti del contratto', "Fanno parte del contratto, anche se non allegati, il capitolato speciale d'appalto, l'offerta tecnica ed economica dell'Appaltatore, il DUVRI e il calendario di raccolta approvato dal Comune. In caso di contrasto prevale il capitolato."), // allow-italian: fixture data, shown as written
    art(4, 'Servizi e frequenze', "L'Appaltatore svolge la raccolta porta a porta di umido, carta, plastica e metalli, vetro e secco residuo secondo il calendario approvato dal Comune. Lo spazzamento manuale e meccanizzato si svolge su tutto il territorio con tre passaggi settimanali. Nelle frazioni costiere di Santa Maria, San Marco, Ogliastro Marina e Lago i passaggi salgono a sei a settimana nei mesi da giugno ad agosto."), // allow-italian: fixture data, shown as written
    art(5, 'Mezzi e attrezzature', "L'Appaltatore impiega i mezzi indicati nell'offerta tecnica, in classe Euro 6 o elettrici, e li tiene in efficienza nel proprio deposito. Ogni mezzo ha un localizzatore GPS i cui dati sono messi a disposizione del Comune."), // allow-italian: fixture data, shown as written
    art(6, 'Rapporto mensile e controlli', "Entro il giorno 10 di ogni mese l'Appaltatore trasmette al RUP il rapporto del mese precedente con i servizi eseguiti, le quantità raccolte per frazione e le segnalazioni ricevute. Il Comune può svolgere controlli sul territorio in ogni momento, anche senza preavviso."), // allow-italian: fixture data, shown as written
    art(7, 'Penali', "Per la mancata esecuzione dello spazzamento in una frazione si applica una penale di euro 300 per ogni giorno. Per la mancata raccolta porta a porta in una zona si applica una penale di euro 500 per ogni giorno. Le penali sono contestate per iscritto e nel complesso non superano il 10% dell'importo del contratto."), // allow-italian: fixture data, shown as written
    art(8, 'Garanzia definitiva', "L'Appaltatore ha prestato la garanzia definitiva prevista dall'art. 117 del D.Lgs. 36/2023 con polizza fideiussoria. La garanzia resta valida fino all'emissione del certificato di verifica di conformità e il premio è pagato all'inizio di ogni annualità del contratto."), // allow-italian: fixture data, shown as written
    art(9, 'Corrispettivo e revisione dei prezzi', "L'importo complessivo del contratto è pari a euro 11.375.268,92 oltre IVA, compresi gli oneri per la sicurezza. Il corrispettivo è pagato in 48 rate mensili posticipate di pari importo. I prezzi sono soggetti a revisione secondo la clausola dei documenti di gara, ai sensi dell'art. 60 del D.Lgs. 36/2023."), // allow-italian: fixture data, shown as written
    art(10, 'Pagamenti e tracciabilità', "Il Comune paga ogni rata entro 30 giorni dal ricevimento della fattura elettronica, dopo il visto del RUP sul rapporto mensile e la verifica del DURC. L'Appaltatore assume gli obblighi di tracciabilità dei flussi finanziari della legge 136/2010."), // allow-italian: fixture data, shown as written
    art(11, 'Subappalto', "Il subappalto è ammesso nei limiti dell'art. 119 del D.Lgs. 36/2023 per il lavaggio e la sanificazione dei contenitori, previa autorizzazione del Comune. L'Appaltatore resta responsabile verso il Comune dell'intero servizio."), // allow-italian: fixture data, shown as written
    art(12, 'Personale e clausola sociale', "L'Appaltatore applica al personale il CCNL dei servizi ambientali FISE Assoambiente. In applicazione della clausola sociale del bando assorbe gli 11 lavoratori della Castellabate Servizi srl addetti al servizio alla data del subentro, con il livello e l'anzianità maturati. Entro il 31 gennaio di ogni anno trasmette al Comune l'elenco aggiornato del personale impiegato."), // allow-italian: fixture data, shown as written
  ],
  'c-albanella': [
    art(1, 'Oggetto', 'Il Comune di Albanella affida a S.A.R.I.M. SRL il servizio di raccolta e trasporto dei rifiuti urbani e di igiene urbana, aggiudicato con determina n. 93 del 13/05/2025 (CIG B6242F1551).'), // allow-italian: fixture data, shown as written
    art(2, 'Durata e proroga', "La durata del servizio è di sette anni, dal 1° gennaio 2026 al 31 dicembre 2032; il servizio è partito in esecuzione anticipata disposta dal Comune nelle more della stipula. Il Comune può prorogare il contratto per ulteriori 12 mesi alle stesse condizioni, dandone comunicazione all'Appaltatore almeno 180 giorni prima della scadenza."), // allow-italian: fixture data, shown as written
    art(3, 'Servizi', "L'Appaltatore svolge la raccolta porta a porta delle frazioni differenziate e del secco residuo, il ritiro degli ingombranti su prenotazione dall'app Sarim Ambiente, lo spazzamento delle strade e la gestione delle segnalazioni dei cittadini, ricevute anche su Enviro e al numero verde 800.983850."), // allow-italian: fixture data, shown as written
    art(4, 'Qualità del servizio', "L'Appaltatore rispetta gli standard di qualità della regolazione ARERA sul servizio rifiuti. Le richieste di pronto intervento sono gestite con arrivo sul luogo entro 4 ore dalla segnalazione."), // allow-italian: fixture data, shown as written
    art(5, 'Dati e rendiconti', "Entro il 15 di ogni mese l'Appaltatore trasmette al Comune i quantitativi raccolti nel mese precedente per codice EER, con i formulari di trasporto e le registrazioni RENTRI."), // allow-italian: fixture data, shown as written
    art(6, 'Penali', "Per ogni zona in cui la raccolta porta a porta non è eseguita nel giorno previsto si applica una penale di euro 250 per giorno. Le penali nel complesso non superano il 10% dell'importo del contratto."), // allow-italian: fixture data, shown as written
    art(7, 'Corrispettivo', "L'importo complessivo del contratto è pari a euro 7.559.582,25 oltre IVA, pagato in rate mensili posticipate di pari importo. La revisione dei prezzi segue la clausola dei documenti di gara."), // allow-italian: fixture data, shown as written
    art(8, 'Personale', "Al personale impiegato si applica il CCNL dei servizi ambientali FISE Assoambiente, come prescritto dal bando di gara. L'Appaltatore trasmette al Comune ogni sei mesi l'elenco del personale e il DURC in corso di validità."), // allow-italian: fixture data, shown as written
    art(9, 'Garanzia definitiva', "Prima della stipula l'Appaltatore ha prestato la garanzia definitiva con polizza fideiussoria, valida per tutta la durata del contratto."), // allow-italian: fixture data, shown as written
    art(10, 'Controversie', COURT_CLAUSE), // allow-italian: fixture data, shown as written
  ],
  'c-rocca-priora': [
    art(1, 'Oggetto', 'Il Comune di Rocca Priora affida a S.A.R.I.M. SRL il servizio di igiene urbana: raccolta porta a porta, trasporto dei rifiuti agli impianti di destinazione e spazzamento delle strade.'), // allow-italian: fixture data, shown as written
    art(2, 'Durata', 'Il contratto ha durata di otto anni, dal 2 novembre 2022 al 1° novembre 2030.'), // allow-italian: fixture data, shown as written
    art(3, 'Calendario', "La raccolta segue il calendario approvato dal Comune e pubblicato sull'app Sarim Ambiente. Ogni variazione del calendario è concordata con il Comune e comunicata agli utenti almeno 7 giorni prima."), // allow-italian: fixture data, shown as written
    art(4, 'Rendiconti', "Entro il giorno 10 di ogni mese l'Appaltatore trasmette al Comune il riepilogo dei servizi del mese precedente e i dati per la tariffa."), // allow-italian: fixture data, shown as written
    art(5, 'Penali', 'Per ogni mancata raccolta segnalata e non recuperata entro il giorno successivo si applica una penale di euro 200.'), // allow-italian: fixture data, shown as written
    art(6, 'Corrispettivo', "L'importo complessivo del contratto è pari a euro 13.947.325,33 oltre IVA, pagato in rate mensili posticipate. La revisione dei prezzi segue l'art. 106 del D.Lgs. 50/2016 e i documenti di gara."), // allow-italian: fixture data, shown as written
    art(7, 'Controversie', COURT_CLAUSE), // allow-italian: fixture data, shown as written
  ],
  'c-agropoli': [
    art(1, 'Oggetto', 'Il Comune di Agropoli affida a S.A.R.I.M. SRL, aggiudicataria della gara svolta dalla CUC Paestum Alto Cilento, il servizio di spazzamento, raccolta e trasporto dei rifiuti urbani.'), // allow-italian: fixture data, shown as written
    art(2, 'Durata e proroga', 'Il contratto ha durata di cinque anni, dal 1° ottobre 2022 al 30 settembre 2027. Il Comune può disporre una proroga di 6 mesi, nelle more della nuova gara, comunicandola almeno 120 giorni prima della scadenza.'), // allow-italian: fixture data, shown as written
    art(3, 'Servizi', "L'Appaltatore svolge la raccolta porta a porta, il ritiro degli ingombranti su prenotazione anche dall'app Sarim Ambiente e lo spazzamento, con frequenze rafforzate da giugno a settembre nelle zone del lungomare."), // allow-italian: fixture data, shown as written
    art(4, 'Rendiconti', "Entro il giorno 10 di ogni mese l'Appaltatore trasmette al Comune il rapporto dei servizi e dei quantitativi del mese precedente."), // allow-italian: fixture data, shown as written
    art(5, 'Penali', 'Per ogni servizio non eseguito si applica una penale da euro 150 a euro 1.000 secondo la tabella del capitolato, previa contestazione scritta.'), // allow-italian: fixture data, shown as written
    art(6, 'Corrispettivo e revisione dei prezzi', "L'importo complessivo del contratto è pari a euro 18.061.509,16 oltre IVA, pagato in 60 rate mensili posticipate di pari importo. Su richiesta dell'Appaltatore, presentata entro il 31 gennaio di ogni anno, la rata è aggiornata in base alla variazione dell'indice ISTAT FOI."), // allow-italian: fixture data, shown as written
    art(7, 'Garanzia definitiva', "La garanzia definitiva resta valida fino all'emissione del certificato di verifica di conformità."), // allow-italian: fixture data, shown as written
    art(8, 'Controversie', COURT_CLAUSE), // allow-italian: fixture data, shown as written
  ],
  'c-sarno': [
    art(1, 'Oggetto', 'Il Comune di Sarno affida a S.A.R.I.M. SRL, aggiudicataria della gara svolta dalla CUC Sele-Picentini, il servizio integrato di igiene urbana.'), // allow-italian: fixture data, shown as written
    art(2, 'Durata', "Il contratto decorre dalla data di stipula e ha la durata stabilita dal capitolato speciale d'appalto."), // allow-italian: fixture data, shown as written
    art(3, 'Servizi', 'Il servizio comprende la raccolta porta a porta, il trasporto agli impianti, lo spazzamento, la gestione delle segnalazioni degli utenti e la pubblicazione sul portale dedicato delle informazioni previste da ARERA.'), // allow-italian: fixture data, shown as written
    art(4, 'Reclami', "L'Appaltatore risponde per iscritto ai reclami degli utenti entro 30 giorni lavorativi dal ricevimento."), // allow-italian: fixture data, shown as written
    art(5, 'Rendiconti', "Entro il giorno 10 di ogni mese l'Appaltatore trasmette al Comune il rapporto del mese precedente con quantitativi, segnalazioni e reclami."), // allow-italian: fixture data, shown as written
    art(6, 'Corrispettivo', "L'importo complessivo del contratto è pari a euro 18.840.049,16 oltre IVA, pagato in rate mensili posticipate."), // allow-italian: fixture data, shown as written
    art(7, 'Penali', 'Per ogni servizio non eseguito si applica la penale della tabella del capitolato, previa contestazione scritta e contraddittorio.'), // allow-italian: fixture data, shown as written
  ],
  'c-smart-leaf': [
    art(1, 'Oggetto della concessione', "AMA S.p.A. affida in concessione, con la formula della finanza di progetto, il servizio di spazzamento e raccolta delle foglie sulle strade di Roma indicate negli allegati tecnici, per ogni municipio."), // allow-italian: fixture data, shown as written
    art(2, 'Concessionario e società di progetto', "Il concessionario è il raggruppamento temporaneo di imprese composto da S.A.R.I.M. SRL, capofila, MIRAS Energia e RAVO. La concessione è eseguita dalla società di progetto Smart Leaf srl, che subentra nei rapporti con AMA."), // allow-italian: fixture data, shown as written
    art(3, 'Durata', 'La concessione decorre dal verbale di avvio del servizio e ha la durata indicata nel piano economico finanziario allegato.'), // allow-italian: fixture data, shown as written
    art(4, 'Programma stagionale', "Nel periodo di caduta delle foglie, da ottobre a gennaio, il concessionario svolge lo spazzamento meccanizzato e manuale delle strade indicate da AMA per ogni municipio e trasmette entro il giovedì di ogni settimana il programma dei passaggi della settimana successiva."), // allow-italian: fixture data, shown as written
    art(5, 'Mezzi e tracciati', "Le spazzatrici e i mezzi di supporto hanno un localizzatore GPS. I chilometri spazzati si calcolano dai tracciati GPS, che restano a disposizione di AMA."), // allow-italian: fixture data, shown as written
    art(6, 'Segnalazioni di AMA', "Le segnalazioni trasmesse da AMA, per mail o dal proprio sistema, sono prese in carico entro 4 ore e chiuse entro 24 ore dalla ricezione, con la foto dell'intervento eseguito."), // allow-italian: fixture data, shown as written
    art(7, 'Penali', 'Per ogni segnalazione chiusa oltre le 24 ore si applica una penale di euro 150. Per ogni tratto del programma settimanale non eseguito si applica una penale di euro 400 per giorno.'), // allow-italian: fixture data, shown as written
    art(8, 'Rendiconti ad AMA', "Entro il giorno 5 di ogni mese il concessionario trasmette ad AMA il rendiconto del mese precedente con i chilometri spazzati per municipio, le tonnellate di foglie raccolte e le segnalazioni ricevute e chiuse. Entro il giorno 15 del mese successivo alla chiusura di ogni trimestre trasmette la relazione sull'andamento del piano economico finanziario."), // allow-italian: fixture data, shown as written
    art(9, 'Valore e corrispettivo', "Il valore della concessione è pari a euro 96.855.274,52 oltre IVA. Il corrispettivo è pagato da AMA dopo l'approvazione del rendiconto mensile."), // allow-italian: fixture data, shown as written
    art(10, 'Controversie', 'Per le controversie è competente in via esclusiva il Foro di Roma.'), // allow-italian: fixture data, shown as written
  ],
  'c-vallo': [
    art(1, 'Oggetto', "Il Comune di Vallo della Lucania affida all'ATI composta da S.A.R.I.M. SRL e Nappi Sud il servizio di igiene urbana sul territorio comunale."), // allow-italian: fixture data, shown as written
    art(2, 'Durata e prosecuzione', "Il contratto ha durata fino al 14 marzo 2025. Alla scadenza l'Appaltatore garantisce la prosecuzione del servizio, alle stesse condizioni, per il tempo necessario al subentro del nuovo gestore."), // allow-italian: fixture data, shown as written
    art(3, 'Servizi', 'Il servizio comprende la raccolta differenziata porta a porta, il trasporto agli impianti di destinazione e lo spazzamento delle strade.'), // allow-italian: fixture data, shown as written
    art(4, 'Rendiconti', "Entro il giorno 10 di ogni mese l'Appaltatore trasmette al Comune il riepilogo dei servizi e dei quantitativi del mese precedente."), // allow-italian: fixture data, shown as written
    art(5, 'Corrispettivo', "L'importo complessivo del contratto è pari a euro 9.298.979,61 oltre IVA, pagato in rate mensili posticipate."), // allow-italian: fixture data, shown as written
    art(6, 'Garanzia definitiva', "La garanzia definitiva prestata dall'ATI resta valida fino all'emissione del certificato di verifica di conformità."), // allow-italian: fixture data, shown as written
    art(7, 'Controversie', COURT_CLAUSE), // allow-italian: fixture data, shown as written
  ],
  'c-sub-lavaggio': [
    art(1, 'Oggetto', 'S.A.R.I.M. SRL affida al Subappaltatore il lavaggio e la sanificazione dei contenitori stradali e condominiali nel Comune di Castellabate, parte del servizio che SARIM svolge con il contratto Rep. n. 1873 del 29/01/2026.'), // allow-italian: fixture data, shown as written
    art(2, 'Autorizzazione del committente', "Il contratto è efficace solo dopo l'autorizzazione del Comune di Castellabate prevista dall'art. 11 del contratto principale e dall'art. 119 del D.Lgs. 36/2023. SARIM deposita il contratto presso il Comune almeno 20 giorni prima dell'inizio delle prestazioni, con la documentazione del Subappaltatore."), // allow-italian: fixture data, shown as written
    art(3, 'Durata', 'Le prestazioni iniziano il 1° dicembre 2026, se autorizzate, e terminano il 31 marzo 2030 insieme al contratto principale.'), // allow-italian: fixture data, shown as written
    art(4, 'Prestazioni e frequenze', 'Il Subappaltatore lava e sanifica i contenitori stradali ogni 15 giorni da giugno a settembre e ogni mese nel resto dell\'anno, con mezzi propri. Al termine di ogni giro trasmette a SARIM il rapporto con le foto dei contenitori lavati.'), // allow-italian: fixture data, shown as written
    art(5, 'Corrispettivo e pagamenti', "Il corrispettivo è pari a euro 168.000,00 oltre IVA per l'intera durata, fatturato a rate mensili. SARIM paga entro 60 giorni dalla fattura, previa verifica del DURC."), // allow-italian: fixture data, shown as written
    art(6, 'Personale e sicurezza', 'Il Subappaltatore applica ai propri dipendenti un trattamento non inferiore a quello del CCNL applicato da SARIM e rispetta le misure del DUVRI del contratto principale.'), // allow-italian: fixture data, shown as written
    art(7, 'Penali', 'Per ogni giro di lavaggio non eseguito nella settimana prevista si applica una penale di euro 200, trattenuta sulla prima fattura utile.'), // allow-italian: fixture data, shown as written
    art(8, 'Risoluzione e foro', "Se il Comune nega o revoca l'autorizzazione, il contratto si risolve senza indennizzo per il Subappaltatore. Per le controversie è competente il Foro di Salerno."), // allow-italian: fixture data, shown as written
  ],
  'c-carburante': [
    art(1, 'Oggetto', 'Il Fornitore consegna a S.A.R.I.M. SRL il gasolio per autotrazione ordinato di volta in volta, nel deposito di Eboli, Via Maestri del Lavoro, Area PIP, e nei serbatoi dei cantieri indicati negli ordini.'), // allow-italian: fixture data, shown as written
    art(2, 'Durata e rinnovo', "L'accordo quadro dura 24 mesi, dal 1° febbraio 2025 al 31 gennaio 2027. Alla scadenza si rinnova tacitamente per 12 mesi, salvo disdetta inviata via PEC almeno 60 giorni prima della scadenza."), // allow-italian: fixture data, shown as written
    art(3, 'Importo massimo', "L'importo massimo dell'accordo quadro è pari a euro 2.400.000,00 oltre IVA. Gli ordini non obbligano SARIM a raggiungere l'importo massimo."), // allow-italian: fixture data, shown as written
    art(4, 'Ordini e consegne', 'SARIM ordina per mail o PEC indicando litri, luogo e giorno di consegna. Ogni consegna è accompagnata dal documento di trasporto con i litri a 15 gradi.'), // allow-italian: fixture data, shown as written
    art(5, 'Prezzo', "Il prezzo al litro è pari al prezzo medio settimanale del gasolio per autotrazione pubblicato dal Ministero dell'Ambiente e della Sicurezza Energetica, al netto delle imposte, nella settimana della consegna, più uno spread fisso di euro 0,052 per litro. Accise e IVA sono addebitate a parte."), // allow-italian: fixture data, shown as written
    art(6, 'Fatture e pagamenti', "Il Fornitore emette una fattura per ogni consegna, con il riferimento all'ordine, al documento di trasporto e al prezzo settimanale applicato. SARIM paga a 60 giorni data fattura fine mese."), // allow-italian: fixture data, shown as written
    art(7, 'Penali', "Per ogni consegna eseguita oltre 48 ore dall'ordine si applica una penale pari all'1 per mille del valore della consegna per ogni giorno di ritardo."), // allow-italian: fixture data, shown as written
    art(8, 'Recesso e foro', 'SARIM può recedere con preavviso di 30 giorni via PEC. Per le controversie è competente il Foro di Salerno.'), // allow-italian: fixture data, shown as written
  ],
  'c-officina': [
    art(1, 'Oggetto', "L'Officina esegue la manutenzione ordinaria e straordinaria dei compattatori e delle spazzatrici di S.A.R.I.M. SRL in servizio nella sede di Eboli, secondo i piani del costruttore."), // allow-italian: fixture data, shown as written
    art(2, 'Durata e rinnovo', 'Il contratto dura 24 mesi, dal 1° luglio 2025 al 30 giugno 2027, e si rinnova tacitamente per 12 mesi salvo disdetta inviata via PEC almeno 90 giorni prima della scadenza.'), // allow-italian: fixture data, shown as written
    art(3, 'Importo', "L'importo massimo del contratto è pari a euro 380.000,00 oltre IVA, a misura, secondo il listino orario e ricambi allegato."), // allow-italian: fixture data, shown as written
    art(4, 'Richieste di intervento', "SARIM chiede l'intervento con il modulo del responsabile flotta, indicando targa, guasto e luogo. L'Officina prende in carico il mezzo entro 24 ore dalla richiesta."), // allow-italian: fixture data, shown as written
    art(5, 'Fatture', "L'Officina fattura ogni intervento con il rapportino firmato, la targa del mezzo, le ore e i ricambi. SARIM paga a 60 giorni data fattura fine mese."), // allow-italian: fixture data, shown as written
    art(6, 'Penale per fermo mezzo', "Se il mezzo resta fermo oltre 72 ore dalla presa in carico per cause imputabili all'Officina, si applica una penale di euro 150 per ogni giorno di ulteriore fermo, trattenuta sulla prima fattura utile."), // allow-italian: fixture data, shown as written
    art(7, 'Recesso e foro', 'SARIM può recedere con preavviso di 30 giorni via PEC. Per le controversie è competente il Foro di Salerno.'), // allow-italian: fixture data, shown as written
  ],
  'c-td-castellabate': [
    art(1, 'Oggetto e mansione', 'S.A.R.I.M. SRL assume tre lavoratori a tempo determinato con mansione di operatore ecologico, addetti allo spazzamento e alla raccolta nel cantiere di Castellabate.'), // allow-italian: fixture data, shown as written
    art(2, 'Durata', "Il rapporto decorre dal 1° giugno 2026 e termina il 30 novembre 2026, senza bisogno di preavviso. L'eventuale proroga di 6 mesi è comunicata per iscritto al lavoratore entro il 15 novembre 2026, nei limiti del D.Lgs. 81/2015."), // allow-italian: fixture data, shown as written
    art(3, 'CCNL e inquadramento', "Al rapporto si applica il CCNL dei servizi ambientali FISE Assoambiente, con l'inquadramento e la retribuzione indicati nella lettera di assunzione."), // allow-italian: fixture data, shown as written
    art(4, 'Orario e turni', "L'orario è di 38 ore settimanali, su turni comunicati con almeno 48 ore di anticipo, compresi i turni domenicali del periodo estivo."), // allow-italian: fixture data, shown as written
    art(5, 'Sicurezza e formazione', "Prima dell'inizio il lavoratore riceve la formazione sulla sicurezza e i dispositivi di protezione individuale previsti per la mansione."), // allow-italian: fixture data, shown as written
    art(6, 'Comunicazioni', "La proroga e la cessazione sono comunicate al Centro per l'impiego con il modello UNILAV nei termini di legge."), // allow-italian: fixture data, shown as written
  ],
  'c-accordo-castellabate': [
    art(1, 'Premesse e oggetto', 'Le parti si incontrano per il cambio di gestione del servizio di igiene urbana del Comune di Castellabate, affidato a S.A.R.I.M. SRL dal 1° aprile 2026, e regolano il passaggio del personale della Castellabate Servizi srl in applicazione del CCNL.'), // allow-italian: fixture data, shown as written
    art(2, 'Lavoratori interessati', "Passano alle dipendenze di SARIM gli 11 lavoratori addetti al servizio alla data del cambio di gestione, indicati nell'elenco allegato al verbale."), // allow-italian: fixture data, shown as written
    art(3, 'Trattamento', "Ai lavoratori sono mantenuti il livello di inquadramento, l'anzianità maturata e la retribuzione, con l'applicazione del CCNL dei servizi ambientali FISE Assoambiente."), // allow-italian: fixture data, shown as written
    art(4, 'Data del passaggio', 'Il passaggio decorre dal 1° aprile 2026. SARIM invia le comunicazioni di assunzione entro il giorno precedente.'), // allow-italian: fixture data, shown as written
    art(5, 'Ferie e permessi', 'Le ferie e i permessi maturati e non goduti presso il gestore uscente sono riconosciuti da SARIM e fruiti entro il 30 giugno 2027.'), // allow-italian: fixture data, shown as written
    art(6, 'Verifica', "Le parti si incontrano entro il 30 novembre 2026 per verificare l'applicazione dell'accordo."), // allow-italian: fixture data, shown as written
  ],
  'c-accordo-turni': [
    art(1, 'Oggetto e ambito', "L'accordo regola i turni domenicali e festivi, la reperibilità e le relative indennità del personale operativo della sede di Eboli, Via Maestri del Lavoro, Area PIP, in aggiunta a quanto previsto dal CCNL dei servizi ambientali FISE Assoambiente."), // allow-italian: fixture data, shown as written
    art(2, 'Durata', "L'accordo vale dal 1° luglio 2024 al 30 giugno 2027 e si rinnova tacitamente di anno in anno, salvo disdetta di una delle parti inviata almeno 90 giorni prima della scadenza."), // allow-italian: fixture data, shown as written
    art(3, 'Turni domenicali e festivi', 'Ogni lavoratore copre al massimo due domeniche al mese, a rotazione. I turni domenicali e festivi sono comunicati entro il giorno 20 del mese precedente.'), // allow-italian: fixture data, shown as written
    art(4, 'Reperibilità', 'La reperibilità è organizzata a settimane, con intervento sul posto entro 60 minuti dalla chiamata. Nessun lavoratore è reperibile per più di una settimana al mese.'), // allow-italian: fixture data, shown as written
    art(5, 'Indennità', "Per ogni turno domenicale o festivo è riconosciuta un'indennità di euro 25, oltre alla maggiorazione prevista dal CCNL. L'indennità di reperibilità è di euro 18 per ogni giorno feriale e di euro 28 per ogni giorno festivo. Le indennità sono pagate con la retribuzione del mese successivo."), // allow-italian: fixture data, shown as written
    art(6, 'Verifica', 'Le parti si incontrano ogni tre mesi per verificare i turni sui dati delle presenze.'), // allow-italian: fixture data, shown as written
    art(7, 'Norme finali', 'Per quanto non previsto si applica il CCNL. Le controversie sono esaminate prima da una commissione paritetica aziendale.'), // allow-italian: fixture data, shown as written
  ],
};

export const SARIM_CONTRACTS: Contract[] = [
  {
    id: 'c-castellabate', title: 'Igiene urbana e spazzamento, Comune di Castellabate', kind: 'servizio', // allow-italian: fixture data, shown as written
    counterparty: 'Comune di Castellabate', counterpartyKind: 'Comune', // allow-italian: fixture data, shown as written
    object: 'Gestione integrata dei rifiuti urbani e spazzamento delle strade per 4 anni, gara della CUC Unione dei Comuni Montedoro', // allow-italian: fixture data, shown as written
    value: 11375268.92, valuePeriod: 'totale', start: '2026-04-01', end: '2030-03-31', renewal: { kind: 'nessuno', months: 0, noticeDays: 0 }, // allow-italian: fixture data, shown as written
    status: 'attivo', owner: 'sarim-bruno', area: 'legale', cig: 'B8B7C39D2A', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'sarim-bruno', at: '2025-12-18T11:00:00+01:00', reason: 'Schema di contratto dal capitolato di gara', clauses: revise(BASE['c-castellabate'], { // allow-italian: fixture data, shown as written
        'art-2': "Il contratto ha durata di quattro anni dalla data di avvio del servizio. L'avvio del servizio risulta dal verbale di consegna firmato dal RUP e dall'Appaltatore.", // allow-italian: fixture data, shown as written
        'art-9': "L'importo complessivo del contratto è quello risultante dall'offerta economica dell'aggiudicatario, oltre IVA, compresi gli oneri per la sicurezza. Il corrispettivo è pagato in 48 rate mensili posticipate di pari importo. I prezzi sono soggetti a revisione secondo la clausola dei documenti di gara, ai sensi dell'art. 60 del D.Lgs. 36/2023.", // allow-italian: fixture data, shown as written
        'art-12': "L'Appaltatore applica al personale il CCNL dei servizi ambientali FISE Assoambiente. In applicazione della clausola sociale del bando assorbe i lavoratori del gestore uscente addetti al servizio alla data del subentro, con il livello e l'anzianità maturati. Entro il 31 gennaio di ogni anno trasmette al Comune l'elenco aggiornato del personale impiegato.", // allow-italian: fixture data, shown as written
      }) },
      { n: 2, author: 'sarim-bruno', at: '2026-01-29T12:00:00+01:00', reason: 'Contratto firmato', clauses: BASE['c-castellabate'], signed: true }, // allow-italian: fixture data, shown as written
      { n: 3, author: 'sarim-bruno', draftedBy: 'agent:ag-contratti', at: '2026-11-03T17:10:00+01:00', reason: 'Variante: estensione dello spazzamento estivo nelle frazioni costiere', value: 11853030.2, clauses: revise(BASE['c-castellabate'], { // allow-italian: fixture data, shown as written
        'art-4': "L'Appaltatore svolge la raccolta porta a porta di umido, carta, plastica e metalli, vetro e secco residuo secondo il calendario approvato dal Comune. Lo spazzamento manuale e meccanizzato si svolge su tutto il territorio con tre passaggi settimanali. Nelle frazioni costiere di Santa Maria, San Marco, Ogliastro Marina e Lago i passaggi salgono a sette a settimana nei mesi da giugno a settembre. Nei mesi di luglio e agosto si aggiunge un secondo passaggio pomeridiano sul lungomare di Santa Maria e di San Marco.", // allow-italian: fixture data, shown as written
        'art-9': "L'importo complessivo del contratto è pari a euro 11.853.030,20 oltre IVA, compresi gli oneri per la sicurezza. La variante aggiunge euro 477.761,28 per lo spazzamento estivo nelle frazioni costiere, pari a euro 159.253,76 per ciascuna delle stagioni 2027, 2028 e 2029: un aumento del 4,2% sull'importo iniziale, nei limiti dell'art. 120 del D.Lgs. 36/2023. Il corrispettivo è pagato in 48 rate mensili posticipate di pari importo; la quota estiva in quattro rate mensili da giugno a settembre. I prezzi sono soggetti a revisione secondo la clausola dei documenti di gara, ai sensi dell'art. 60 del D.Lgs. 36/2023.", // allow-italian: fixture data, shown as written
        'art-12': "L'Appaltatore applica al personale il CCNL dei servizi ambientali FISE Assoambiente. In applicazione della clausola sociale del bando assorbe gli 11 lavoratori della Castellabate Servizi srl addetti al servizio alla data del subentro, con il livello e l'anzianità maturati. Entro il 31 gennaio di ogni anno trasmette al Comune l'elenco aggiornato del personale impiegato. Per lo spazzamento estivo nelle frazioni costiere impiega, dal 1° giugno al 30 settembre di ogni stagione, 4 operatori ecologici in più, assunti a tempo determinato con lo stesso CCNL.", // allow-italian: fixture data, shown as written
      }) },
    ],
    obligations: [
      { id: 'ob-cast-1', clause: 'art-6', version: 2, what: 'Rapporto mensile di ottobre al RUP', owner: 'sarim-tecnico', kind: 'rendiconto', due: '2026-11-10', every: 'entro il 10 di ogni mese', quote: "Entro il giorno 10 di ogni mese l'Appaltatore trasmette al RUP il rapporto del mese precedente" }, // allow-italian: fixture data, shown as written
      { id: 'ob-cast-2', clause: 'art-8', version: 2, what: 'Premio annuale della polizza di garanzia definitiva', owner: 'sarim-contabilita', kind: 'garanzia', due: '2027-04-01', every: 'ogni anno, il 1° aprile', quote: "il premio è pagato all'inizio di ogni annualità del contratto" }, // allow-italian: fixture data, shown as written
      { id: 'ob-cast-3', clause: 'art-7', version: 2, what: 'Spazzamento non eseguito in una frazione: euro 300 al giorno', owner: 'sarim-tecnico', kind: 'penale', quote: 'Per la mancata esecuzione dello spazzamento in una frazione si applica una penale di euro 300 per ogni giorno' }, // allow-italian: fixture data, shown as written
      { id: 'ob-cast-4', clause: 'art-12', version: 2, what: 'Elenco aggiornato del personale al Comune', owner: 'sarim-personale', kind: 'ricorrente', due: '2027-01-31', every: 'entro il 31 gennaio di ogni anno', quote: "Entro il 31 gennaio di ogni anno trasmette al Comune l'elenco aggiornato del personale impiegato" }, // allow-italian: fixture data, shown as written
      { id: 'ob-cast-5', clause: 'art-10', version: 2, what: 'Fattura della rata mensile, con DURC valido', owner: 'sarim-contabilita', kind: 'ricorrente', every: 'ogni mese, dopo il visto del RUP', quote: 'dopo il visto del RUP sul rapporto mensile e la verifica del DURC' }, // allow-italian: fixture data, shown as written
      { id: 'ob-cast-6', clause: 'art-4', version: 2, what: 'Frequenze estive dello spazzamento nelle frazioni costiere', owner: 'sarim-tecnico', kind: 'scadenza', due: '2027-06-01', every: 'ogni anno, dal 1° giugno', quote: 'i passaggi salgono a sei a settimana nei mesi da giugno ad agosto' }, // allow-italian: fixture data, shown as written
    ],
    comments: [
      { id: 'cm-cast-1', clause: 'art-2', version: 2, author: 'sarim-tecnico', at: '2026-04-01T15:00:00+01:00', text: 'Avvio confermato dal verbale di consegna di oggi.', resolved: true }, // allow-italian: fixture data, shown as written
      { id: 'cm-cast-2', clause: 'art-9', version: 3, author: 'sarim-contabilita', at: '2026-11-03T11:05:00+01:00', text: "Nella bozza l'aumento è scritto come canone annuo per quattro anni, ma le stagioni estive che restano sono tre: 2027, 2028 e 2029. Va rifatto il conto.", replies: [ // allow-italian: fixture data, shown as written
        { author: 'sarim-bruno', at: '2026-11-03T16:40:00+01:00', text: "Hai ragione. Dopo il tuo commento ho riscritto l'articolo: ora l'importo è per stagione, euro 159.253,76, e il totale è su tre stagioni." }, // allow-italian: fixture data, shown as written
      ] },
      { id: 'cm-cast-3', clause: 'art-4', version: 3, author: 'sarim-tecnico', at: '2026-11-04T09:50:00+01:00', text: 'Il secondo passaggio pomeridiano sul lungomare serve solo a luglio e agosto; a settembre basta quello del mattino.', resolved: true, replies: [ // allow-italian: fixture data, shown as written
        { author: 'sarim-bruno', at: '2026-11-04T10:20:00+01:00', text: 'Va bene, resta come è scritto.' }, // allow-italian: fixture data, shown as written
      ] },
      { id: 'cm-cast-4', clause: 'art-12', version: 3, author: 'sarim-personale', at: '2026-11-04T11:30:00+01:00', text: 'Per i 4 operatori estivi possiamo richiamare i lavoratori a termine di quest\'anno: lo scriviamo nella nota per il Comune?', resolved: true, replies: [ // allow-italian: fixture data, shown as written
        { author: 'sarim-bruno', at: '2026-11-04T11:55:00+01:00', text: 'Nel contratto no, è una scelta nostra. Lo seguiamo nella card PE-118.' }, // allow-italian: fixture data, shown as written
      ] },
    ],
    attachments: [
      signedCopy('at-cast-v2', 2, '2026-01-29T12:00:00+01:00', [
        'Comune di Castellabate, Provincia di Salerno', // allow-italian: fixture data, shown as written
        "Contratto d'appalto per la gestione integrata dei rifiuti urbani e lo spazzamento, CIG B8B7C39D2A", // allow-italian: fixture data, shown as written
        'Rep. n. 1873 del 29/01/2026, in forma pubblica amministrativa a cura del Segretario comunale', // allow-italian: fixture data, shown as written
        `Tra il Comune di Castellabate, rappresentato dal Responsabile del servizio, e ${SARIM_PARTY}`, // allow-italian: fixture data, shown as written
        'Importo: euro 11.375.268,92 oltre IVA. Durata: dal 01/04/2026 al 31/03/2030', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 29/01/2026', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-cast-capitolato', name: "Capitolato speciale d'appalto", kind: 'allegato', version: 2, at: '2025-12-18T11:00:00+01:00', lines: ['CUC Unione dei Comuni Montedoro per il Comune di Castellabate', "Capitolato speciale d'appalto: gestione integrata dei rifiuti urbani e spazzamento", 'Parte prima: servizi, frequenze, mezzi e personale', 'Parte seconda: penali, controlli e rapporti mensili'] }, // allow-italian: fixture data, shown as written
      { id: 'at-cast-duvri', name: 'DUVRI', kind: 'allegato', version: 2, at: '2026-01-29T12:00:00+01:00', lines: ['Documento unico di valutazione dei rischi da interferenze', 'Servizio di igiene urbana del Comune di Castellabate', 'Rischi da interferenza: traffico nelle frazioni costiere, mercati, manifestazioni estive', "Costi della sicurezza da interferenze compresi nell'importo del contratto"] }, // allow-italian: fixture data, shown as written
      { id: 'at-cast-garanzia', name: 'Garanzia definitiva', kind: 'garanzia', version: 2, at: '2026-01-22T10:00:00+01:00', lines: ['Polizza fideiussoria n. FD-2026-00418', 'Garante: Compagnia assicurativa (esempio)', 'Contraente: S.A.R.I.M. SRL. Beneficiario: Comune di Castellabate', "Garanzia definitiva ai sensi dell'art. 117 del D.Lgs. 36/2023, valida fino al certificato di verifica di conformità"] }, // allow-italian: fixture data, shown as written
      { id: 'at-cast-consegna', name: 'Verbale di consegna del servizio', kind: 'verbale', version: 2, at: '2026-04-01T09:00:00+01:00', lines: ['Verbale di consegna del servizio del 01/04/2026', 'Presenti: il RUP del Comune di Castellabate e il Responsabile tecnico di S.A.R.I.M. SRL', 'Il servizio parte il 01/04/2026; gli 11 lavoratori della Castellabate Servizi srl passano a S.A.R.I.M. SRL'] }, // allow-italian: fixture data, shown as written
      { id: 'at-cast-variante', name: 'Proposta di variante n. 1', kind: 'variante', version: 3, at: '2026-11-03T17:10:00+01:00', lines: [ // allow-italian: fixture data, shown as written
        'Proposta di variante n. 1 al contratto Rep. n. 1873 del 29/01/2026', // allow-italian: fixture data, shown as written
        'Motivo: spazzamento estivo delle frazioni costiere esteso a settembre, con un secondo passaggio sul lungomare a luglio e agosto', // allow-italian: fixture data, shown as written
        'Articoli modificati: 4 (servizi e frequenze), 9 (corrispettivo), 12 (personale)', // allow-italian: fixture data, shown as written
        "Importo della variante: euro 477.761,28, pari al 4,2% dell'importo iniziale", // allow-italian: fixture data, shown as written
        'Nuovo importo complessivo: euro 11.853.030,20 oltre IVA', // allow-italian: fixture data, shown as written
        'Da approvare: Direttore generale. Da controfirmare: RUP del Comune di Castellabate', // allow-italian: fixture data, shown as written
      ] },
    ],
    variants: [
      { id: 'var-castellabate-3', title: 'Spazzamento estivo nelle frazioni costiere', reason: "Il Comune chiede lo spazzamento estivo anche a settembre e un secondo passaggio sul lungomare a luglio e agosto", version: 3, status: 'in-corso', card: 'CT-V07', at: '2026-11-02T18:20:00+01:00' }, // allow-italian: fixture data, shown as written
    ],
    approvals: [
      step('ap-1', 'sarim-bruno', 'redige', 'fatto', '2026-11-03T17:10:00+01:00', "Bozza dell'agente contratti rivista: articoli 4, 9 e 12"), // allow-italian: fixture data, shown as written
      step('ap-2', 'sarim-tecnico', 'rivede', 'fatto', '2026-11-04T12:30:00+01:00', 'Frequenze e operatori verificati sul programma estivo'), // allow-italian: fixture data, shown as written
      step('ap-3', 'sarim-dg', 'approva', 'in-attesa', undefined, 'Variante al 4,2% del valore iniziale'), // allow-italian: fixture data, shown as written
      step('ap-4', 'sarim-dg', 'firma', 'da-fare'), // allow-italian: fixture data, shown as written
      step('ap-5', 'sarim-bruno', 'controfirma', 'da-fare', undefined, 'Invio al RUP del Comune per la controfirma via PEC'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['sarim-varianti'], cards: ['CT-V07'] },
    tags: ['CUC Unione dei Comuni Montedoro', 'clausola sociale', 'CCNL FISE Assoambiente'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'c-albanella', title: 'Raccolta e igiene urbana, Comune di Albanella', kind: 'servizio', // allow-italian: fixture data, shown as written
    counterparty: 'Comune di Albanella', counterpartyKind: 'Comune', // allow-italian: fixture data, shown as written
    object: 'Raccolta e trasporto dei rifiuti urbani e igiene urbana per 7 anni, con eventuale proroga di 12 mesi', // allow-italian: fixture data, shown as written
    value: 7559582.25, valuePeriod: 'totale', start: '2026-01-01', end: '2032-12-31', renewal: { kind: 'opzione', months: 12, noticeDays: 180 }, // allow-italian: fixture data, shown as written
    status: 'attivo', owner: 'sarim-bruno', area: 'legale', cig: 'B6242F1551', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'sarim-bruno', at: '2025-06-10T10:00:00+01:00', reason: 'Schema di contratto dopo la determina n. 93 del 13/05/2025', clauses: revise(BASE['c-albanella'], { // allow-italian: fixture data, shown as written
        'art-2': "La durata del servizio è di sette anni dalla data di avvio dell'esecuzione. Il Comune può prorogare il contratto per ulteriori 12 mesi alle stesse condizioni, dandone comunicazione all'Appaltatore almeno 180 giorni prima della scadenza.", // allow-italian: fixture data, shown as written
        'art-7': "L'importo complessivo del contratto è quello risultante dall'offerta economica dell'aggiudicatario, oltre IVA, pagato in rate mensili posticipate di pari importo. La revisione dei prezzi segue la clausola dei documenti di gara.", // allow-italian: fixture data, shown as written
      }) },
      { n: 2, author: 'sarim-bruno', at: '2026-11-04T16:30:00+01:00', reason: 'Contratto firmato digitalmente', clauses: BASE['c-albanella'], signed: true }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-alb-1', clause: 'art-2', version: 2, what: 'Sentire il Comune sulla proroga di 12 mesi', owner: 'sarim-bruno', kind: 'rinnovo', due: '2032-07-04', quote: 'almeno 180 giorni prima della scadenza' }, // allow-italian: fixture data, shown as written
      { id: 'ob-alb-2', clause: 'art-5', version: 2, what: 'Quantitativi di ottobre per codice EER, con formulari e RENTRI', owner: 'sarim-callcenter', kind: 'rendiconto', due: '2026-11-15', every: 'entro il 15 di ogni mese', quote: "Entro il 15 di ogni mese l'Appaltatore trasmette al Comune i quantitativi raccolti nel mese precedente per codice EER" }, // allow-italian: fixture data, shown as written
      { id: 'ob-alb-3', clause: 'art-4', version: 2, what: 'Pronto intervento sul posto entro 4 ore', owner: 'sarim-callcenter', kind: 'ricorrente', every: 'per ogni richiesta di pronto intervento', quote: 'arrivo sul luogo entro 4 ore dalla segnalazione' }, // allow-italian: fixture data, shown as written
      { id: 'ob-alb-4', clause: 'art-6', version: 2, what: 'Raccolta non eseguita in una zona: euro 250 al giorno', owner: 'sarim-tecnico', kind: 'penale', quote: 'si applica una penale di euro 250 per giorno' }, // allow-italian: fixture data, shown as written
      { id: 'ob-alb-5', clause: 'art-8', version: 2, what: 'Elenco del personale e DURC al Comune', owner: 'sarim-personale', kind: 'ricorrente', due: '2027-01-15', every: 'ogni sei mesi, a gennaio e a luglio', quote: "trasmette al Comune ogni sei mesi l'elenco del personale e il DURC in corso di validità" }, // allow-italian: fixture data, shown as written
      { id: 'ob-alb-6', clause: 'art-9', version: 2, what: 'Garanzia definitiva prima della stipula', owner: 'sarim-contabilita', kind: 'garanzia', due: '2026-10-15', done: true, quote: "Prima della stipula l'Appaltatore ha prestato la garanzia definitiva" }, // allow-italian: fixture data, shown as written
    ],
    comments: [
      { id: 'cm-alb-1', clause: 'art-8', version: 2, author: 'sarim-personale', at: '2026-10-21T11:00:00+01:00', text: 'La clausola sul CCNL è quella del bando, parola per parola: la chiudiamo ai commenti?', resolved: true, replies: [ // allow-italian: fixture data, shown as written
        { author: 'sarim-bruno', at: '2026-10-21T12:15:00+01:00', text: "Sì, resta com'è." }, // allow-italian: fixture data, shown as written
      ] },
      { id: 'cm-alb-2', clause: 'art-2', version: 2, author: 'sarim-dg', at: '2026-10-27T09:30:00+01:00', text: "La proroga la decide il Comune, ma voglio comunque l'avviso 180 giorni prima della scadenza.", resolved: true, replies: [ // allow-italian: fixture data, shown as written
        { author: 'sarim-bruno', at: '2026-10-27T10:05:00+01:00', text: 'Messo tra le scadenze del contratto: 04/07/2032.' }, // allow-italian: fixture data, shown as written
      ] },
    ],
    attachments: [
      signedCopy('at-alb-v2', 2, '2026-11-04T16:30:00+01:00', [
        'Comune di Albanella, Provincia di Salerno', // allow-italian: fixture data, shown as written
        'Contratto per il servizio di raccolta e trasporto dei rifiuti urbani e igiene urbana, CIG B6242F1551', // allow-italian: fixture data, shown as written
        'Rep. n. 412 del 04/11/2026. Aggiudicazione: determina n. 93 del 13/05/2025', // allow-italian: fixture data, shown as written
        `Tra il Comune di Albanella e ${SARIM_PARTY}`, // allow-italian: fixture data, shown as written
        'Importo: euro 7.559.582,25 oltre IVA. Durata: dal 01/01/2026 al 31/12/2032, con eventuale proroga di 12 mesi', // allow-italian: fixture data, shown as written
        'Firmato digitalmente: per S.A.R.I.M. SRL il 04/11/2026 alle 10:15, per il Comune il 04/11/2026 alle 16:12', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-alb-capitolato', name: "Capitolato speciale d'appalto", kind: 'allegato', version: 1, at: '2025-06-10T10:00:00+01:00', lines: ['Comune di Albanella', "Capitolato speciale d'appalto: raccolta e trasporto dei rifiuti urbani e igiene urbana", 'Durata: 7 anni, con eventuale proroga di 12 mesi', 'Personale: applicazione del CCNL dei servizi ambientali FISE Assoambiente'] }, // allow-italian: fixture data, shown as written
      { id: 'at-alb-avvio', name: 'Verbale di avvio in esecuzione anticipata', kind: 'verbale', version: 1, at: '2025-12-30T12:00:00+01:00', lines: ['Verbale di avvio in esecuzione anticipata', 'Il servizio parte il 01/01/2026, nelle more della stipula del contratto', 'Presenti: il RUP del Comune di Albanella e il Responsabile tecnico di S.A.R.I.M. SRL'] }, // allow-italian: fixture data, shown as written
      { id: 'at-alb-garanzia', name: 'Garanzia definitiva', kind: 'garanzia', version: 2, at: '2026-10-15T10:00:00+01:00', lines: ['Polizza fideiussoria n. FD-2026-01127', 'Garante: Compagnia assicurativa (esempio)', 'Contraente: S.A.R.I.M. SRL. Beneficiario: Comune di Albanella', 'Garanzia definitiva, valida per tutta la durata del contratto'] }, // allow-italian: fixture data, shown as written
    ],
    variants: [],
    approvals: [
      step('ap-1', 'sarim-bruno', 'redige', 'fatto', '2026-10-20T16:00:00+01:00', "Schema aggiornato con la data di avvio e l'importo di aggiudicazione"), // allow-italian: fixture data, shown as written
      step('ap-2', 'sarim-tecnico', 'rivede', 'fatto', '2026-10-23T11:20:00+01:00', 'Servizi uguali al progetto tecnico'), // allow-italian: fixture data, shown as written
      step('ap-3', 'sarim-dg', 'approva', 'fatto', '2026-10-28T09:45:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-4', 'sarim-dg', 'firma', 'fatto', '2026-11-04T10:15:00+01:00', 'Firma digitale'), // allow-italian: fixture data, shown as written
      step('ap-5', 'sarim-bruno', 'controfirma', 'fatto', '2026-11-04T16:30:00+01:00', 'Firmato dal Comune e ricevuto via PEC'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['sarim-varianti'], cards: ['CT-F01'] },
    tags: ['segnalazioni dei cittadini su Enviro', 'CCNL FISE Assoambiente'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'c-rocca-priora', title: 'Igiene urbana, Comune di Rocca Priora', kind: 'servizio', // allow-italian: fixture data, shown as written
    counterparty: 'Comune di Rocca Priora', counterpartyKind: 'Comune', // allow-italian: fixture data, shown as written
    object: 'Servizio di igiene urbana per 8 anni', // allow-italian: fixture data, shown as written
    value: 13947325.33, valuePeriod: 'totale', start: '2022-11-02', end: '2030-11-01', renewal: { kind: 'nessuno', months: 0, noticeDays: 0 }, // allow-italian: fixture data, shown as written
    status: 'attivo', owner: 'sarim-bruno', area: 'legale', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'sarim-bruno', at: '2022-11-02T11:00:00+01:00', reason: 'Contratto firmato', clauses: BASE['c-rocca-priora'], signed: true }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-rp-1', clause: 'art-4', version: 1, what: 'Riepilogo dei servizi di ottobre al Comune', owner: 'sarim-tecnico', kind: 'rendiconto', due: '2026-11-10', every: 'entro il 10 di ogni mese', quote: "Entro il giorno 10 di ogni mese l'Appaltatore trasmette al Comune il riepilogo dei servizi del mese precedente" }, // allow-italian: fixture data, shown as written
      { id: 'ob-rp-2', clause: 'art-3', version: 1, what: 'Avviso agli utenti 7 giorni prima di ogni cambio di calendario', owner: 'sarim-callcenter', kind: 'ricorrente', every: 'a ogni variazione del calendario', quote: 'comunicata agli utenti almeno 7 giorni prima' }, // allow-italian: fixture data, shown as written
      { id: 'ob-rp-3', clause: 'art-5', version: 1, what: 'Raccolta non recuperata il giorno dopo: euro 200', owner: 'sarim-tecnico', kind: 'penale', quote: 'si applica una penale di euro 200' }, // allow-italian: fixture data, shown as written
      { id: 'ob-rp-4', clause: 'art-2', version: 1, what: 'Fine del contratto: prepararsi alla nuova gara', owner: 'sarim-bruno', kind: 'scadenza', due: '2030-11-01', quote: 'dal 2 novembre 2022 al 1° novembre 2030' }, // allow-italian: fixture data, shown as written
    ],
    comments: [],
    attachments: [
      signedCopy('at-rp-v1', 1, '2022-11-02T11:00:00+01:00', [
        'Comune di Rocca Priora, Città metropolitana di Roma Capitale', // allow-italian: fixture data, shown as written
        'Contratto per il servizio di igiene urbana. Rep. n. 2207 del 02/11/2022', // allow-italian: fixture data, shown as written
        `Tra il Comune di Rocca Priora e ${SARIM_PARTY}`, // allow-italian: fixture data, shown as written
        'Importo: euro 13.947.325,33 oltre IVA. Durata: 8 anni, dal 02/11/2022 al 01/11/2030', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 02/11/2022', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-rp-capitolato', name: "Capitolato speciale d'appalto", kind: 'allegato', version: 1, at: '2022-11-02T11:00:00+01:00', lines: ['Comune di Rocca Priora', "Capitolato speciale d'appalto: servizio di igiene urbana", 'Servizi, calendario, mezzi, penali e rendiconti'] }, // allow-italian: fixture data, shown as written
    ],
    variants: [],
    approvals: [
      step('ap-1', 'sarim-bruno', 'redige', 'fatto', '2022-10-20T10:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-2', 'sarim-dg', 'approva', 'fatto', '2022-10-27T12:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-3', 'sarim-dg', 'firma', 'fatto', '2022-11-02T11:00:00+01:00', 'Firma digitale'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: [], cards: [] },
  },
  {
    id: 'c-agropoli', title: 'Spazzamento, raccolta e trasporto, Comune di Agropoli', kind: 'servizio', // allow-italian: fixture data, shown as written
    counterparty: 'Comune di Agropoli', counterpartyKind: 'Comune', // allow-italian: fixture data, shown as written
    object: 'Spazzamento, raccolta e trasporto dei rifiuti urbani per 5 anni, gara della CUC Paestum Alto Cilento', // allow-italian: fixture data, shown as written
    value: 18061509.16, valuePeriod: 'totale', start: '2022-10-01', end: '2027-09-30', renewal: { kind: 'opzione', months: 6, noticeDays: 120 }, // allow-italian: fixture data, shown as written
    status: 'attivo', owner: 'sarim-bruno', area: 'legale', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'sarim-bruno', at: '2022-09-27T11:00:00+01:00', reason: 'Contratto firmato', clauses: BASE['c-agropoli'], signed: true }, // allow-italian: fixture data, shown as written
      { n: 2, author: 'sarim-bruno', at: '2025-01-15T12:00:00+01:00', reason: 'Adeguamento ISTAT del canone', value: 18597936.04, signed: true, clauses: revise(BASE['c-agropoli'], { // allow-italian: fixture data, shown as written
        'art-6': "L'importo complessivo del contratto è pari a euro 18.597.936,04 oltre IVA, pagato in 60 rate mensili posticipate. Dal 1° gennaio 2025 la rata mensile è aggiornata del 5,4% per la variazione dell'indice ISTAT FOI e passa da euro 301.025,15 a euro 317.280,51 per le 33 rate che restano. Su richiesta dell'Appaltatore, presentata entro il 31 gennaio di ogni anno, la rata è aggiornata in base alla variazione dell'indice ISTAT FOI.", // allow-italian: fixture data, shown as written
      }) },
    ],
    obligations: [
      { id: 'ob-agr-1', clause: 'art-2', version: 2, what: 'Sentire il Comune sulla proroga di 6 mesi', owner: 'sarim-bruno', kind: 'rinnovo', due: '2027-06-02', quote: 'comunicandola almeno 120 giorni prima della scadenza' }, // allow-italian: fixture data, shown as written
      { id: 'ob-agr-2', clause: 'art-6', version: 2, what: 'Richiesta di aggiornamento ISTAT della rata', owner: 'sarim-contabilita', kind: 'scadenza', due: '2027-01-31', every: 'entro il 31 gennaio di ogni anno', quote: 'presentata entro il 31 gennaio di ogni anno' }, // allow-italian: fixture data, shown as written
      { id: 'ob-agr-3', clause: 'art-4', version: 2, what: 'Rapporto di ottobre al Comune', owner: 'sarim-tecnico', kind: 'rendiconto', due: '2026-11-10', every: 'entro il 10 di ogni mese', quote: "Entro il giorno 10 di ogni mese l'Appaltatore trasmette al Comune il rapporto dei servizi e dei quantitativi del mese precedente" }, // allow-italian: fixture data, shown as written
      { id: 'ob-agr-4', clause: 'art-5', version: 2, what: 'Servizio non eseguito: da euro 150 a euro 1.000', owner: 'sarim-tecnico', kind: 'penale', quote: 'si applica una penale da euro 150 a euro 1.000 secondo la tabella del capitolato' }, // allow-italian: fixture data, shown as written
    ],
    comments: [],
    attachments: [
      signedCopy('at-agr-v1', 1, '2022-09-27T11:00:00+01:00', [
        'Comune di Agropoli, Provincia di Salerno. Gara della CUC Paestum Alto Cilento', // allow-italian: fixture data, shown as written
        'Contratto per il servizio di spazzamento, raccolta e trasporto dei rifiuti urbani. Rep. n. 3318 del 27/09/2022', // allow-italian: fixture data, shown as written
        `Tra il Comune di Agropoli e ${SARIM_PARTY}`, // allow-italian: fixture data, shown as written
        'Importo: euro 18.061.509,16 oltre IVA. Durata: dal 01/10/2022 al 30/09/2027', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 27/09/2022', // allow-italian: fixture data, shown as written
      ]),
      signedCopy('at-agr-v2', 2, '2025-01-15T12:00:00+01:00', [
        'Atto aggiuntivo n. 1 al contratto Rep. n. 3318 del 27/09/2022', // allow-italian: fixture data, shown as written
        "Adeguamento ISTAT FOI della rata mensile dal 01/01/2025: più 5,4%", // allow-italian: fixture data, shown as written
        'Nuovo importo complessivo: euro 18.597.936,04 oltre IVA', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 15/01/2025', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-agr-garanzia', name: 'Garanzia definitiva', kind: 'garanzia', version: 1, at: '2022-09-20T10:00:00+01:00', lines: ['Polizza fideiussoria n. FD-2022-00961', 'Garante: Compagnia assicurativa (esempio)', 'Beneficiario: Comune di Agropoli', 'Valida fino al certificato di verifica di conformità'] }, // allow-italian: fixture data, shown as written
    ],
    variants: [
      { id: 'var-agropoli-2', title: 'Adeguamento ISTAT del canone', reason: "Richiesta di aggiornamento della rata per la variazione dell'indice ISTAT FOI, presentata il 20/12/2024", version: 2, status: 'firmata', at: '2024-12-20T10:00:00+01:00' }, // allow-italian: fixture data, shown as written
    ],
    approvals: [
      step('ap-1', 'sarim-bruno', 'redige', 'fatto', '2025-01-08T10:00:00+01:00', 'Atto aggiuntivo sulla rata mensile'), // allow-italian: fixture data, shown as written
      step('ap-2', 'sarim-contabilita', 'rivede', 'fatto', '2025-01-09T15:00:00+01:00', 'Conto della rata e delle 33 rate verificato'), // allow-italian: fixture data, shown as written
      step('ap-3', 'sarim-dg', 'approva', 'fatto', '2025-01-10T09:30:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-4', 'sarim-dg', 'firma', 'fatto', '2025-01-15T12:00:00+01:00', 'Firma digitale'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['sarim-varianti'], cards: [] },
    tags: ['CUC Paestum Alto Cilento'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'c-sarno', title: 'Servizio integrato di igiene urbana, Comune di Sarno', kind: 'servizio', // allow-italian: fixture data, shown as written
    counterparty: 'Comune di Sarno', counterpartyKind: 'Comune', // allow-italian: fixture data, shown as written
    object: 'Servizio integrato di igiene urbana, gara della CUC Sele-Picentini', // allow-italian: fixture data, shown as written
    value: 18840049.16, valuePeriod: 'totale', start: '2022-09-30', end: '', renewal: { kind: 'nessuno', months: 0, noticeDays: 0 }, // allow-italian: fixture data, shown as written
    status: 'attivo', owner: 'sarim-bruno', area: 'legale', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'sarim-bruno', at: '2022-09-30T11:00:00+01:00', reason: 'Contratto firmato', clauses: BASE['c-sarno'], signed: true }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-sar-1', clause: 'art-5', version: 1, what: 'Rapporto di ottobre al Comune', owner: 'sarim-tecnico', kind: 'rendiconto', due: '2026-11-10', every: 'entro il 10 di ogni mese', quote: "Entro il giorno 10 di ogni mese l'Appaltatore trasmette al Comune il rapporto del mese precedente" }, // allow-italian: fixture data, shown as written
      { id: 'ob-sar-2', clause: 'art-4', version: 1, what: 'Risposta scritta ai reclami degli utenti', owner: 'sarim-callcenter', kind: 'ricorrente', every: 'per ogni reclamo', quote: 'entro 30 giorni lavorativi dal ricevimento' }, // allow-italian: fixture data, shown as written
      { id: 'ob-sar-3', clause: 'art-7', version: 1, what: 'Servizio non eseguito: penale del capitolato', owner: 'sarim-tecnico', kind: 'penale', quote: 'si applica la penale della tabella del capitolato' }, // allow-italian: fixture data, shown as written
    ],
    comments: [],
    attachments: [
      signedCopy('at-sar-v1', 1, '2022-09-30T11:00:00+01:00', [
        'Comune di Sarno, Provincia di Salerno. Gara della CUC Sele-Picentini', // allow-italian: fixture data, shown as written
        'Contratto per il servizio integrato di igiene urbana. Rep. n. 5129 del 30/09/2022', // allow-italian: fixture data, shown as written
        `Tra il Comune di Sarno e ${SARIM_PARTY}`, // allow-italian: fixture data, shown as written
        'Importo: euro 18.840.049,16 oltre IVA', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 30/09/2022', // allow-italian: fixture data, shown as written
      ]),
    ],
    variants: [],
    approvals: [
      step('ap-1', 'sarim-bruno', 'redige', 'fatto', '2022-09-19T10:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-2', 'sarim-dg', 'approva', 'fatto', '2022-09-26T12:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-3', 'sarim-dg', 'firma', 'fatto', '2022-09-30T11:00:00+01:00', 'Firma digitale'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: [], cards: [] },
    tags: ['CUC Sele-Picentini', 'a Sarno dal 1992'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'c-smart-leaf', title: 'Smart Leaf, spazzamento delle foglie a Roma', kind: 'appalto', // allow-italian: fixture data, shown as written
    counterparty: 'AMA S.p.A.', counterpartyKind: 'Committente', // allow-italian: fixture data, shown as written
    object: 'Concessione in project financing per lo spazzamento delle foglie di Roma, RTI con SARIM capofila, MIRAS Energia e RAVO', // allow-italian: fixture data, shown as written
    value: 96855274.52, valuePeriod: 'totale', start: '2024-10-01', end: '', renewal: { kind: 'nessuno', months: 0, noticeDays: 0 }, // allow-italian: fixture data, shown as written
    status: 'attivo', owner: 'sarim-bruno', area: 'legale', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'sarim-bruno', at: '2024-09-20T11:00:00+01:00', reason: 'Contratto di concessione firmato', clauses: BASE['c-smart-leaf'], signed: true }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-sl-1', clause: 'art-8', version: 1, what: 'Rendiconto di ottobre ad AMA: km spazzati, foglie raccolte, segnalazioni', owner: 'sarim-callcenter', kind: 'rendiconto', due: '2026-11-05', every: 'entro il 5 di ogni mese', quote: 'Entro il giorno 5 di ogni mese il concessionario trasmette ad AMA il rendiconto del mese precedente' }, // allow-italian: fixture data, shown as written
      { id: 'ob-sl-2', clause: 'art-8', version: 1, what: 'Relazione trimestrale sul piano economico finanziario', owner: 'sarim-contabilita', kind: 'rendiconto', due: '2027-01-15', every: 'entro il 15 del mese dopo ogni trimestre', quote: 'Entro il giorno 15 del mese successivo alla chiusura di ogni trimestre' }, // allow-italian: fixture data, shown as written
      { id: 'ob-sl-3', clause: 'art-6', version: 1, what: 'Segnalazioni AMA: presa in carico entro 4 ore, chiusura entro 24', owner: 'sarim-callcenter', kind: 'ricorrente', every: 'per ogni segnalazione AMA', quote: 'sono prese in carico entro 4 ore e chiuse entro 24 ore dalla ricezione' }, // allow-italian: fixture data, shown as written
      { id: 'ob-sl-4', clause: 'art-7', version: 1, what: 'Segnalazione chiusa oltre le 24 ore: euro 150', owner: 'sarim-callcenter', kind: 'penale', quote: 'Per ogni segnalazione chiusa oltre le 24 ore si applica una penale di euro 150' }, // allow-italian: fixture data, shown as written
      { id: 'ob-sl-5', clause: 'art-4', version: 1, what: 'Programma dei passaggi della settimana dopo, per municipio', owner: 'sarim-tecnico', kind: 'ricorrente', due: '2026-11-12', every: 'ogni giovedì', quote: 'trasmette entro il giovedì di ogni settimana il programma dei passaggi della settimana successiva' }, // allow-italian: fixture data, shown as written
    ],
    comments: [
      { id: 'cm-sl-1', clause: 'art-6', version: 1, author: 'sarim-dg', at: '2026-10-12T09:10:00+01:00', text: "Le 4 ore partono dalla mail di AMA, non dalla telefonata: teniamone conto nei turni del call center.", resolved: true }, // allow-italian: fixture data, shown as written
      { id: 'cm-sl-2', clause: 'art-8', version: 1, author: 'sarim-callcenter', at: '2026-11-05T17:30:00+01:00', text: 'Il rendiconto di ottobre è in verifica nella card SG-F10: parte per AMA appena controllati i km per municipio.', replies: [ // allow-italian: fixture data, shown as written
        { author: 'sarim-dg', at: '2026-11-06T08:45:00+01:00', text: 'Siamo già fuori di un giorno: chiudiamolo oggi.' }, // allow-italian: fixture data, shown as written
      ] },
    ],
    attachments: [
      signedCopy('at-sl-v1', 1, '2024-09-20T11:00:00+01:00', [
        'AMA S.p.A., Roma', // allow-italian: fixture data, shown as written
        'Contratto di concessione in finanza di progetto: servizio Smart Leaf di spazzamento delle foglie', // allow-italian: fixture data, shown as written
        'Concessionario: RTI S.A.R.I.M. SRL (capofila), MIRAS Energia, RAVO; società di progetto Smart Leaf srl', // allow-italian: fixture data, shown as written
        'Aggiudicazione del 30/07/2024. Valore della concessione: euro 96.855.274,52 oltre IVA', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 20/09/2024', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-sl-pef', name: 'Piano economico finanziario', kind: 'allegato', version: 1, at: '2024-09-20T11:00:00+01:00', lines: ['Piano economico finanziario della concessione Smart Leaf', 'Allegato al contratto di concessione', 'Ricavi, costi e investimenti per ogni anno della concessione'] }, // allow-italian: fixture data, shown as written
    ],
    variants: [],
    approvals: [
      step('ap-1', 'sarim-bruno', 'redige', 'fatto', '2024-09-05T10:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-2', 'sarim-tecnico', 'rivede', 'fatto', '2024-09-10T16:00:00+01:00', 'Programma stagionale e mezzi'), // allow-italian: fixture data, shown as written
      step('ap-3', 'sarim-dg', 'approva', 'fatto', '2024-09-16T09:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-4', 'sarim-dg', 'firma', 'fatto', '2024-09-20T11:00:00+01:00', 'Firma digitale per il RTI'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['sarim-segnalazioni', 'sarim-foglie'], cards: ['SG-F10'] },
    tags: ['RTI capofila', 'project financing', 'Smart Leaf srl'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'c-vallo', title: 'Igiene urbana, Comune di Vallo della Lucania', kind: 'servizio', // allow-italian: fixture data, shown as written
    counterparty: 'Comune di Vallo della Lucania', counterpartyKind: 'Comune', // allow-italian: fixture data, shown as written
    object: 'Servizio di igiene urbana in ATI tra SARIM e Nappi Sud', // allow-italian: fixture data, shown as written
    value: 9298979.61, valuePeriod: 'totale', start: '2017-12-05', end: '2025-03-14', renewal: { kind: 'nessuno', months: 0, noticeDays: 0 }, // allow-italian: fixture data, shown as written
    status: 'scaduto', owner: 'sarim-bruno', area: 'legale', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'sarim-bruno', at: '2017-12-05T11:00:00+01:00', reason: 'Contratto firmato', clauses: BASE['c-vallo'], signed: true }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-val-1', clause: 'art-6', version: 1, what: 'Proroga della polizza per il periodo di prosecuzione del servizio', owner: 'sarim-bruno', kind: 'garanzia', due: '2026-10-31', quote: "resta valida fino all'emissione del certificato di verifica di conformità" }, // allow-italian: fixture data, shown as written
      { id: 'ob-val-2', clause: 'art-4', version: 1, what: 'Riepilogo dei servizi di ottobre al Comune', owner: 'sarim-tecnico', kind: 'rendiconto', due: '2026-11-10', every: 'entro il 10 di ogni mese', quote: "Entro il giorno 10 di ogni mese l'Appaltatore trasmette al Comune il riepilogo dei servizi e dei quantitativi del mese precedente" }, // allow-italian: fixture data, shown as written
      { id: 'ob-val-3', clause: 'art-2', version: 1, what: 'Prosecuzione del servizio fino al subentro del nuovo gestore', owner: 'sarim-tecnico', kind: 'scadenza', quote: 'garantisce la prosecuzione del servizio, alle stesse condizioni, per il tempo necessario al subentro del nuovo gestore' }, // allow-italian: fixture data, shown as written
    ],
    comments: [
      { id: 'cm-val-1', clause: 'art-2', version: 1, author: 'sarim-bruno', at: '2026-10-20T10:30:00+01:00', text: "Contratto scaduto il 14/03/2025 e servizio che prosegue: serve l'atto del Comune che copre il periodo dopo la scadenza. Lo seguo nella card CT-S02." }, // allow-italian: fixture data, shown as written
    ],
    attachments: [
      signedCopy('at-val-v1', 1, '2017-12-05T11:00:00+01:00', [
        'Comune di Vallo della Lucania, Provincia di Salerno', // allow-italian: fixture data, shown as written
        'Contratto per il servizio di igiene urbana. Rep. n. 1544 del 05/12/2017', // allow-italian: fixture data, shown as written
        'Appaltatore: ATI tra S.A.R.I.M. SRL, P.IVA 02596800652, e Nappi Sud', // allow-italian: fixture data, shown as written
        'Importo: euro 9.298.979,61 oltre IVA. Scadenza: 14/03/2025', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 05/12/2017', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-val-garanzia', name: 'Garanzia definitiva', kind: 'garanzia', version: 1, at: '2017-11-28T10:00:00+01:00', lines: ['Polizza fideiussoria n. FD-2017-00733', 'Garante: Compagnia assicurativa (esempio)', 'Beneficiario: Comune di Vallo della Lucania', 'Scadenza della polizza: 31/10/2026, salvo proroga'] }, // allow-italian: fixture data, shown as written
    ],
    variants: [],
    approvals: [
      step('ap-1', 'sarim-bruno', 'redige', 'fatto', '2017-11-24T10:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-2', 'sarim-dg', 'approva', 'fatto', '2017-11-30T12:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-3', 'sarim-dg', 'firma', 'fatto', '2017-12-05T11:00:00+01:00', 'Firma digitale per la ATI'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: [], cards: ['CT-S02'] },
    tags: ['ATI con Nappi Sud', 'servizio proseguito dopo la scadenza'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'c-sub-lavaggio', title: 'Subappalto lavaggio contenitori, Castellabate', kind: 'subappalto', // allow-italian: fixture data, shown as written
    counterparty: 'Impresa di lavaggio contenitori (esempio)', counterpartyKind: 'Subappaltatore', // allow-italian: fixture data, shown as written
    object: "Lavaggio e sanificazione dei contenitori a Castellabate, in subappalto secondo l'art. 11 del contratto principale", // allow-italian: fixture data, shown as written
    value: 168000, valuePeriod: 'totale', start: '2026-12-01', end: '2030-03-31', renewal: { kind: 'nessuno', months: 0, noticeDays: 0 }, // allow-italian: fixture data, shown as written
    status: 'approvazione', owner: 'sarim-bruno', area: 'legale', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'sarim-bruno', draftedBy: 'agent:ag-contratti', at: '2026-10-28T12:00:00+01:00', reason: "Bozza dal contratto principale, art. 11", clauses: BASE['c-sub-lavaggio'] }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-sub-1', clause: 'art-2', version: 1, what: "Deposito del contratto al Comune, 20 giorni prima dell'inizio", owner: 'sarim-bruno', kind: 'scadenza', due: '2026-11-11', quote: "almeno 20 giorni prima dell'inizio delle prestazioni" }, // allow-italian: fixture data, shown as written
      { id: 'ob-sub-2', clause: 'art-4', version: 1, what: 'Rapporto con le foto dei contenitori lavati', owner: 'sarim-tecnico', kind: 'ricorrente', every: 'a ogni giro di lavaggio', quote: 'trasmette a SARIM il rapporto con le foto dei contenitori lavati' }, // allow-italian: fixture data, shown as written
      { id: 'ob-sub-3', clause: 'art-5', version: 1, what: 'DURC del Subappaltatore prima di ogni pagamento', owner: 'sarim-contabilita', kind: 'ricorrente', every: 'a ogni fattura', quote: 'previa verifica del DURC' }, // allow-italian: fixture data, shown as written
      { id: 'ob-sub-4', clause: 'art-7', version: 1, what: 'Giro di lavaggio non eseguito: euro 200', owner: 'sarim-tecnico', kind: 'penale', quote: 'si applica una penale di euro 200, trattenuta sulla prima fattura utile' }, // allow-italian: fixture data, shown as written
    ],
    comments: [
      { id: 'cm-sub-1', clause: 'art-2', version: 1, author: 'sarim-bruno', at: '2026-10-28T12:10:00+01:00', text: "Senza l'autorizzazione del Comune il subappaltatore non entra in servizio: la richiesta parte via PEC appena firmiamo." }, // allow-italian: fixture data, shown as written
      { id: 'cm-sub-2', clause: 'art-4', version: 1, author: 'sarim-tecnico', at: '2026-10-29T15:30:00+01:00', text: "Ogni 15 giorni d'estate va bene; ad agosto sul lungomare forse serve ogni settimana.", resolved: true, replies: [ // allow-italian: fixture data, shown as written
        { author: 'sarim-bruno', at: '2026-10-29T16:05:00+01:00', text: 'Il contratto principale non lo prevede: lo teniamo per la prossima stagione.' }, // allow-italian: fixture data, shown as written
      ] },
    ],
    attachments: [
      { id: 'at-sub-richiesta', name: 'Richiesta di autorizzazione al subappalto', kind: 'allegato', version: 1, at: '2026-10-30T10:00:00+01:00', lines: ['Al Comune di Castellabate, RUP del servizio di igiene urbana', "Oggetto: richiesta di autorizzazione al subappalto, art. 11 del contratto Rep. n. 1873 del 29/01/2026 e art. 119 del D.Lgs. 36/2023", 'Prestazione: lavaggio e sanificazione dei contenitori. Importo: euro 168.000,00 oltre IVA', 'Bozza: parte via PEC dopo la firma del Direttore generale'] }, // allow-italian: fixture data, shown as written
    ],
    variants: [],
    approvals: [
      step('ap-1', 'sarim-bruno', 'redige', 'fatto', '2026-10-28T12:00:00+01:00', "Bozza dell'agente contratti dal contratto principale, rivista"), // allow-italian: fixture data, shown as written
      step('ap-2', 'sarim-tecnico', 'rivede', 'fatto', '2026-10-29T15:40:00+01:00', 'Frequenze di lavaggio uguali al capitolato'), // allow-italian: fixture data, shown as written
      step('ap-3', 'sarim-dg', 'approva', 'in-attesa', undefined, 'Serve prima della richiesta al Comune'), // allow-italian: fixture data, shown as written
      step('ap-4', 'sarim-dg', 'firma', 'da-fare'), // allow-italian: fixture data, shown as written
      step('ap-5', 'sarim-bruno', 'controfirma', 'da-fare', undefined, "Invio al Comune via PEC per l'autorizzazione al subappalto"), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['sarim-varianti', 'sarim-fatture'], cards: ['CT-N12'] },
    tags: ['figlio di c-castellabate', 'art. 11 del contratto principale'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'c-carburante', title: 'Accordo quadro gasolio per autotrazione', kind: 'fornitura', // allow-italian: fixture data, shown as written
    counterparty: 'Fornitore carburanti (esempio)', counterpartyKind: 'Fornitore', // allow-italian: fixture data, shown as written
    object: 'Gasolio per autotrazione al deposito di Eboli e ai cantieri, accordo quadro di 24 mesi', // allow-italian: fixture data, shown as written
    value: 2400000, valuePeriod: 'totale', start: '2025-02-01', end: '2027-01-31', renewal: { kind: 'tacito', months: 12, noticeDays: 60 }, // allow-italian: fixture data, shown as written
    status: 'rinnovo', owner: 'sarim-contabilita', area: 'contabilita', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'sarim-bruno', at: '2025-01-20T11:00:00+01:00', reason: 'Accordo quadro firmato', clauses: BASE['c-carburante'], signed: true }, // allow-italian: fixture data, shown as written
      { n: 2, author: 'sarim-bruno', at: '2025-09-10T12:00:00+01:00', reason: 'Nuovo spread e penali più strette', signed: true, clauses: revise(BASE['c-carburante'], { // allow-italian: fixture data, shown as written
        'art-5': "Il prezzo al litro è pari al prezzo medio settimanale del gasolio per autotrazione pubblicato dal Ministero dell'Ambiente e della Sicurezza Energetica, al netto delle imposte, nella settimana della consegna, più uno spread fisso di euro 0,041 per litro per consegne di almeno 5.000 litri e di euro 0,048 per litro per consegne inferiori. Accise e IVA sono addebitate a parte.", // allow-italian: fixture data, shown as written
        'art-7': "Per ogni consegna eseguita oltre 24 ore dall'ordine si applica una penale pari al 2 per mille del valore della consegna per ogni giorno di ritardo. Per le consegne urgenti al deposito di Eboli il termine è di 12 ore.", // allow-italian: fixture data, shown as written
      }) },
    ],
    obligations: [
      { id: 'ob-car-1', clause: 'art-2', version: 2, what: 'Disdetta via PEC, o rinnovo tacito di 12 mesi', owner: 'sarim-contabilita', kind: 'rinnovo', due: '2026-12-02', quote: 'salvo disdetta inviata via PEC almeno 60 giorni prima della scadenza' }, // allow-italian: fixture data, shown as written
      { id: 'ob-car-2', clause: 'art-5', version: 2, what: 'Prezzo in fattura: media della settimana più lo spread della versione 2', owner: 'sarim-contabilita', kind: 'ricorrente', every: 'a ogni fattura', quote: 'più uno spread fisso di euro 0,041 per litro per consegne di almeno 5.000 litri' }, // allow-italian: fixture data, shown as written
      { id: 'ob-car-3', clause: 'art-7', version: 2, what: 'Consegna oltre 24 ore: 2 per mille al giorno', owner: 'sarim-flotta', kind: 'penale', quote: 'si applica una penale pari al 2 per mille del valore della consegna per ogni giorno di ritardo' }, // allow-italian: fixture data, shown as written
      { id: 'ob-car-4', clause: 'art-6', version: 2, what: 'Pagamento delle fatture di settembre', owner: 'sarim-contabilita', kind: 'ricorrente', due: '2026-11-30', every: 'a 60 giorni data fattura fine mese', quote: 'SARIM paga a 60 giorni data fattura fine mese' }, // allow-italian: fixture data, shown as written
      { id: 'ob-car-5', clause: 'art-3', version: 2, what: "Ordini vicini all'importo massimo dell'accordo quadro", owner: 'sarim-contabilita', kind: 'scadenza', quote: "L'importo massimo dell'accordo quadro è pari a euro 2.400.000,00 oltre IVA" }, // allow-italian: fixture data, shown as written
    ],
    comments: [
      { id: 'cm-car-1', clause: 'art-5', version: 2, author: 'sarim-contabilita', at: '2026-10-30T15:10:00+01:00', text: 'Per la card FT-2611 il prezzo in fattura va confrontato con questa formula: media della settimana di consegna più lo spread della versione 2.', replies: [ // allow-italian: fixture data, shown as written
        { author: 'sarim-bruno', at: '2026-10-30T16:00:00+01:00', text: 'Sì: lo spread della versione 1 non vale più dal 10/09/2025.' }, // allow-italian: fixture data, shown as written
      ] },
      { id: 'cm-car-2', clause: 'art-2', version: 2, author: 'sarim-dg', at: '2026-11-02T09:15:00+01:00', text: 'Prima di decidere sulla disdetta voglio due offerte di confronto.', replies: [ // allow-italian: fixture data, shown as written
        { author: 'sarim-contabilita', at: '2026-11-03T10:40:00+01:00', text: 'Chieste a due fornitori, risposte entro il 20/11.' }, // allow-italian: fixture data, shown as written
      ] },
    ],
    attachments: [
      signedCopy('at-car-v1', 1, '2025-01-20T11:00:00+01:00', [
        `Scrittura privata tra ${SARIM_PARTY}, e Fornitore carburanti (esempio)`, // allow-italian: fixture data, shown as written
        'Accordo quadro per la fornitura di gasolio per autotrazione, dal 01/02/2025 al 31/01/2027', // allow-italian: fixture data, shown as written
        'Importo massimo: euro 2.400.000,00 oltre IVA. Prezzo: media settimanale ministeriale più spread di euro 0,052 per litro', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 20/01/2025', // allow-italian: fixture data, shown as written
      ]),
      signedCopy('at-car-v2', 2, '2025-09-10T12:00:00+01:00', [
        "Atto modificativo n. 1 all'accordo quadro del 20/01/2025", // allow-italian: fixture data, shown as written
        'Articoli modificati: 5 (prezzo) e 7 (penali)', // allow-italian: fixture data, shown as written
        'Nuovo spread: euro 0,041 per litro da 5.000 litri in su, euro 0,048 sotto', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 10/09/2025', // allow-italian: fixture data, shown as written
      ]),
    ],
    variants: [
      { id: 'var-carburante-2', title: 'Nuovo spread e penali più strette', reason: 'Rinegoziazione dopo sei mesi di consegne: spread più basso per i carichi grandi, consegne entro 24 ore', version: 2, status: 'firmata', at: '2025-08-28T10:00:00+01:00' }, // allow-italian: fixture data, shown as written
    ],
    approvals: [
      step('ap-1', 'sarim-bruno', 'redige', 'fatto', '2025-09-01T10:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-2', 'sarim-contabilita', 'rivede', 'fatto', '2025-09-03T15:00:00+01:00', 'Spread confrontato con le ultime 20 fatture'), // allow-italian: fixture data, shown as written
      step('ap-3', 'sarim-dg', 'approva', 'fatto', '2025-09-08T09:30:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-4', 'sarim-dg', 'firma', 'fatto', '2025-09-10T12:00:00+01:00', 'Firma digitale'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['sarim-varianti', 'sarim-fatture'], cards: ['CT-R03', 'FT-2611'] },
  },
  {
    id: 'c-officina', title: 'Manutenzione compattatori e spazzatrici', kind: 'fornitura', // allow-italian: fixture data, shown as written
    counterparty: 'Officina mezzi pesanti (esempio)', counterpartyKind: 'Fornitore', // allow-italian: fixture data, shown as written
    object: 'Manutenzione ordinaria e straordinaria di compattatori e spazzatrici della sede di Eboli', // allow-italian: fixture data, shown as written
    value: 380000, valuePeriod: 'totale', start: '2025-07-01', end: '2027-06-30', renewal: { kind: 'tacito', months: 12, noticeDays: 90 }, // allow-italian: fixture data, shown as written
    status: 'attivo', owner: 'sarim-contabilita', area: 'contabilita', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'sarim-bruno', at: '2025-06-20T11:00:00+01:00', reason: 'Contratto firmato', clauses: BASE['c-officina'], signed: true }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-off-1', clause: 'art-2', version: 1, what: 'Disdetta via PEC, o rinnovo tacito di 12 mesi', owner: 'sarim-contabilita', kind: 'rinnovo', due: '2027-04-01', quote: 'salvo disdetta inviata via PEC almeno 90 giorni prima della scadenza' }, // allow-italian: fixture data, shown as written
      { id: 'ob-off-2', clause: 'art-6', version: 1, what: 'Fermo oltre 72 ore: euro 150 al giorno, da trattenere in fattura', owner: 'sarim-flotta', kind: 'penale', quote: 'si applica una penale di euro 150 per ogni giorno di ulteriore fermo' }, // allow-italian: fixture data, shown as written
      { id: 'ob-off-3', clause: 'art-4', version: 1, what: 'Presa in carico del mezzo entro 24 ore', owner: 'sarim-flotta', kind: 'ricorrente', every: 'per ogni richiesta di intervento', quote: 'prende in carico il mezzo entro 24 ore dalla richiesta' }, // allow-italian: fixture data, shown as written
      { id: 'ob-off-4', clause: 'art-5', version: 1, what: 'Rapportino firmato e targa in ogni fattura', owner: 'sarim-contabilita', kind: 'ricorrente', every: 'a ogni fattura', quote: 'con il rapportino firmato, la targa del mezzo, le ore e i ricambi' }, // allow-italian: fixture data, shown as written
    ],
    comments: [],
    attachments: [
      signedCopy('at-off-v1', 1, '2025-06-20T11:00:00+01:00', [
        `Scrittura privata tra ${SARIM_PARTY}, e Officina mezzi pesanti (esempio)`, // allow-italian: fixture data, shown as written
        'Manutenzione di compattatori e spazzatrici, dal 01/07/2025 al 30/06/2027, rinnovo tacito di 12 mesi', // allow-italian: fixture data, shown as written
        'Importo massimo: euro 380.000,00 oltre IVA', // allow-italian: fixture data, shown as written
        'Firmato digitalmente dalle parti il 20/06/2025', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-off-listino', name: 'Listino orario e ricambi', kind: 'allegato', version: 1, at: '2025-06-20T11:00:00+01:00', lines: ['Listino orario e ricambi, allegato al contratto', 'Manodopera: tariffa oraria per mezzi pesanti, fissa per tutta la durata', 'Ricambi: listino del costruttore con sconto fisso'] }, // allow-italian: fixture data, shown as written
    ],
    variants: [],
    approvals: [
      step('ap-1', 'sarim-bruno', 'redige', 'fatto', '2025-06-10T10:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-2', 'sarim-flotta', 'rivede', 'fatto', '2025-06-12T14:00:00+01:00', 'Tempi di presa in carico e fermo mezzo'), // allow-italian: fixture data, shown as written
      step('ap-3', 'sarim-dg', 'approva', 'fatto', '2025-06-17T09:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-4', 'sarim-dg', 'firma', 'fatto', '2025-06-20T11:00:00+01:00', 'Firma digitale'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['sarim-fatture'], cards: ['FT-2604'] },
  },
  {
    id: 'c-td-castellabate', title: 'Contratti a termine, servizio estivo di Castellabate', kind: 'personale', // allow-italian: fixture data, shown as written
    counterparty: 'Lavoratori a tempo determinato (esempio)', counterpartyKind: 'Lavoratore', // allow-italian: fixture data, shown as written
    object: 'Tre contratti a tempo determinato di operatore ecologico per il servizio estivo e di fine stagione a Castellabate', // allow-italian: fixture data, shown as written
    value: 54600, valuePeriod: 'totale', start: '2026-06-01', end: '2026-11-30', renewal: { kind: 'opzione', months: 6, noticeDays: 15 }, // allow-italian: fixture data, shown as written
    status: 'attivo', owner: 'sarim-personale', area: 'personale', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'sarim-personale', at: '2026-05-25T11:00:00+01:00', reason: 'Contratti firmati', clauses: BASE['c-td-castellabate'], signed: true }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-td-1', clause: 'art-2', version: 1, what: 'Decidere e comunicare la proroga dei 3 contratti', owner: 'sarim-personale', kind: 'rinnovo', due: '2026-11-15', quote: 'è comunicata per iscritto al lavoratore entro il 15 novembre 2026' }, // allow-italian: fixture data, shown as written
      { id: 'ob-td-2', clause: 'art-2', version: 1, what: 'Fine dei 3 contratti a termine', owner: 'sarim-personale', kind: 'scadenza', due: '2026-11-30', quote: 'termina il 30 novembre 2026' }, // allow-italian: fixture data, shown as written
      { id: 'ob-td-3', clause: 'art-6', version: 1, what: 'UNILAV al Centro per l\'impiego per proroga o cessazione', owner: 'sarim-personale', kind: 'scadenza', quote: "sono comunicate al Centro per l'impiego con il modello UNILAV nei termini di legge" }, // allow-italian: fixture data, shown as written
    ],
    comments: [],
    attachments: [
      signedCopy('at-td-v1', 1, '2026-05-25T11:00:00+01:00', [
        'S.A.R.I.M. SRL, sede amministrativa di Eboli, Via Maestri del Lavoro, Area PIP', // allow-italian: fixture data, shown as written
        'Contratti di lavoro a tempo determinato: 3 operatori ecologici, cantiere di Castellabate', // allow-italian: fixture data, shown as written
        'Dal 01/06/2026 al 30/11/2026. CCNL dei servizi ambientali FISE Assoambiente', // allow-italian: fixture data, shown as written
        'Nomi e dati dei lavoratori nel fascicolo del personale', // allow-italian: fixture data, shown as written
        'Firmati dalle parti il 25/05/2026', // allow-italian: fixture data, shown as written
      ]),
    ],
    variants: [],
    approvals: [
      step('ap-1', 'sarim-personale', 'redige', 'fatto', '2026-05-20T10:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-2', 'sarim-dg', 'approva', 'fatto', '2026-05-22T12:00:00+01:00', 'Tre operatori per il servizio estivo'), // allow-italian: fixture data, shown as written
      step('ap-3', 'sarim-dg', 'firma', 'fatto', '2026-05-25T11:00:00+01:00'), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['sarim-scadenze'], cards: ['PE-118'] },
    tags: ['CCNL FISE Assoambiente'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'c-accordo-castellabate', title: 'Accordo per il passaggio dei lavoratori, Castellabate', kind: 'sindacale', // allow-italian: fixture data, shown as written
    counterparty: 'Organizzazioni sindacali di categoria (esempio)', counterpartyKind: 'Sindacati', // allow-italian: fixture data, shown as written
    object: 'Verbale di accordo per il passaggio a SARIM degli 11 lavoratori della Castellabate Servizi srl, in applicazione del CCNL', // allow-italian: fixture data, shown as written
    value: 418000, valuePeriod: 'anno', start: '2026-04-01', end: '', renewal: { kind: 'nessuno', months: 0, noticeDays: 0 }, // allow-italian: fixture data, shown as written
    status: 'attivo', owner: 'sarim-personale', area: 'personale', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'sarim-personale', at: '2026-03-20T13:00:00+01:00', reason: 'Verbale di accordo firmato in sede sindacale', clauses: BASE['c-accordo-castellabate'], signed: true }, // allow-italian: fixture data, shown as written
    ],
    obligations: [
      { id: 'ob-acc-1', clause: 'art-6', version: 1, what: 'Incontro di verifica con i sindacati', owner: 'sarim-personale', kind: 'scadenza', due: '2026-11-30', quote: 'Le parti si incontrano entro il 30 novembre 2026' }, // allow-italian: fixture data, shown as written
      { id: 'ob-acc-2', clause: 'art-5', version: 1, what: 'Ferie e permessi arretrati da far godere', owner: 'sarim-personale', kind: 'scadenza', due: '2027-06-30', quote: 'fruiti entro il 30 giugno 2027' }, // allow-italian: fixture data, shown as written
      { id: 'ob-acc-3', clause: 'art-4', version: 1, what: 'Comunicazioni di assunzione degli 11 lavoratori', owner: 'sarim-personale', kind: 'scadenza', due: '2026-03-31', done: true, quote: 'SARIM invia le comunicazioni di assunzione entro il giorno precedente' }, // allow-italian: fixture data, shown as written
      { id: 'ob-acc-4', clause: 'art-3', version: 1, what: 'Livello, anzianità e retribuzione mantenuti nel cedolino', owner: 'sarim-personale', kind: 'ricorrente', every: 'a ogni elaborazione delle paghe', quote: "sono mantenuti il livello di inquadramento, l'anzianità maturata e la retribuzione" }, // allow-italian: fixture data, shown as written
    ],
    comments: [],
    attachments: [
      signedCopy('at-acc-v1', 1, '2026-03-20T13:00:00+01:00', [
        'Verbale di accordo sindacale del 20/03/2026', // allow-italian: fixture data, shown as written
        'Parti: S.A.R.I.M. SRL e le organizzazioni sindacali di categoria', // allow-italian: fixture data, shown as written
        'Oggetto: passaggio degli 11 lavoratori della Castellabate Servizi srl dal 01/04/2026, in applicazione del CCNL', // allow-italian: fixture data, shown as written
        'Firmato dalle parti in sede di incontro', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-acc-verbale', name: "Verbale dell'incontro del 20/03/2026", kind: 'verbale', version: 1, at: '2026-03-20T13:00:00+01:00', lines: ['Incontro per il cambio di gestione del servizio di igiene urbana di Castellabate', 'Presenti per S.A.R.I.M. SRL: Responsabile del personale e Avv. Annarita Bruno; le organizzazioni sindacali di categoria', 'Esito: accordo firmato sul passaggio degli 11 lavoratori; verifica entro il 30/11/2026'] }, // allow-italian: fixture data, shown as written
      { id: 'at-acc-elenco', name: 'Elenco degli 11 lavoratori', kind: 'allegato', version: 1, at: '2026-03-20T13:00:00+01:00', lines: ['Elenco riservato: 11 lavoratori con livello e anzianità', "Consultabile dall'ufficio del personale"] }, // allow-italian: fixture data, shown as written
    ],
    variants: [],
    approvals: [
      step('ap-1', 'sarim-personale', 'redige', 'fatto', '2026-03-16T10:00:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-2', 'sarim-bruno', 'rivede', 'fatto', '2026-03-18T15:00:00+01:00', 'Coerente con la clausola sociale del contratto, art. 12'), // allow-italian: fixture data, shown as written
      step('ap-3', 'sarim-dg', 'firma', 'fatto', '2026-03-20T12:30:00+01:00'), // allow-italian: fixture data, shown as written
      step('ap-4', 'sarim-personale', 'controfirma', 'fatto', '2026-03-20T13:00:00+01:00', "Firmato dalle organizzazioni sindacali all'incontro"), // allow-italian: fixture data, shown as written
    ],
    links: { flows: [], cards: ['CT-T04'] },
    tags: ['clausola sociale'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'c-accordo-turni', title: 'Accordo integrativo turni e reperibilità, sede di Eboli', kind: 'sindacale', // allow-italian: fixture data, shown as written
    counterparty: 'RSU e organizzazioni sindacali (esempio)', counterpartyKind: 'Sindacati', // allow-italian: fixture data, shown as written
    object: 'Turni domenicali e festivi, reperibilità e indennità del personale operativo della sede di Eboli', // allow-italian: fixture data, shown as written
    value: 186000, valuePeriod: 'anno', start: '2024-07-01', end: '2027-06-30', renewal: { kind: 'tacito', months: 12, noticeDays: 90 }, // allow-italian: fixture data, shown as written
    status: 'revisione', owner: 'sarim-personale', area: 'personale', // allow-italian: fixture data, shown as written
    versions: [
      { n: 1, author: 'sarim-personale', at: '2024-06-12T13:00:00+01:00', reason: 'Accordo integrativo firmato', clauses: BASE['c-accordo-turni'], signed: true }, // allow-italian: fixture data, shown as written
      { n: 2, author: 'sarim-personale', draftedBy: 'agent:ag-personale', at: '2026-11-02T16:30:00+01:00', reason: "Turni festivi e indennità chiesti dalla RSU all'incontro del 28/10/2026", value: 221400, clauses: revise(BASE['c-accordo-turni'], { // allow-italian: fixture data, shown as written
        'art-3': 'Ogni lavoratore copre al massimo una domenica su tre e non più di due festività infrasettimanali per trimestre, a rotazione. I turni domenicali e festivi sono comunicati entro il giorno 15 del mese precedente.', // allow-italian: fixture data, shown as written
        'art-5': "Per ogni turno domenicale o festivo è riconosciuta un'indennità di euro 32, oltre alla maggiorazione prevista dal CCNL. L'indennità di reperibilità è di euro 22 per ogni giorno feriale e di euro 34 per ogni giorno festivo. Le indennità sono pagate con la retribuzione del mese successivo.", // allow-italian: fixture data, shown as written
      }) },
    ],
    obligations: [
      { id: 'ob-tur-1', clause: 'art-2', version: 1, what: "Disdetta o rinnovo tacito dell'accordo", owner: 'sarim-personale', kind: 'rinnovo', due: '2027-04-01', quote: 'inviata almeno 90 giorni prima della scadenza' }, // allow-italian: fixture data, shown as written
      { id: 'ob-tur-2', clause: 'art-3', version: 1, what: 'Turni domenicali e festivi di dicembre', owner: 'sarim-personale', kind: 'ricorrente', due: '2026-11-20', every: 'entro il 20 di ogni mese', quote: 'sono comunicati entro il giorno 20 del mese precedente' }, // allow-italian: fixture data, shown as written
      { id: 'ob-tur-3', clause: 'art-6', version: 1, what: 'Incontro trimestrale con la RSU sui turni', owner: 'sarim-personale', kind: 'ricorrente', due: '2026-12-15', every: 'ogni tre mesi', quote: 'Le parti si incontrano ogni tre mesi' }, // allow-italian: fixture data, shown as written
      { id: 'ob-tur-4', clause: 'art-5', version: 1, what: 'Indennità di turno e di reperibilità in busta paga', owner: 'sarim-personale', kind: 'ricorrente', every: 'con le paghe del mese dopo', quote: 'Le indennità sono pagate con la retribuzione del mese successivo' }, // allow-italian: fixture data, shown as written
      { id: 'ob-tur-5', clause: 'art-4', version: 1, what: 'Reperibile sul posto entro 60 minuti', owner: 'sarim-personale', kind: 'ricorrente', every: 'ogni settimana, a turno', quote: 'con intervento sul posto entro 60 minuti dalla chiamata' }, // allow-italian: fixture data, shown as written
    ],
    comments: [
      { id: 'cm-tur-1', clause: 'art-3', version: 2, author: 'sarim-personale', at: '2026-11-02T17:00:00+01:00', text: "Una domenica su tre è la richiesta della RSU all'incontro del 28/10." }, // allow-italian: fixture data, shown as written
      { id: 'cm-tur-2', clause: 'art-5', version: 2, author: 'sarim-contabilita', at: '2026-11-03T12:20:00+01:00', text: "Con le nuove indennità il costo annuo stimato passa da 186.000 a 221.400 euro, 35.400 in più. Serve l'ok della Direzione.", replies: [ // allow-italian: fixture data, shown as written
        { author: 'sarim-personale', at: '2026-11-03T14:05:00+01:00', text: 'Lo metto nella nota per il Direttore generale.' }, // allow-italian: fixture data, shown as written
      ] },
    ],
    attachments: [
      signedCopy('at-tur-v1', 1, '2024-06-12T13:00:00+01:00', [
        'Accordo integrativo aziendale del 12/06/2024', // allow-italian: fixture data, shown as written
        'Parti: S.A.R.I.M. SRL, la RSU della sede di Eboli e le organizzazioni sindacali', // allow-italian: fixture data, shown as written
        'Turni domenicali e festivi, reperibilità e indennità, dal 01/07/2024 al 30/06/2027', // allow-italian: fixture data, shown as written
        'Firmato dalle parti in sede di incontro', // allow-italian: fixture data, shown as written
      ]),
      { id: 'at-tur-verbale', name: "Verbale dell'incontro con la RSU del 28/10/2026", kind: 'verbale', version: 2, at: '2026-10-28T13:00:00+01:00', lines: ["Verbale dell'incontro con la RSU della sede di Eboli del 28/10/2026", 'Richieste della RSU: al massimo una domenica su tre, indennità aggiornate', 'Impegno di S.A.R.I.M. SRL: proposta scritta entro la prima settimana di novembre'] }, // allow-italian: fixture data, shown as written
    ],
    variants: [
      { id: 'var-turni-2', title: 'Turni festivi e indennità', reason: "Richieste della RSU all'incontro del 28/10/2026", version: 2, status: 'in-corso', card: 'CT-A05', at: '2026-11-02T16:30:00+01:00' }, // allow-italian: fixture data, shown as written
    ],
    approvals: [
      step('ap-1', 'sarim-personale', 'redige', 'fatto', '2026-11-02T16:30:00+01:00', "Bozza dell'agente turni dai dati delle presenze, rivista"), // allow-italian: fixture data, shown as written
      step('ap-2', 'sarim-bruno', 'rivede', 'in-attesa'), // allow-italian: fixture data, shown as written
      step('ap-3', 'sarim-dg', 'approva', 'da-fare', undefined, 'Costo annuo stimato più 35.400 euro'), // allow-italian: fixture data, shown as written
      step('ap-4', 'sarim-dg', 'firma', 'da-fare'), // allow-italian: fixture data, shown as written
      step('ap-5', 'sarim-personale', 'controfirma', 'da-fare', undefined, "Firma della RSU e delle organizzazioni sindacali all'incontro"), // allow-italian: fixture data, shown as written
    ],
    links: { flows: ['sarim-varianti', 'sarim-turni'], cards: ['CT-A05'] },
  },
];
