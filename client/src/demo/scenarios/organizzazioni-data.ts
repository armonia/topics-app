/* The "organizzazioni" scenario's data: four real organizations, each with its
 * board cards and its chats, in Italian because that is how they work.
 *
 * WHAT IS TRUE AND WHAT IS AN EXAMPLE. The facts about each organization (name,
 * laws, canals, services, programs in use, published news) are real and come
 * from public sources: bonificasarno.it and its 2025 yearbook for the
 * Consorzio, euroimpianti20.it for Euro Impianti, armonia.io and this repo for
 * Armonia. Single practices, people, taxpayers and amounts are NEVER real: they
 * are plausible cases built on real practice types, and every one of them says
 * so ("esempio" in the card title, "Caso di esempio" in its text). allow-italian: the labels
 * Offices appear as roles, never as names.
 *
 * WHAT COMES FROM ARMONIA'S OWN DOCUMENTS, AND WHY THAT IS A DECISION. Part of
 * the work shown is true but not public: the course and the software study for
 * the Consorzio, the activity list behind SARIM's cards, the HR cases behind
 * Euro Impianti's. This build is public, so shipping them is the owner's call
 * (see the outcome of this change); figures from the questionnaire, prices,
 * people and internal channels stay out regardless. So does any usage number
 * of Topics: a number without a measured base would be an invented one. */
import type { TaskStatus } from "../../lib/board";
import type { TableViewSpec } from "../../../../shared/views-table";

interface OrgCard { status: TaskStatus; priority: number; title: string; description: string }
interface OrgTurn { role: "user" | "assistant"; text: string; view?: TableViewSpec }
interface OrgChat { title: string; turns: OrgTurn[] }
interface Organization { name: string; color: string; cards: OrgCard[]; chats: OrgChat[] }

/* The invoice check drawn as a generative table view, the way an agent shows a
 * comparison it computed: 4 pieces at 115,00 against 100,00 on line 2. */
const INVOICE_VS_ORDER: TableViewSpec = {
  view: "table", title: "Fattura e ordine a confronto", subtitle: "Caso di esempio, importi in euro", // allow-italian: scenario data, shown as written
  columns: [{ label: "Voce" }, { label: "Fattura", align: "end" }, { label: "Ordine", align: "end" }, { label: "Differenza", align: "end" }],
  rows: [
    { cells: ["Riga 2, prezzo unitario", "115,00", "100,00", "15,00"] }, // allow-italian: scenario data, shown as written
    { cells: ["Riga 2, 4 pezzi", "460,00", "400,00", "60,00"] }, // allow-italian: scenario data, shown as written
    { cells: ["Imponibile", "1.240,00", "1.180,00", "60,00"] }, // allow-italian: scenario data, shown as written
    { cells: ["IVA 22%", "272,80", "259,60", "13,20"] }, // allow-italian: scenario data, shown as written
    { cells: ["Totale", "1.512,80", "1.439,60", "73,20"] }, // allow-italian: scenario data, shown as written
  ],
  footnote: "L'aliquota è giusta su tutte le righe: la differenza nasce solo dal prezzo della riga 2.", // allow-italian: scenario data, shown as written
};

