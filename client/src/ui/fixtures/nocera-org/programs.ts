/**
 * The programs the Consorzio works in: the list of the software study of
 * 04-05/11 (`DATI-VERI.md`, «Programmi in uso») plus SEND, adopted in 05/2026.
 * For each one: what Topics reads there, what it writes and which person
 * confirms first, how it connects, and the steps of a connection test.
 *
 * `flowName` is the name the flows use (`NOCERA_OPS_FLOWS[].programs` and the
 * program steps), so the flows a program serves are counted from the flows,
 * never written twice. The programs are real; how each one is connected, the
 * accounts, the folders, the times and the history are examples, coherent with
 * the old preview (`../programs.ts`). An agent never writes in a program
 * without the confirmation of a person.
 *
 * Groups are the ones of the program list (`territory`, `staff`, `office`,
 * `tenders`, `public`): here `territory` holds the maps and drawings, `office`
 * protocol, mail, documents, accounting and litigation, `staff` the payroll,
 * `tenders` the tender portal, `public` SEND.
 */
import type { OrbitProgram } from '../orbit-org/programs';

const at = (day: string, time: string) => `2026-${day}T${time}:00+01:00`;

export const NOCERA_PROGRAMS: OrbitProgram[] = [
  {
    id: 'halley', name: 'Halley', sub: 'protocollo, atti, albo', monogram: 'H', color: '#1d4ed8', group: 'office', flowName: 'Halley', link: 'browser', // allow-italian: fixture data, shown as written
    how: "Robot nel browser sul server di Topics: entra in Halley con un utente di servizio e ripete i passi del Protocollo, come farebbe una persona.", // allow-italian: fixture data, shown as written
    account: 'utente di servizio robot.protocollo', // allow-italian: fixture data, shown as written
    every: 'ogni mattina alle 06:00 e quando un flusso lo chiede', // allow-italian: fixture data, shown as written
    gist: { reads: "protocolli, fascicoli, titolario, delibere e albo", writes: "protocollo, fascicoli e pubblicazioni all'albo" }, // allow-italian: fixture data, shown as written
    reads: [
      'Protocolli in entrata e in uscita: numero, data, oggetto, mittente', // allow-italian: fixture data, shown as written
      'Fascicoli e titolario: responsabile e stato', // allow-italian: fixture data, shown as written
      'Delibere, determine e albo con le date di pubblicazione', // allow-italian: fixture data, shown as written
    ],
    writes: [
      { what: 'Protocolla una PEC o un atto dopo la conferma del Protocollo', confirmedBy: 'cn-protocollo' }, // allow-italian: fixture data, shown as written
      { what: "Apre il fascicolo e assegna l'atto al team", confirmedBy: 'cn-protocollo' }, // allow-italian: fixture data, shown as written
      { what: "Pubblica una determina all'albo dopo la firma della direzione", confirmedBy: 'cn-dg' }, // allow-italian: fixture data, shown as written
    ],
    lastRead: at('11-06', '10:22'),
    test: ['Raggiunge Halley', "Entra con l'utente di servizio", 'Legge i protocolli di oggi', "Controlla il permesso di protocollare e di aprire un fascicolo"], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-27', '09:30'), who: 'cn-dg', kind: 'connect', what: "Ha collegato Halley con l'utente di servizio del Protocollo" }, // allow-italian: fixture data, shown as written
      { at: at('11-03', '08:15'), who: 'cn-protocollo', kind: 'test', what: 'Ha provato il collegamento: tutto a posto' }, // allow-italian: fixture data, shown as written
      { at: at('11-06', '06:00'), who: 'program:halley', kind: 'read', what: 'Registro di ieri letto: 41 protocolli, nessuna differenza' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'prunes', name: 'Prunes', sub: 'Advanced Systems: catasto, ruoli, riscossione', monogram: 'P', color: '#92400e', group: 'office', flowName: 'Prunes', link: 'api', // allow-italian: fixture data, shown as written
    how: 'Lettura diretta dal database con un utente di sola lettura: contribuenti, immobili, avvisi e ruoli, senza aprire il programma. Topics non scrive: le modifiche restano a chi usa Prunes.', // allow-italian: fixture data, shown as written
    account: 'utente topics_lettura, 7 tabelle su 214', // allow-italian: fixture data, shown as written
    every: 'ogni notte alle 06:00 e quando un flusso lo chiede', // allow-italian: fixture data, shown as written
    gist: { reads: "contribuenti, immobili, avvisi, ruoli e utenze irrigue" }, // allow-italian: fixture data, shown as written
    reads: [
      'Contribuenti e immobili: codice, nome, particelle', // allow-italian: fixture data, shown as written
      'Avvisi di pagamento dei contributi: anno, importo, stato', // allow-italian: fixture data, shown as written
      'Ruoli: emissione e scadenze', // allow-italian: fixture data, shown as written
      'Bacino e particella di ogni utenza irrigua', // allow-italian: fixture data, shown as written
    ],
    writes: [],
    lastRead: at('11-06', '06:00'),
    test: ['Raggiunge il database di Prunes', "Entra con l'utente di sola lettura", 'Legge un contribuente di esempio con i suoi immobili', 'Controlla di non poter scrivere'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-27', '10:10'), who: 'cn-dg', kind: 'connect', what: "Ha collegato Prunes con l'utente di sola lettura" }, // allow-italian: fixture data, shown as written
      { at: at('11-04', '07:40'), who: 'cn-catasto', kind: 'test', what: 'Ha provato il collegamento: tutto a posto' }, // allow-italian: fixture data, shown as written
      { at: at('11-06', '06:00'), who: 'program:prunes', kind: 'read', what: 'Lettura notturna di avvisi e ruoli: nessuna differenza' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'teamsystem', name: 'TeamSystem', sub: 'contabilità e registrazione delle fatture', monogram: 'T', color: '#0f766e', group: 'office', flowName: 'TeamSystem', link: 'screen', // allow-italian: fixture data, shown as written
    how: "Non ha API: un agente sul PC della Ragioneria apre TeamSystem e usa le sue schermate come farebbe una persona, con la sua utenza.", // allow-italian: fixture data, shown as written
    account: "utente dell'agente sul PC PC-RAGIONERIA-02", // allow-italian: fixture data, shown as written
    every: 'quando serve, dalle 07:00 alle 19:00', // allow-italian: fixture data, shown as written
    gist: { reads: "fatture registrate, fornitori, impegni e determine", writes: "liquidazioni e mandati di pagamento" }, // allow-italian: fixture data, shown as written
    reads: [
      'Fatture registrate: protocollo IVA, importi, scadenza', // allow-italian: fixture data, shown as written
      'Anagrafica fornitori: partita IVA e condizioni', // allow-italian: fixture data, shown as written
      'Impegni e determine di spesa', // allow-italian: fixture data, shown as written
    ],
    writes: [
      { what: 'Registra la liquidazione di una fattura visata', confirmedBy: 'cn-ragioneria' }, // allow-italian: fixture data, shown as written
      { what: 'Prepara il mandato di pagamento di una fattura o di un rimborso', confirmedBy: 'cn-ragioneria' }, // allow-italian: fixture data, shown as written
    ],
    lastRead: at('11-06', '10:28'),
    test: ['Trova acceso il PC PC-RAGIONERIA-02', "Apre TeamSystem con l'utenza dell'agente", "Legge la registrazione di una fattura d'esempio", 'Chiude TeamSystem senza salvare'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-28', '14:20'), who: 'cn-dg', kind: 'connect', what: "Ha installato l'agente sul PC della Ragioneria e collegato TeamSystem" }, // allow-italian: fixture data, shown as written
      { at: at('11-05', '08:05'), who: 'cn-ragioneria', kind: 'test', what: 'Ha provato il collegamento: tutto a posto' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'publisys', name: 'Publisys', sub: 'paghe e cedolini', monogram: 'U', color: '#be185d', group: 'staff', flowName: 'Publisys', link: 'file', // allow-italian: fixture data, shown as written
    how: "File: il PC del Personale ha un sistema troppo vecchio per l'agente, quindi Publisys deposita contratti, visite e cedolini in una cartella condivisa e Topics li legge da lì.", // allow-italian: fixture data, shown as written
    account: 'cartella condivisa del Personale, sola lettura', // allow-italian: fixture data, shown as written
    every: 'ogni mattina alle 07:00', // allow-italian: fixture data, shown as written
    gist: { reads: "contratti a termine, visite, certificati e cedolini" }, // allow-italian: fixture data, shown as written
    reads: [
      'Contratti a tempo determinato e proroghe già usate', // allow-italian: fixture data, shown as written
      'Visite mediche e certificati con la data di scadenza', // allow-italian: fixture data, shown as written
      'Cedolini in PDF del mese', // allow-italian: fixture data, shown as written
    ],
    writes: [],
    lastRead: at('11-06', '07:00'),
    test: ['Apre la cartella condivisa del Personale', "Trova i file di oggi", 'Legge contratti e scadenze', 'Confronta il numero di righe con ieri'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-28', '09:00'), who: 'cn-dg', kind: 'connect', what: 'Ha collegato la cartella condivisa del Personale' }, // allow-italian: fixture data, shown as written
      { at: at('11-06', '07:00'), who: 'program:publisys', kind: 'read', what: 'File di stamattina letti: 3 scadenze entro 30 giorni' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'palegal', name: 'PA Legal', sub: 'contenzioso', monogram: 'L', color: '#7c3aed', group: 'office', flowName: 'PA Legal', link: 'browser', // allow-italian: fixture data, shown as written
    how: 'Robot nel browser sul server di Topics: apre la scheda di un ricorso e ne legge udienze ed esiti. Non scrive.', // allow-italian: fixture data, shown as written
    account: 'utente di sola lettura del Legale', // allow-italian: fixture data, shown as written
    every: 'ogni mattina alle 07:30 e su richiesta', // allow-italian: fixture data, shown as written
    gist: { reads: "ricorsi, udienze e incarichi ai legali" }, // allow-italian: fixture data, shown as written
    reads: [
      'Ricorsi aperti: numero, giudice, parti', // allow-italian: fixture data, shown as written
      'Udienze: data, aula, esito', // allow-italian: fixture data, shown as written
      'Incarichi ai legali', // allow-italian: fixture data, shown as written
    ],
    writes: [],
    lastRead: at('11-06', '07:30'),
    test: ['Apre PA Legal', "Entra con l'utente di sola lettura", 'Legge i ricorsi aperti con la prossima udienza', 'Esce senza modificare niente'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-29', '11:30'), who: 'cn-dg', kind: 'connect', what: "Ha collegato PA Legal con l'utente di sola lettura" }, // allow-italian: fixture data, shown as written
      { at: at('11-06', '07:30'), who: 'program:palegal', kind: 'read', what: 'Giro del mattino: nessuna udienza nuova' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'traspare', name: 'Traspare', sub: 'gare telematiche', monogram: 'G', color: '#0369a1', group: 'tenders', flowName: 'Traspare', link: 'browser', // allow-italian: fixture data, shown as written
    how: "Robot nel browser: entra nella piattaforma con l'utenza del Consorzio, legge le procedure e scarica i documenti. Non carica mai un atto di gara.", // allow-italian: fixture data, shown as written
    account: 'utenza del Legale e gare sulla piattaforma', // allow-italian: fixture data, shown as written
    every: 'ogni mattina alle 07:45 e su richiesta', // allow-italian: fixture data, shown as written
    gist: { reads: "procedure, capitolati, disciplinari e verbali di gara" }, // allow-italian: fixture data, shown as written
    reads: [
      'Procedure in corso: CIG, stato, scadenza delle offerte', // allow-italian: fixture data, shown as written
      'Capitolati, disciplinari e chiarimenti', // allow-italian: fixture data, shown as written
      'Verbali di gara', // allow-italian: fixture data, shown as written
    ],
    writes: [],
    lastRead: at('11-06', '07:45'),
    test: ['Apre la piattaforma di gara', "Entra con l'utenza del Consorzio", 'Legge le procedure in corso', 'Esce senza scaricare niente'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-29', '12:00'), who: 'cn-dg', kind: 'connect', what: "Ha collegato Traspare con l'utenza del Consorzio" }, // allow-italian: fixture data, shown as written
      { at: at('11-06', '07:45'), who: 'program:traspare', kind: 'read', what: 'Giro del mattino: 2 procedure in corso, nessuna scadenza nei prossimi 3 giorni' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'qgis', name: 'QGIS', sub: 'mappe, particelle e reticolo dei canali', monogram: 'Q', color: '#15803d', group: 'territory', flowName: 'QGIS', link: 'api', // allow-italian: fixture data, shown as written
    how: "MCP open source sul PC del Tecnico: risponde con foglio, particella e canale più vicino. Sola lettura.", // allow-italian: fixture data, shown as written
    account: 'PC-TECNICO-04, progetto del comprensorio, sola lettura', // allow-italian: fixture data, shown as written
    every: 'quando un flusso lo chiede', // allow-italian: fixture data, shown as written
    gist: { reads: "particelle e livelli del reticolo" }, // allow-italian: fixture data, shown as written
    reads: [
      'Particelle: foglio, particella, canale di riferimento', // allow-italian: fixture data, shown as written
      'Livelli del reticolo e del perimetro di contribuenza', // allow-italian: fixture data, shown as written
    ],
    writes: [],
    lastRead: at('11-06', '10:20'),
    test: ['Raggiunge il PC-TECNICO-04', 'Apre il progetto del comprensorio', 'Cerca una particella di Castel San Giorgio e il canale più vicino', 'Controlla di non poter salvare il progetto'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-30', '10:40'), who: 'cn-dg', kind: 'connect', what: 'Ha collegato QGIS sul PC del Tecnico' }, // allow-italian: fixture data, shown as written
      { at: at('11-05', '16:10'), who: 'cn-tecnico', kind: 'use', what: 'Ha guardato sulla mappa il tracciato di una richiesta di concessione' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'autocad', name: 'AutoCAD', sub: 'tavole tecniche in DWG', monogram: 'A', color: '#475569', group: 'territory', flowName: 'AutoCAD', link: 'file', // allow-italian: fixture data, shown as written
    how: 'File: Topics legge i DWG dalla cartella tavole del Tecnico, senza aprire il programma.', // allow-italian: fixture data, shown as written
    account: 'cartella tavole del Tecnico su PC-TECNICO-04, sola lettura', // allow-italian: fixture data, shown as written
    every: 'ogni 30 minuti', // allow-italian: fixture data, shown as written
    gist: { reads: "tavole e disegni delle concessioni" }, // allow-italian: fixture data, shown as written
    reads: [
      'Tavole: nome, revisione, livelli', // allow-italian: fixture data, shown as written
      'Disegni allegati alle richieste di concessione', // allow-italian: fixture data, shown as written
    ],
    writes: [],
    lastRead: at('11-06', '10:00'),
    test: ['Apre la cartella tavole', 'Trova i DWG modificati di recente', 'Legge nome e revisione di una tavola', 'Controlla di non poter scrivere'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-30', '10:50'), who: 'cn-dg', kind: 'connect', what: 'Ha collegato la cartella tavole del Tecnico' }, // allow-italian: fixture data, shown as written
      { at: at('11-06', '10:00'), who: 'program:autocad', kind: 'read', what: 'Cartella letta: 212 tavole, 2 modificate da ieri' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'm365', name: 'Microsoft 365', sub: 'Word, Excel, OneDrive e SharePoint', monogram: 'M', color: '#c2410c', group: 'office', flowName: 'Microsoft 365', link: 'api', // allow-italian: fixture data, shown as written
    how: "MCP ufficiale di Microsoft: legge i file delle cartelle scelte dai team e scrive solo in un documento nuovo, mai sul file di qualcun altro.", // allow-italian: fixture data, shown as written
    account: 'account di servizio Topics, cartelle scelte dai team', // allow-italian: fixture data, shown as written
    every: 'ogni 15 minuti', // allow-italian: fixture data, shown as written
    gist: { reads: "modelli di lettera e fogli Excel dei team", writes: "bozze di lettere, determine e fogli dei conteggi" }, // allow-italian: fixture data, shown as written
    reads: [
      'Modelli di lettera, determina e disciplinare', // allow-italian: fixture data, shown as written
      'Fogli Excel dei team: turni, scadenze, conteggi', // allow-italian: fixture data, shown as written
    ],
    writes: [
      { what: 'Crea la bozza di una lettera o di una determina in un documento nuovo', confirmedBy: 'cn-legale' }, // allow-italian: fixture data, shown as written
      { what: 'Crea il foglio dei conteggi di uno sgravio in un file nuovo', confirmedBy: 'cn-catasto' }, // allow-italian: fixture data, shown as written
    ],
    lastRead: at('11-06', '10:25'),
    test: ['Entra con il conto di servizio', 'Apre la cartella dei modelli', 'Legge un modello di lettera', 'Crea e cancella un documento di prova'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-27', '11:40'), who: 'cn-dg', kind: 'connect', what: 'Ha collegato le cartelle scelte dai team' }, // allow-italian: fixture data, shown as written
      { at: at('11-02', '17:30'), who: 'cn-legale', kind: 'use', what: "Ha aperto la bozza di determina preparata da Topics" }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'pec-aruba', name: 'PEC Aruba', sub: 'la casella PEC del protocollo', monogram: 'P', color: '#2563eb', group: 'office', flowName: 'PEC Aruba', link: 'mailbox', // allow-italian: fixture data, shown as written
    how: 'Legge la casella; ogni PEC che esce dal Consorzio la prepara Topics e la invia una persona, con la ricevuta di consegna.', // allow-italian: fixture data, shown as written
    account: 'protocollo@x.example.it', // allow-italian: fixture data, shown as written
    every: 'ogni 2 minuti', // allow-italian: fixture data, shown as written
    gist: { reads: "PEC in arrivo e ricevute", writes: "risposte e concessioni da inviare" }, // allow-italian: fixture data, shown as written
    reads: [
      'PEC in arrivo: mittente, oggetto, data, allegati', // allow-italian: fixture data, shown as written
      'Ricevute di accettazione e di consegna', // allow-italian: fixture data, shown as written
    ],
    writes: [
      { what: "Prepara la risposta o la concessione da inviare via PEC", confirmedBy: 'cn-protocollo' }, // allow-italian: fixture data, shown as written
    ],
    lastRead: at('11-06', '10:29'),
    source: { label: 'bonificasarno.it, contatti', url: 'https://www.bonificasarno.it' }, // allow-italian: fixture data, shown as written
    test: ['Entra nella casella PEC', 'Legge le ultime 10 PEC senza segnarle come lette', 'Trova le ricevute di consegna', 'Controlla che nessun invio parta da solo'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-27', '09:00'), who: 'cn-dg', kind: 'connect', what: 'Ha collegato la casella PEC del protocollo' }, // allow-italian: fixture data, shown as written
      { at: at('11-03', '08:30'), who: 'cn-protocollo', kind: 'test', what: 'Ha provato il collegamento: tutto a posto' }, // allow-italian: fixture data, shown as written
      { at: at('11-06', '09:12'), who: 'program:pec-aruba', kind: 'read', what: 'PEC delle 09:12 letta: un ricorso da leggere con il Legale' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'send', name: 'SEND', sub: 'notifiche a valore legale', monogram: 'S', color: '#0e7490', group: 'public', flowName: 'SEND', link: 'public', // allow-italian: fixture data, shown as written
    how: "Servizi della piattaforma, con le credenziali dell'ente: Topics prepara la notifica e la invia solo dopo la firma della direzione, poi legge l'esito.", // allow-italian: fixture data, shown as written
    account: "credenziali dell'ente mittente, adottate a maggio 2026", // allow-italian: fixture data, shown as written
    every: 'a ogni notifica firmata', // allow-italian: fixture data, shown as written
    external: 'sistema pubblico nazionale', // allow-italian: fixture data, shown as written
    gist: { reads: "stato e perfezionamento delle notifiche", writes: "notifiche firmate di verbali e provvedimenti" }, // allow-italian: fixture data, shown as written
    reads: [
      'Stato di ogni notifica: consegnata, perfezionata, non recapitata', // allow-italian: fixture data, shown as written
      'Data di perfezionamento della notifica', // allow-italian: fixture data, shown as written
    ],
    writes: [
      { what: 'Invia la notifica firmata di un verbale o di un provvedimento', confirmedBy: 'cn-dg' }, // allow-italian: fixture data, shown as written
    ],
    lastRead: at('11-05', '16:45'),
    source: { label: 'bonificasarno.it, notizie', url: 'https://www.bonificasarno.it/2026/05/il-consorzio-adotta-send-per-le-notifiche-a-valore-legale/' }, // allow-italian: fixture data, shown as written
    test: ['Raggiunge la piattaforma', "Controlla le credenziali dell'ente", "Legge lo stato dell'ultima notifica", 'Non invia niente: la prova non manda notifiche'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-29', '15:00'), who: 'cn-dg', kind: 'connect', what: "Ha caricato le credenziali dell'ente mittente" }, // allow-italian: fixture data, shown as written
      { at: at('11-05', '16:45'), who: 'program:send', kind: 'read', what: 'Notifica di un verbale perfezionata: lo stato è tornato alla card' }, // allow-italian: fixture data, shown as written
    ],
  },
];
