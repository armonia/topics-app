/**
 * The programs ORBIT works in, from the internal questionnaire (29/10): SAP in
 * the customer service, Enviro, WinWaste, Zucchetti, Excel, Word, mail and
 * PEC, the tender portals, plus RENTRI, the national registry ORBIT files to
 * (a public system, not ORBIT's own). For each one: what Topics reads there,
 * what it writes and which person confirms first, how it connects, and the
 * steps of a connection test.
 *
 * `flowName` is the name the flows use (`ORBIT_OPS_FLOWS[].programs` and the
 * program steps), so the flows a program serves are counted from the flows,
 * never written twice. Accounts, folders, times and the connection set-up are
 * examples; the facts with a source (Enviro at Albanella, SAP in the «Metodo (allow-italian: quotes the Italian interface)
 * Orbit», the PEC address) come from `DATI-VERI-ORBIT.md`.
 *
 * An agent never writes in a program without the confirmation of a person.
 */

/** Where a program sits in the list. */
export type ProgramGroup = 'territory' | 'staff' | 'office' | 'tenders' | 'public';

/** How Topics reaches it: an API, files in a shared folder, an agent on a PC using its screens, a robot in the browser, a mailbox, a public service. */
export type ProgramLink = 'api' | 'file' | 'screen' | 'browser' | 'mailbox' | 'public';

/** Something Topics writes in the program, and the person who confirms it first (a persona id). */
export interface ProgramWrite {
  what: string;
  confirmedBy: string;
}

/** A line of the program's own history: who (a persona id or `program:<id>` for an automatic read), when, what. */
export interface ProgramEvent {
  at: string;
  who: string;
  /** Connected or disconnected, a test, an automatic read, a use in the work. */
  kind: 'connect' | 'test' | 'read' | 'use';
  what: string;
}

export interface OrbitProgram {
  /** Address segment (`/programmi/sap`) and the pin of the sidebar. (allow-italian: address segment) */
  id: string;
  name: string;
  /** What it is for at ORBIT, one line. */
  sub: string;
  monogram: string;
  color: string;
  group: ProgramGroup;
  /** The name the flows use for it. */
  flowName: string;
  link: ProgramLink;
  /** How it is connected, in plain words. */
  how: string;
  /** The account, key or folder Topics uses. */
  account: string;
  /** How often Topics reads it. */
  every: string;
  /** What Topics reads and writes there, in a few words for the list (the full sentences are `reads` and `writes`). */
  gist: { reads: string; writes?: string };
  reads: string[];
  writes: ProgramWrite[];
  /** Set for a system that is not ORBIT's: who runs it, in words. */
  external?: string;
  /** Last successful read (ISO). */
  lastRead: string;
  /** The steps of a connection test, in order. */
  test: string[];
  /** A step that fails the first time the test runs (a shared file open by someone), and why. */
  firstFails?: { step: number; why: string };
  /** A public source for what the page says about it. */
  source?: { label: string; url: string };
  history: ProgramEvent[];
}

const at = (day: string, time: string) => `2026-${day}T${time}:00+01:00`;