export const ORGANIZATIONS: Organization[] = [
  {
    name: "Consorzio di Nocera", color: "#22c55e",
    cards: [
      { status: "in_progress", priority: 3,
        title: "Ricorso CGT su avviso 2025: costituirsi entro il 04/01 · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. Ricorso alla Corte di giustizia tributaria contro l'avviso di pagamento 2025, notificato via PEC il 05/11/2026 dal legale di un'azienda agricola di Castel San Giorgio: sostiene che il fondo non trae beneficio dalle opere. Costituzione entro 60 giorni dalla notifica (art. 23 D.Lgs. 546/1992): lunedì 04/01/2027. Prossimo passo: verifica del fondo sul perimetro del Piano di Classifica 1996 in QGIS." }, // allow-italian: scenario data, shown as written
      { status: "review", priority: 2,
        title: "Istanza di sgravio: immobile venduto prima del ruolo 2025 · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. Un contribuente chiede lo sgravio dell'avviso 2025 perché l'immobile era già venduto e allega l'atto. Nel programma del catasto consortile, in sola lettura, l'intestazione non risulta ancora aggiornata. Bozza di risposta pronta (sgravio e voltura al nuovo proprietario se le date tornano): aspetta l'ok di una persona dell'ufficio." }, // allow-italian: scenario data, shown as written
      { status: "todo", priority: 2,
        title: "Concessione di attraversamento: verifica della tavola · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. Richiesta di concessione per attraversare un canale consortile con una condotta; tavola DWG e relazione tecnica arrivate via PEC. L'Ufficio tecnico confronta le misure con le prescrizioni del Regolamento per la gestione e la conservazione delle opere di bonifica (Del. CdD n. 2 del 15/03/2023). I valori richiesti li inserisce l'ufficio: l'originale del regolamento non è ancora tra i documenti." }, // allow-italian: scenario data, shown as written
      { status: "in_progress", priority: 2,
        title: "Polizia idraulica: verbale per recinzione sul canale · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. Il sorvegliante trova una recinzione nuova nella fascia di rispetto di un canale a Mercato San Severino. Verbale per violazione del R.D. 368/1904, sanzione con il procedimento della L.R. 13/1983 (L.R. 7/2025, art. 10 c.2), poi segnalazione al Comune per il ripristino dei luoghi (Libro dell'anno 2025, p. 447). Manca l'articolo violato: serve il regolamento del 2023." }, // allow-italian: scenario data, shown as written
      { status: "in_progress", priority: 3,
        title: "Segnalazione: griglia ostruita sul Canale Torello · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio: segnalazione via PEC di acqua sulla strada a Torello dopo la pioggia. Il problema è vero e documentato: la griglia del tratto tombato del Canale Torello (Castel San Giorgio) si ostruisce spesso e allaga la frazione; le briglie su Calcare e Petrelle sono progettate e finanziate dalla Regione (Libro dell'anno 2025, p. 435). Proposta: rimozione dei detriti con operai e mezzi del consorzio, manutenzione ordinaria." }, // allow-italian: scenario data, shown as written
      { status: "done", priority: 2,
        title: "Accesso agli atti su una concessione: risposta inviata · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. Un confinante ha chiesto copia di una concessione di scarico rilasciata a un'azienda. Avvisato il controinteressato, che aveva 10 giorni per opporsi (art. 3 DPR 184/2006); risposta entro i 30 giorni (art. 25 L. 241/1990), firmata dal responsabile e inviata via PEC dopo la sua conferma." }, // allow-italian: scenario data, shown as written
      { status: "todo", priority: 3,
        title: "Nota della Regione sulla L.R. 7/2025: risposta · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio: una nota della Regione chiede un quadro della rete per il nuovo Piano comprensoriale di bonifica (art. 5, con VAS). Mittente Regione: decide sempre una persona, la Direzione. La bozza usa solo dati pubblicati: circa 680 km di rete, 24 vasche assorbenti laminanti, 43.054 ha di attuale operatività (Libro dell'anno 2025)." }, // allow-italian: scenario data, shown as written
      { status: "todo", priority: 1,
        title: "Libro dell'anno 2025 nei documenti, per capitoli", // allow-italian: scenario data, shown as written
        description: "Il Libro dell'anno 2025 pubblicato sul sito (452 pagine) va messo nei documenti diviso per capitoli: manutenzione, irrigazione, opere pubbliche, polizia idraulica. Ogni risposta citerà la pagina e aprirà il PDF originale." }, // allow-italian: scenario data, shown as written
      { status: "todo", priority: 2,
        title: "Caricare il Regolamento opere di bonifica (CdD 2/2023)", // allow-italian: scenario data, shown as written
        description: "Il Regolamento per la gestione e la conservazione delle opere di bonifica (Delibera del Consiglio dei Delegati n. 2 del 15/03/2023, detto anche Regolamento di Polizia Idraulica) è citato nel Libro dell'anno 2025 ma l'originale non è tra i documenti. Serve a concessioni e verbali. Insieme va caricato il testo ufficiale della L.R. Campania 7/2025 dal BURC." }, // allow-italian: scenario data, shown as written
      { status: "in_progress", priority: 2,
        title: "Gara servizi di ingegneria 2026-2028: fascicolo · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio su una gara vera. Accordo quadro in 2 lotti per il Piano triennale OO.PP. 2026-2028, indetto dalla CUC del Lago di Occhito per conto del consorzio: lotto 1 progettazione, direzione lavori e sicurezza (CIG BCBB6E15ED), lotto 2 verifica della progettazione e dei modelli BIM (CIG BCBB6E26C0). Termini prorogati con atto n. 217 del 25/09/2026, bando scaduto il 12/10/2026; a ottobre l'avviso per la commissione giudicatrice. Si raccolgono gli atti pubblicati in un fascicolo." }, // allow-italian: scenario data, shown as written
      { status: "review", priority: 2,
        title: "Risposta tipo sulle spese dell'avviso notificato (SEND) · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio su spese vere. Dal 2026 gli avvisi notificati (AVN) partono via SEND. Spese pubblicate dal consorzio: AVP 2025 € 2,73; AVN € 8,22 di gestione più la spedizione SEND, € 2,00 se digitale, in media € 5,60 se cartacea (da € 4,91 a € 9,54); con l'ingiunzione oltre € 30. La risposta tipo cita la pagina del sito; aspetta l'ok di una persona dell'ufficio prima dell'uso." }, // allow-italian: scenario data, shown as written
      { status: "backlog", priority: 1,
        title: "Richieste irrigue per la campagna 2027: flusso · esempio", // allow-italian: scenario data, shown as written
        description: "Proposta di esempio: un flusso che riceve le richieste di turno irriguo e le smista per distretto. I distretti funzionano in modo diverso: Paludi ha gruppi di consegna con card prepagate e telecontrollo dell'Ufficio Impianti, Castel San Giorgio distribuisce a scorrimento in canali in terra (Libro dell'anno 2025, p. 372). Da capire con l'Ufficio Impianti, Reti ed Irrigazione come si assegnano i turni oggi." }, // allow-italian: scenario data, shown as written
    ],
    chats: [
      { title: "Ricorso CGT arrivato via PEC · caso di esempio", // allow-italian: scenario data, shown as written
        turns: [
          { role: "user", text: "È arrivata una PEC su protocollo@pec.bonificasarno.it con tre allegati firmati. Cos'è?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Un ricorso alla Corte di giustizia tributaria di primo grado contro l'avviso di pagamento del contributo 2025 (caso di esempio, dati anonimi). Riassunto, con l'originale aperto accanto:\n1. Il ricorrente, un'azienda agricola di Castel San Giorgio, impugna l'avviso 2025 (ricorso.pdf.p7m, p. 1).\n2. Sostiene che il fondo non trae beneficio dalle opere del consorzio (p. 5).\n3. Chiede la sospensione dell'avviso (p. 12).\nLe tre firme digitali sono valide. Proposta: tipo «Ricorso o atto giudiziario», Ufficio legale. Questo tipo lo conferma sempre una persona." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Che scadenza metti? Nell'atto non vedo l'udienza." }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "L'udienza la fissa la Corte dopo il deposito del ricorso, quindi oggi non c'è. Per noi conta la costituzione in giudizio: 60 giorni dalla notifica (art. 23 D.Lgs. 546/1992). Ricevuta di consegna del 05/11/2026, scadenza lunedì 04/01/2027. La sospensione feriale vale solo dal 1° al 31 agosto, qui non cambia nulla. Avvisi all'Ufficio legale il 15/12 e il 30/12." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Il contribuente è in Prunes?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Sì, trovato in Prunes in sola lettura dal codice fiscale scritto nell'atto: avviso 2025 non pagato. Sullo stesso fondo c'è un'istanza di sgravio di marzo, respinta perché il fondo è nel perimetro di contribuenza (pratica collegata). Il ricorso dice il contrario, quindi aggiungo un passo per l'Ufficio tecnico: verifica delle particelle sul perimetro del Piano di Classifica 1996 in QGIS, con la mappa che entra nella pratica." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Conferma e protocolla. Prepara anche la bozza di incarico." }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Bozza di protocollo pronta su Halley con i dati dell'atto: la registra l'ufficio protocollo. Card all'Ufficio legale con la scadenza del 04/01/2027. La bozza di incarico è tra i documenti: il legale si sceglie dall'albo per l'assistenza e il patrocinio aggiornato con la deliberazione di Deputazione Amministrativa n. 16 del 28/01/2026. Scelta e firma restano alla Direzione: nulla parte verso l'esterno senza." }, // allow-italian: scenario data, shown as written
        ] },
      { title: "Polizia idraulica: chi contesta e il verbale · caso di esempio", // allow-italian: scenario data, shown as written
        turns: [
          { role: "user", text: "Chi può contestare un'occupazione della fascia di rispetto lungo un canale consortile? E dove vanno i soldi della sanzione?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Il consorzio stesso. Con la L.R. Campania 7/2025, art. 10 c. 2, è Autorità di Polizia Idraulica: vigila sulle opere, accerta e contesta le violazioni del R.D. 368/1904 per le opere di bonifica e del R.D. 523/1904 per il reticolo regionale, e segue l'intero procedimento sanzionatorio secondo la L.R. 13/1983 (Libro dell'anno 2025, p. 444). Il verbale lo redigono l'ufficiale idraulico o il sorvegliante, ufficiali di polizia giudiziaria nei limiti del servizio (p. 447). I proventi vanno alla gestione e manutenzione delle opere vigilate (art. 10 c. 2, lett. c)." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Stamattina a Mercato San Severino ho trovato una recinzione nuova a ridosso di un canale. Prepara il verbale." }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Bozza pronta (caso di esempio). Dal sopralluogo ho preso luogo, data e ora, descrizione e le 4 foto che hai caricato dal telefono, con la posizione. Mancano due cose che non scrivo io:\n1. la distanza misurata dal ciglio del canale;\n2. l'articolo violato. Il Regolamento per la gestione e la conservazione delle opere di bonifica (Delibera del Consiglio dei Delegati n. 2 del 15/03/2023) è citato nel Libro dell'anno, ma l'originale non è tra i documenti: finché manca non propongo articoli né importi." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Distanza 1,5 metri dal ciglio. È del proprietario del fondo accanto." }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Aggiunta la misura. Il proprietario lo trovo dalla particella nel programma del catasto consortile, in sola lettura. Dopo la tua firma: protocollo in Halley, notifica del verbale e segnalazione al Comune per il ripristino dei luoghi, come nell'iter descritto a p. 447. Ho aperto la card per caricare il Regolamento: serve anche alle concessioni." }, // allow-italian: scenario data, shown as written
        ] },
    ],
  },
  {
    name: "SARIM", color: "#f5a524",
    cards: [
      { status: "todo", priority: 3,
        title: "Segnalazione del committente: mancato ritiro, doppione? · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. Una mail del committente segnala un mancato ritiro. Si estraggono indirizzo, tipo e urgenza e si confrontano con il foglio condiviso tra call center e cantieri: se la segnalazione è un doppione si collega a quella aperta." }, // allow-italian: scenario data, shown as written
      { status: "in_progress", priority: 2,
        title: "Utenza privata: richiesta di ritiro da programmare · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. Un'utenza privata telefona per un ritiro. Va verificato l'indirizzo, programmato il servizio e mandato al cantiere, poi aggiornata la riga nel file Excel condiviso." }, // allow-italian: scenario data, shown as written
      { status: "in_progress", priority: 3,
        title: "FIR non ancora su RENTRI: completare il formulario · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. Un formulario di un servizio della settimana non risulta caricato. Si recuperano i dati mancanti e si prepara il caricamento; lo conferma l'addetto prima che parta." }, // allow-italian: scenario data, shown as written
      { status: "review", priority: 2,
        title: "Rendiconto mensile del servizio foglie di ottobre · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. La bozza del rendiconto del servizio foglie è costruita dai servizi del mese registrati nel foglio cantieri. Va controllata prima dell'invio." }, // allow-italian: scenario data, shown as written
      { status: "review", priority: 3,
        title: "Fattura passiva con prezzo diverso dall'ordine · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. La riga 2 è fatturata a un prezzo più alto di quello dell'ordine. Sono già calcolate la differenza di imponibile e di IVA ed è pronta la bozza di contestazione al fornitore. La fattura resta sospesa finché decide la Contabilità." }, // allow-italian: scenario data, shown as written
      { status: "todo", priority: 2,
        title: "Riconciliazione bancaria di ottobre · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. Si abbinano i movimenti dell'estratto conto a fatture e pagamenti. I movimenti senza abbinamento restano in elenco, ognuno con il suo dubbio scritto, per la Contabilità." }, // allow-italian: scenario data, shown as written
      { status: "todo", priority: 3,
        title: "Contratti a tempo determinato in scadenza a 60 giorni · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. Elenco dei contratti a termine che scadono nei prossimi 60 giorni, con data e reparto. Per ognuno la decisione resta all'ufficio Personale." }, // allow-italian: scenario data, shown as written
      { status: "done", priority: 2,
        title: "Turni della settimana e fogli targa dei mezzi · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. I fogli targa sono compilati dai turni settimanali, dopo aver controllato che ogni turno abbia un mezzo e una squadra assegnati." }, // allow-italian: scenario data, shown as written
      { status: "in_progress", priority: 2,
        title: "Gara: valutazione preliminare di capitolato e disciplinare · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio. Lettura dei documenti scaricati dal portale gare: requisiti, scadenze e costo della manodopera da stimare. La valutazione la prepara la Tecnica; se partecipare lo decide una persona dell'azienda." }, // allow-italian: scenario data, shown as written
    ],
    chats: [
      { title: "Segnalazione del committente: doppione? · caso di esempio", // allow-italian: scenario data, shown as written
        turns: [
          { role: "user", text: "È arrivata una mail del committente con una segnalazione. Me la classifichi e mi dici se ce l'abbiamo già in lavorazione?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Ecco l'originale e il riassunto uno accanto all'altro.\n\nOriginale (mail del committente delle 9:41): «Si segnala mancato ritiro del secco residuo in via dei Tigli 8, ingresso del condominio. L'utente riferisce che il disservizio si ripete da martedì.»\n\nRiassunto: mancato ritiro · via dei Tigli 8 · secco residuo · urgenza alta, perché si ripete.\n\nNel file Excel condiviso con i cantieri c'è già una riga aperta ieri per lo stesso indirizzo: telefonata di un'utenza privata per un mancato ritiro." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Quindi è un doppione?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Probabile, ma non è sicuro. Stesso civico e stesso tipo a un giorno di distanza, però ieri l'utente parlava di plastica e oggi il committente scrive secco residuo. Ti propongo di collegarla alla riga di ieri come seconda segnalazione, senza aprire un servizio nuovo, e di chiedere al cantiere se il passaggio è saltato per tutte e due le frazioni. Scrivo il dubbio sulla riga." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Va bene, collegala e prepara la risposta per il committente." }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Fatto: ho aggiornato la riga di ieri e non ho aggiunto righe nuove al file.\n\nBozza per il committente, non ancora inviata:\n«Buongiorno, la segnalazione di oggi per via dei Tigli 8 riguarda lo stesso disservizio preso in carico ieri su richiesta dell'utente. Abbiamo chiesto al cantiere di verificare il passaggio per secco residuo e plastica e vi aggiorniamo appena abbiamo l'esito.»\n\nLa mandi tu o vuoi che la cambi?" }, // allow-italian: scenario data, shown as written
          { role: "user", text: "La mando io. Avvisa il cantiere." }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Il messaggio per il caposquadra è pronto: indirizzo, le due frazioni da verificare e il riferimento alle due segnalazioni. Lo trovi sulla card della segnalazione e parte solo quando lo confermi." }, // allow-italian: scenario data, shown as written
        ] },
      { title: "Fattura passiva che non torna con l'ordine · caso di esempio", // allow-italian: scenario data, shown as written
        turns: [
          { role: "user", text: "Mi controlli la fattura del fornitore di ricambi arrivata stamattina dallo SdI? Il totale non mi torna con l'ordine." }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Ecco fattura e ordine affiancati.\n\nFattura: 3 righe, imponibile 1.240,00 €, IVA al 22% 272,80 €, totale 1.512,80 €.\nOrdine: gli stessi 3 articoli, imponibile 1.180,00 €.\n\nLa differenza di 60,00 € sta tutta nella riga 2: 4 pezzi a 115,00 € in fattura contro 100,00 € nell'ordine. L'aliquota è giusta su tutte le righe, però l'IVA è calcolata sull'imponibile più alto, quindi ci sono 13,20 € di IVA in più.", view: INVOICE_VS_ORDER }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Può essere cambiato il listino?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Nei documenti che ho non c'è un listino nuovo di questo fornitore: l'ultimo è quello allegato all'ordine. Potrebbe esserne arrivato uno che nessuno ha caricato, quindi non lo escludo. Se il listino è ancora quello, la riga 2 va contestata chiedendo una nota di credito di 73,20 € (60,00 € di imponibile più 13,20 € di IVA)." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Prepara la mail al fornitore, la mando io." }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "La bozza è pronta e non è stata inviata. Oggetto: «Differenza di prezzo sulla riga 2 della fattura». Contiene le due cifre affiancate, il riferimento all'ordine e la richiesta della nota di credito.\n\nNel frattempo la fattura resta sospesa: non la registro e non la metto in scadenza finché non decidi tu." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Bene. Se entro una settimana non risponde, ricordamelo." }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Ho messo un promemoria tra sette giorni sulla card della fattura, con la bozza e il confronto allegati. Se la nota di credito arriva prima, la abbino alla fattura e ti propongo di chiudere." }, // allow-italian: scenario data, shown as written
        ] },
    ],
  },
  {
    name: "Armonia", color: "#5b8cff",
    cards: [
      { status: "done", priority: 2,
        title: "Corso AI al Consorzio: incontro 1 e lavagna dei processi", // allow-italian: scenario data, shown as written
        description: "4/11, in presenza a Nocera. Lavagna con i programmi per area (Tecnica, Amministrativa, Direzione) e processo 1 scelto: gestione dei protocolli, da PEC, mail, posta fisica e WhatsApp." }, // allow-italian: scenario data, shown as written
      { status: "todo", priority: 3,
        title: "Incontro 2 del corso: prompt e ricerca verificata", // allow-italian: scenario data, shown as written
        description: "13/11, da remoto. Esito: 3 prompt per la gestione dei protocolli, provati ciascuno su almeno 3 documenti finti o anonimizzati, nella libreria condivisa; registro degli errori avviato." }, // allow-italian: scenario data, shown as written
      { status: "done", priority: 2,
        title: "Studio dei programmi del Consorzio e collegamento all'AI", // allow-italian: scenario data, shown as written
        description: "Consegnato il 5/11. I programmi restano (Halley, Prunes, TeamSystem, Publisys, PA Legal, Traspare, QGIS, AutoCAD); bastano cinque collegamenti MCP: browser, posta, file, database, desktop Windows." }, // allow-italian: scenario data, shown as written
      { status: "todo", priority: 3,
        title: "Fase 1 col Consorzio: PC, PEC e utente Halley dedicato", // allow-italian: scenario data, shown as written
        description: "Per lo smistamento della PEC con bozza di protocollo confermata da una persona servono: un PC o server Windows, la PEC con password per programmi, un utente Halley dedicato all'assistente." }, // allow-italian: scenario data, shown as written
      { status: "in_progress", priority: 3,
        title: "Demo della landing a scenari tipizzati", // allow-italian: scenario data, shown as written
        description: "La giuntura della demo diventa un caricatore più scenari tipizzati: «acme» resta la landing di oggi, «organizzazioni» mostra Consorzio di Nocera, SARIM, Armonia ed Euro Impianti. Barra: typecheck verde e landing acme identica." }, // allow-italian: scenario data, shown as written
      { status: "backlog", priority: 2,
        title: "Organizzazioni nella barra laterale: proposta openspec", // allow-italian: scenario data, shown as written
        description: "Un gruppo per organizzazione come i progetti, una Board unica con filtro per organizzazione. Parte dalla spec accounts-orgs e dalla change sharing-orgs: prima la proposta, poi il codice." }, // allow-italian: scenario data, shown as written
      { status: "review", priority: 2,
        title: "Mockup dei Flussi per organizzazioni: revisione", // allow-italian: scenario data, shown as written
        description: "65 schermate attive e 9 scartate: flussi come passi in ordine con percorsi per tipo, originale accanto al riassunto, collaudo prima di attivare. Ogni richiesta del 5/11 è legata alle schermate che la coprono." }, // allow-italian: scenario data, shown as written
      { status: "done", priority: 1,
        title: "Topics: pannello Sistema accanto al lavoro", // allow-italian: scenario data, shown as written
        description: "Il Sistema diventa un tipo di pannello vero, apribile in split accanto al lavoro, con la striscia di stato in fondo alla barra laterale. Su main dal 4/11." }, // allow-italian: scenario data, shown as written
    ],
    chats: [
      { title: "Protocollo del Consorzio: da dove si parte", // allow-italian: scenario data, shown as written
        turns: [
          { role: "user", text: "Dalla lavagna del 4/11 il processo 1 è la gestione dei protocolli. Con i programmi che hanno, cosa colleghiamo per primo?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Posta, file e browser su Halley. La PEC è l'ingresso del processo e Halley si usa dal browser, quindi per partire non serve un accordo col fornitore. L'assistente legge PEC e mail, propone area e tipo di protocollo, prepara la bozza su Halley e una persona conferma. Fonte: studio dei programmi del 5/11, «Ordine di lavoro»." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Cosa dobbiamo chiedere al Consorzio per la fase 1?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Tre cose: un PC o un server Windows dove far girare l'assistente, la PEC con una password per programmi, un utente Halley dedicato. Più avanti servono contratti, costi, utenti e scadenze dei programmi, soprattutto dei doppioni: Halley e Traspare hanno entrambi un protocollo." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "L'assistente può protocollare da solo?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "No. Ha un utente suo con i permessi minimi e ogni azione finisce nel registro, come raccomanda il CERT-AgID sugli MCP (22/04/2026). In più, scelte nostre: parte in sola lettura, ogni salvataggio (protocollare, inviare una PEC) lo conferma una persona e tutto gira su un PC o server del Consorzio." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Prepara la richiesta per il referente del Consorzio, la mando io." }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Bozza pronta, non inviata: «Per partire con lo smistamento della PEC ci servono un PC o server Windows, la password per programmi della PEC e un utente Halley dedicato all'assistente. Nessun protocollo parte senza la conferma di una persona dell'ufficio.» L'ho collegata alla card «Fase 1 col Consorzio»." }, // allow-italian: scenario data, shown as written
        ] },
      { title: "Demo della landing: le organizzazioni senza componenti nuovi", // allow-italian: scenario data, shown as written
        turns: [
          { role: "user", text: "Sulla landing vogliamo mostrare le quattro organizzazioni. Serve un componente nuovo?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "No. La demo della landing è già il client vero: uno script che parte prima dell'app risponde alle chiamate al server con dati scritti nello scenario. Le organizzazioni diventano uno scenario accanto ad «acme», fatto di progetti, card della board e chat che Topics sa già mostrare. Si sceglie con ?scenario=organizzazioni." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "E se domani un endpoint cambia forma?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Lo scenario smette di compilare: le risposte finte usano i tipi del client e di shared/, quindi il typecheck diventa rosso prima che la demo si rompa in pagina. Lo provo apposta rompendo un tipo nello scenario." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Che dati ci mettiamo?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Fatti veri con la loro fonte: leggi, canali, servizi e notizie pubblicate dagli enti e dalle aziende. Pratiche, importi e persone solo come casi di esempio, dichiarati sulla card e nel titolo della chat. Nessun numero d'uso di Topics." }, // allow-italian: scenario data, shown as written
        ] },
    ],
  },
  {
    name: "Euro Impianti", color: "#e5484d",
    cards: [
      { status: "done", priority: 2,
        title: "Stop Work Policy pubblicata con l'istruzione operativa", // allow-italian: scenario data, shown as written
        description: "Fatto reale: il 29/10/2026 l'azienda ha pubblicato sul sito la Stop Work Policy con l'istruzione operativa. Chi è coinvolto nelle attività è invitato a fermare subito un lavoro che mette a rischio persone, ambiente o patrimonio culturale." }, // allow-italian: scenario data, shown as written
      { status: "todo", priority: 3,
        title: "Timbrature senza cantiere: assegnare il cantiere · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio: nella squadra di Camponogara 3 timbrature di ieri sono senza cantiere. L'ufficio assegna il cantiere e corregge i giorni passati salvando prima i valori vecchi." }, // allow-italian: scenario data, shown as written
      { status: "todo", priority: 2,
        title: "Rapportini con foto della settimana da archiviare · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio: rapportini di fine giornata con le foto dei lavori, da controllare e archiviare sotto il cantiere giusto." }, // allow-italian: scenario data, shown as written
      { status: "todo", priority: 2,
        title: "Ripristino asfalto dopo scavo in microtrincea · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio: un committente TLC chiede di ripristinare il manto su circa 40 m di strada comunale entro 10 giorni lavorativi. La richiesta è collegata al cantiere di posa già chiuso." }, // allow-italian: scenario data, shown as written
      { status: "in_progress", priority: 3,
        title: "Attestati e visite in scadenza delle squadre · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio: attestati di formazione e visite mediche che scadono nel mese, divisi per sede operativa, con un promemoria per l'ufficio del personale." }, // allow-italian: scenario data, shown as written
      { status: "in_progress", priority: 2,
        title: "Richieste di permesso dal nuovo Piano Welfare · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio sul Piano Welfare varato il 02/11/2026 (genitorialità, flessibilità, permessi retribuiti): raccogliere le richieste delle squadre e registrarle." }, // allow-italian: scenario data, shown as written
      { status: "review", priority: 2,
        title: "Bozza di presa in carico al committente · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio: risposta al committente TLC sul ripristino stradale. Non è stata inviata: aspetta che la rilegga una persona." }, // allow-italian: scenario data, shown as written
      { status: "review", priority: 2,
        title: "Richiesta di acconto da passare all'amministrazione · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio: un dipendente chiede un acconto sullo stipendio. La richiesta la vede solo l'amministrazione, che la approva o la rifiuta." }, // allow-italian: scenario data, shown as written
      { status: "backlog", priority: 1,
        title: "Valutare una RdO su MePA per opere stradali · esempio", // allow-italian: scenario data, shown as written
        description: "Caso di esempio: richiesta di offerta su MePA per manutenzione stradale. Verificare che la categoria SOA OG3 copra il lavoro e che una delle due squadre stradali sia libera." }, // allow-italian: scenario data, shown as written
    ],
    chats: [
      { title: "Ripristino dopo uno scavo · caso di esempio", // allow-italian: scenario data, shown as written
        turns: [
          { role: "user", text: "È arrivata una mail di un committente TLC con foto e una planimetria. Di che si tratta?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "È una richiesta di ripristino stradale dopo uno scavo (caso di esempio). Ecco l'originale e il riepilogo affiancati.\nCommittente: operatore TLC per cui lavoriamo in subappalto.\nDove: tratta in microtrincea su strada comunale, provincia di Milano.\nCosa chiede: ripristino del manto in asfalto su circa 40 m, con segnaletica.\nEntro: 10 giorni lavorativi.\nAllegati: 4 foto e 1 planimetria.\nLa assegnerei a una delle due squadre stradali." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Abbiamo già un cantiere aperto su quella tratta?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Sì: c'è la posa in microtrincea della stessa tratta, chiusa la settimana scorsa con rapportino e foto. Collego la richiesta a quel cantiere invece di aprirne uno nuovo, così le foto di prima e di dopo restano insieme.\nTi propongo tre passi: 1) collego la richiesta al cantiere; 2) apro una card per la squadra stradale con la scadenza; 3) preparo una bozza di presa in carico per il committente." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Ok a tutte e tre. La mail non mandarla, la rileggo io." }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Fatto. La richiesta è collegata al cantiere e la card «Ripristino asfalto dopo scavo in microtrincea» è in To do con la scadenza. La bozza di risposta è in Review e non è partita: la invii tu quando l'hai riletta." }, // allow-italian: scenario data, shown as written
        ] },
      { title: "Stop Work Policy: messaggio alle squadre · caso di esempio", // allow-italian: scenario data, shown as written
        turns: [
          { role: "user", text: "Sul sito c'è la pagina della Stop Work Policy. Cosa dice, in breve?" }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Dalla pagina pubblicata sul sito: chiunque sia coinvolto nelle attività dell'azienda è invitato a interrompere subito qualsiasi lavoro che presenti rischi per le persone, l'ambiente o il patrimonio culturale. Il dettaglio sta nei documenti scaricabili dalla stessa pagina, istruzione operativa compresa." }, // allow-italian: scenario data, shown as written
          { role: "user", text: "Prepara un messaggio breve per i capisquadra." }, // allow-italian: scenario data, shown as written
          { role: "assistant", text: "Bozza, non inviata: «Sul sito è pubblicata la Stop Work Policy: se un lavoro mette a rischio persone, ambiente o patrimonio culturale, chiunque di voi può fermarlo subito. Policy e istruzione operativa sono sul sito, alla pagina Stop Work Policy.» Come si segnala lo stop lo aggiungo dopo aver letto l'istruzione operativa: non lo scrivo a memoria." }, // allow-italian: scenario data, shown as written
        ] },
    ],
  },
];