export const ORBIT_PROGRAMS: OrbitProgram[] = [
  {
    id: 'sap', name: 'SAP', sub: 'gestionale del customer service', monogram: 'S', color: '#1d4ed8', group: 'territory', flowName: 'SAP', link: 'api', // allow-italian: fixture data, shown as written
    how: "API del gestionale con un utente tecnico di Topics: legge utenze e ordini e apre gli ordini di servizio.", // allow-italian: fixture data, shown as written
    account: 'utente tecnico TOPICS_CS, profilo customer service', // allow-italian: fixture data, shown as written
    every: 'ogni 5 minuti', // allow-italian: fixture data, shown as written
    gist: { reads: "utenze, ordini di servizio e segnalazioni recenti", writes: "ordini di servizio" }, // allow-italian: fixture data, shown as written
    reads: [
      'Utenze e indirizzi dei comuni serviti', // allow-italian: fixture data, shown as written
      'Ordini di servizio aperti e chiusi', // allow-italian: fixture data, shown as written
      'Segnalazioni degli ultimi 7 giorni per indirizzo, per trovare i doppioni', // allow-italian: fixture data, shown as written
    ],
    writes: [
      { what: "Apre l'ordine di servizio di una segnalazione", confirmedBy: 'orbit-callcenter' }, // allow-italian: fixture data, shown as written
      { what: "Chiude l'ordine con l'ora del passaggio", confirmedBy: 'orbit-callcenter' }, // allow-italian: fixture data, shown as written
    ],
    lastRead: at('11-06', '10:25'),
    test: ['Raggiunge il server SAP', "Entra con l'utente tecnico", "Legge un'utenza di prova di Agropoli", 'Controlla il permesso sugli ordini di servizio'], // allow-italian: fixture data, shown as written
    source: { label: 'orbitambiente.it, il nostro metodo', url: 'https://orbitambiente.it/il-nostro-metodo/' }, // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-27', '09:40'), who: 'orbit-dg', kind: 'connect', what: 'Ha collegato SAP con il profilo customer service' }, // allow-italian: fixture data, shown as written
      { at: at('11-02', '08:30'), who: 'orbit-dg', kind: 'test', what: 'Ha provato il collegamento: tutto a posto' }, // allow-italian: fixture data, shown as written
      { at: at('11-06', '06:00'), who: 'program:sap', kind: 'read', what: 'Lettura completa delle utenze di stanotte: nessuna differenza' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'enviro', name: 'Enviro', sub: 'segnalazioni e servizi sul territorio', monogram: 'E', color: '#15803d', group: 'territory', flowName: 'Enviro', link: 'api', // allow-italian: fixture data, shown as written
    how: "API della piattaforma: legge segnalazioni dei cittadini, passaggi dei mezzi e formulari dei ritiri; scrive solo l'esito di una segnalazione confermata.", // allow-italian: fixture data, shown as written
    account: 'chiave API di ORBIT, lettura più esito delle segnalazioni', // allow-italian: fixture data, shown as written
    every: 'ogni 10 minuti', // allow-italian: fixture data, shown as written
    gist: { reads: "segnalazioni, passaggi dei mezzi e formulari", writes: "stato delle segnalazioni" }, // allow-italian: fixture data, shown as written
    reads: [
      'Segnalazioni dei cittadini, ad Albanella e nei comuni con Enviro', // allow-italian: fixture data, shown as written
      'Passaggi dei mezzi e isole ecologiche informatizzate', // allow-italian: fixture data, shown as written
      'Formulari dei ritiri chiusi, con pesi e targhe', // allow-italian: fixture data, shown as written
    ],
    writes: [
      { what: 'Segna la segnalazione del cittadino come presa in carico, poi risolta', confirmedBy: 'orbit-callcenter' }, // allow-italian: fixture data, shown as written
    ],
    lastRead: at('11-06', '10:20'),
    test: ['Raggiunge la piattaforma Enviro', 'Controlla la chiave API di ORBIT', 'Legge le segnalazioni di Albanella di oggi', 'Legge un formulario chiuso di prova'], // allow-italian: fixture data, shown as written
    source: { label: 'orbitambiente.it, igiene urbana ad Albanella', url: 'https://orbitambiente.it/igiene-urbana-albanella-orbit/' }, // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-28', '11:15'), who: 'orbit-dg', kind: 'connect', what: 'Ha collegato Enviro con la chiave API di ORBIT' }, // allow-italian: fixture data, shown as written
      { at: at('11-04', '07:50'), who: 'orbit-dg', kind: 'test', what: 'Ha provato il collegamento: tutto a posto' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'winwaste', name: 'WinWaste', sub: 'giri di raccolta, passaggi e pesate', monogram: 'W', color: '#0f766e', group: 'territory', flowName: 'WinWaste', link: 'screen', // allow-italian: fixture data, shown as written
    how: 'Agente sul PC del customer service a Eboli: apre WinWaste e usa le sue schermate come farebbe una persona, con la sua utenza.', // allow-italian: fixture data, shown as written
    account: 'utente WinWaste del customer service, sul PC CS-EBOLI-02', // allow-italian: fixture data, shown as written
    every: 'quando serve, dalle 06:00 alle 22:00', // allow-italian: fixture data, shown as written
    gist: { reads: "giri, passaggi e pesate", writes: "giri di recupero e passaggi fuori giro" }, // allow-italian: fixture data, shown as written
    reads: [
      'Giri di raccolta e squadre per cantiere', // allow-italian: fixture data, shown as written
      'Passaggi registrati, anche del servizio foglie', // allow-italian: fixture data, shown as written
      'Pesate a fine giro', // allow-italian: fixture data, shown as written
    ],
    writes: [
      { what: 'Aggiunge un giro di recupero alla squadra di zona', confirmedBy: 'orbit-callcenter' }, // allow-italian: fixture data, shown as written
      { what: 'Registra un passaggio fuori giro già approvato', confirmedBy: 'orbit-tecnico' }, // allow-italian: fixture data, shown as written
    ],
    lastRead: at('11-06', '10:12'),
    test: ['Trova acceso il PC CS-EBOLI-02', "Apre WinWaste con l'utenza del customer service", 'Legge i giri di oggi del cantiere di Agropoli', 'Chiude WinWaste senza salvare'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-29', '15:20'), who: 'orbit-dg', kind: 'connect', what: "Ha installato l'agente sul PC CS-EBOLI-02 e collegato WinWaste" }, // allow-italian: fixture data, shown as written
      { at: at('11-05', '08:10'), who: 'orbit-dg', kind: 'test', what: 'Ha provato il collegamento: tutto a posto' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'zucchetti', name: 'Zucchetti', sub: 'presenze, turni, ferie e paghe', monogram: 'Z', color: '#b91c1c', group: 'staff', flowName: 'Zucchetti', link: 'file', // allow-italian: fixture data, shown as written
    how: "File di export: ogni notte alle 02:00 Zucchetti mette timbrature, ferie e contratti a termine nella cartella condivisa, e Topics li legge alle 06:00. Le correzioni tornano in Zucchetti con un file che carica il Personale.", // allow-italian: fixture data, shown as written
    account: 'cartella condivisa export/zucchetti, sola lettura', // allow-italian: fixture data, shown as written
    every: 'ogni notte, il file delle 02:00 alle 06:00', // allow-italian: fixture data, shown as written
    gist: { reads: "contratti a termine, timbrature, ferie e turni", writes: "file di import delle presenze" }, // allow-italian: fixture data, shown as written
    reads: [
      'Contratti a tempo determinato e proroghe già usate', // allow-italian: fixture data, shown as written
      'Timbrature, ferie e permessi', // allow-italian: fixture data, shown as written
      'Turni e fogli targa dei capi cantiere', // allow-italian: fixture data, shown as written
    ],
    writes: [
      { what: 'Prepara il file di import delle presenze corrette', confirmedBy: 'orbit-personale' }, // allow-italian: fixture data, shown as written
    ],
    lastRead: at('11-06', '06:00'),
    test: ['Apre la cartella condivisa degli export', 'Trova il file di stanotte delle 02:00', 'Legge timbrature e contratti a termine', 'Confronta il numero di righe con ieri'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-26', '10:00'), who: 'orbit-dg', kind: 'connect', what: "Ha collegato la cartella degli export di Zucchetti" }, // allow-italian: fixture data, shown as written
      { at: at('11-05', '06:00'), who: 'program:zucchetti', kind: 'read', what: 'Export di stanotte letto: timbrature, ferie e contratti a termine, nessun file mancante' }, // allow-italian: fixture data, shown as written
      { at: at('11-06', '06:00'), who: 'program:zucchetti', kind: 'read', what: 'Export di stanotte letto: timbrature, ferie e contratti a termine, nessun file mancante' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'excel', name: 'Excel', sub: 'fogli condivisi tra call center e cantieri', monogram: 'X', color: '#166534', group: 'office', flowName: 'Excel', link: 'file', // allow-italian: fixture data, shown as written
    how: 'File nella cartella condivisa: Topics legge i fogli e scrive solo in un file nuovo, mai sul foglio di qualcun altro.', // allow-italian: fixture data, shown as written
    account: 'cartella condivisa servizi/cantieri e contabilita/riconciliazioni', // allow-italian: fixture data, shown as written
    every: 'ogni 15 minuti', // allow-italian: fixture data, shown as written
    gist: { reads: "foglio dei servizi, passaggi foglie e riconciliazione", writes: "rendiconto foglie e riga di riconciliazione" }, // allow-italian: fixture data, shown as written
    reads: [
      'Foglio dei servizi tra call center e cantieri', // allow-italian: fixture data, shown as written
      'Passaggi del servizio foglie per zona', // allow-italian: fixture data, shown as written
      'Fogli di riconciliazione bancaria del mese', // allow-italian: fixture data, shown as written
    ],
    writes: [
      { what: 'Compila il rendiconto foglie del mese in un file nuovo', confirmedBy: 'orbit-tecnico' }, // allow-italian: fixture data, shown as written
      { what: 'Aggiunge la riga della fattura abbinata al foglio di riconciliazione', confirmedBy: 'orbit-contabilita' }, // allow-italian: fixture data, shown as written
    ],
    lastRead: at('11-06', '09:30'),
    test: ['Apre la cartella condivisa', 'Apre il foglio dei servizi dei cantieri', 'Legge le righe di oggi', 'Controlla di poter creare un file nuovo'], // allow-italian: fixture data, shown as written
    firstFails: { step: 1, why: "Il foglio dei servizi è aperto in modifica da un'altra persona: Topics ha letto la copia delle 09:30. Riprova quando lo chiude." }, // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-26', '10:20'), who: 'orbit-dg', kind: 'connect', what: 'Ha collegato le cartelle dei fogli condivisi' }, // allow-italian: fixture data, shown as written
      { at: at('11-06', '09:30'), who: 'program:excel', kind: 'read', what: "Foglio dei servizi aperto da un'altra persona: letta la copia delle 09:30" }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'word', name: 'Word', sub: 'atti, varianti e schede di gara', monogram: 'W', color: '#1e40af', group: 'office', flowName: 'Word', link: 'file', // allow-italian: fixture data, shown as written
    how: 'Modelli nella cartella del Legale: Topics prepara la bozza in un documento nuovo, con le modifiche visibili, e non tocca mai la versione firmata.', // allow-italian: fixture data, shown as written
    account: 'cartella condivisa legale/modelli e legale/contratti', // allow-italian: fixture data, shown as written
    every: 'quando un flusso prepara una bozza', // allow-italian: fixture data, shown as written
    gist: { reads: "modelli di variante, proroga e subappalto, contratti firmati", writes: "bozze di variante e schede di gara" }, // allow-italian: fixture data, shown as written
    reads: [
      'Modelli di variante, proroga e subappalto', // allow-italian: fixture data, shown as written
      'Versioni firmate dei contratti', // allow-italian: fixture data, shown as written
    ],
    writes: [
      { what: 'Crea la bozza della variante con le modifiche visibili', confirmedBy: 'orbit-bruno' }, // allow-italian: fixture data, shown as written
      { what: 'Crea la scheda di valutazione di una gara', confirmedBy: 'orbit-bruno' }, // allow-italian: fixture data, shown as written
    ],
    lastRead: at('11-06', '09:05'),
    test: ['Apre la cartella dei modelli', 'Legge il modello di variante', 'Crea e cancella un documento di prova'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-26', '10:30'), who: 'orbit-dg', kind: 'connect', what: 'Ha collegato le cartelle del Legale' }, // allow-italian: fixture data, shown as written
      { at: at('11-02', '18:20'), who: 'orbit-bruno', kind: 'use', what: 'Ha aperto la bozza della variante di Castellabate preparata da Topics' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'posta', name: 'Posta e PEC', sub: 'mail AMA, PEC aziendale e casella segnalazioni', monogram: 'P', color: '#475569', group: 'office', flowName: 'Posta e PEC', link: 'mailbox', // allow-italian: fixture data, shown as written
    how: 'Legge le caselle; ogni mail o PEC che esce da ORBIT la prepara Topics e la manda una persona.', // allow-italian: fixture data, shown as written
    account: 'info@x.example.it e casella segnalazioni del customer service', // allow-italian: fixture data, shown as written
    every: 'ogni 2 minuti', // allow-italian: fixture data, shown as written
    gist: { reads: "mail di AMA, fatture e ricevute SDI, risposte di comuni ed enti", writes: "bozze di risposta e di PEC" }, // allow-italian: fixture data, shown as written
    reads: [
      'Mail di AMA con le segnalazioni su Roma', // allow-italian: fixture data, shown as written
      'Fatture elettroniche e ricevute dello SDI in PEC', // allow-italian: fixture data, shown as written
      'Risposte di comuni, fornitori, INPS, INAIL e sindacati', // allow-italian: fixture data, shown as written
    ],
    writes: [
      { what: "Prepara la risposta ad AMA con l'ora del passaggio", confirmedBy: 'orbit-callcenter' }, // allow-italian: fixture data, shown as written
      { what: "Prepara la PEC dell'atto firmato al Comune", confirmedBy: 'orbit-bruno' }, // allow-italian: fixture data, shown as written
    ],
    lastRead: at('11-06', '10:29'),
    test: ['Entra nella casella PEC', 'Entra nella casella segnalazioni', 'Legge le ultime 10 mail senza segnarle come lette', 'Controlla che nessun invio parta da solo'], // allow-italian: fixture data, shown as written
    source: { label: 'Dichiarazione ambientale, PEC aziendale', url: 'https://orbitambiente.it/wp-content/uploads/2026/07/DA-ORBIT-convalidato-RINA_29.06.2026.pdf' }, // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-26', '09:30'), who: 'orbit-dg', kind: 'connect', what: 'Ha collegato la PEC aziendale e la casella segnalazioni' }, // allow-italian: fixture data, shown as written
      { at: at('11-03', '08:45'), who: 'orbit-dg', kind: 'test', what: 'Ha provato il collegamento: tutto a posto' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'gare', name: 'Portali gare / Innova', sub: 'bandi, disciplinari e chiarimenti', monogram: 'G', color: '#7c3aed', group: 'tenders', flowName: 'Portali gare / Innova', link: 'browser', // allow-italian: fixture data, shown as written
    how: "Robot nel browser: entra nei portali con l'utenza di ORBIT, legge i bandi nuovi e scarica i documenti. Non carica mai un'offerta.", // allow-italian: fixture data, shown as written
    account: "utenza dell'Ufficio gare e contratti sui portali", // allow-italian: fixture data, shown as written
    every: 'ogni mattina alle 07:30 e su richiesta', // allow-italian: fixture data, shown as written
    gist: { reads: "bandi, disciplinari, chiarimenti e scadenze di gara" }, // allow-italian: fixture data, shown as written
    reads: [
      'Bandi nuovi di igiene urbana in Campania e Lazio', // allow-italian: fixture data, shown as written
      'Disciplinare, capitolato e chiarimenti', // allow-italian: fixture data, shown as written
      'Scadenze della gara e del sopralluogo', // allow-italian: fixture data, shown as written
    ],
    writes: [],
    lastRead: at('11-06', '07:30'),
    test: ['Apre il portale gare', "Entra con l'utenza dell'Ufficio gare", 'Legge la lista dei bandi di oggi', 'Esce senza scaricare niente'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-27', '12:00'), who: 'orbit-dg', kind: 'connect', what: "Ha collegato i portali gare con l'utenza dell'Ufficio gare" }, // allow-italian: fixture data, shown as written
      { at: at('11-06', '07:30'), who: 'program:gare', kind: 'read', what: 'Giro del mattino: 2 bandi nuovi, uno di interesse' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'rentri', name: 'RENTRI', sub: 'registro nazionale per la tracciabilità dei rifiuti', monogram: 'R', color: '#0369a1', group: 'public', flowName: 'RENTRI', link: 'public', // allow-italian: fixture data, shown as written
    how: "Servizi di interoperabilità del registro, con il certificato di ORBIT: Topics prepara le registrazioni di carico e scarico e le trasmette solo dopo la firma del responsabile tecnico.", // allow-italian: fixture data, shown as written
    account: 'certificato di interoperabilità di S.A.R.I.M. SRL', // allow-italian: fixture data, shown as written
    every: 'a ogni registrazione firmata', // allow-italian: fixture data, shown as written
    external: 'sistema pubblico nazionale', // allow-italian: fixture data, shown as written
    gist: { reads: "esiti delle trasmissioni e registro già trasmesso", writes: "registrazione di carico e scarico firmata" }, // allow-italian: fixture data, shown as written
    reads: [
      'Esito di ogni trasmissione', // allow-italian: fixture data, shown as written
      'Registro di carico e scarico già trasmesso', // allow-italian: fixture data, shown as written
    ],
    writes: [
      { what: 'Trasmette la registrazione di carico e scarico firmata', confirmedBy: 'orbit-tecnico' }, // allow-italian: fixture data, shown as written
    ],
    lastRead: at('11-05', '17:20'),
    test: ['Raggiunge i servizi del registro', 'Controlla il certificato di ORBIT', "Legge l'esito dell'ultima trasmissione", 'Non trasmette niente: la prova non manda registrazioni al registro'], // allow-italian: fixture data, shown as written
    history: [
      { at: at('10-28', '16:00'), who: 'orbit-dg', kind: 'connect', what: 'Ha caricato il certificato di interoperabilità di ORBIT' }, // allow-italian: fixture data, shown as written
      { at: at('11-05', '17:20'), who: 'program:rentri', kind: 'read', what: 'Registrazione FIR-0931 trasmessa dopo la firma: accettata' }, // allow-italian: fixture data, shown as written
    ],
  },
];
