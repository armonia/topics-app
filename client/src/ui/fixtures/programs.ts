/**
 * The programs of the Consorzio di Nocera and how Topics reaches each one,
 * the offices' PCs with their agents, and the catalogue the smart search
 * answers from. The program list is the real one (`DATI-VERI.md`, studio
 * software of 04-05/11); how each is connected, the competitors, the effort
 * of a migration and every PC are examples and estimates, and the screens say
 * so. Sector words (protocollo, ruoli, avvisi) are data here, shown as written. (allow-italian: quotes the Italian interface)
 */
import type { FieldKind } from '../types';
import type { ConnectionKind, ProgramStateKind, Verdict } from '../programs/model';

export type ProgramId = 'halley' | 'prunes' | 'teamsystem' | 'publisys' | 'palegal' | 'traspare' | 'anac' | 'qgis' | 'autocad' | 'm365' | 'pec';

export interface ProgramArea {
  id: string;
  label: string;
}

/** The areas the list groups by, in the order of the mockup. */
export const PROGRAM_AREAS: ProgramArea[] = [
  { id: 'protocol', label: 'Protocollo e atti' }, // allow-italian: fixture data, shown as written
  { id: 'mail', label: 'Posta e documenti' }, // allow-italian: fixture data, shown as written
  { id: 'cadastre', label: 'Catasto, ruoli e riscossione' }, // allow-italian: fixture data, shown as written
  { id: 'accounting', label: 'Contabilità' }, // allow-italian: fixture data, shown as written
  { id: 'litigation', label: 'Contenzioso e personale' }, // allow-italian: fixture data, shown as written
  { id: 'tenders', label: 'Gare' }, // allow-italian: fixture data, shown as written
  { id: 'territory', label: 'Territorio' }, // allow-italian: fixture data, shown as written
];

/** What a line of «Accesso» is about; the label is a product word. */
export type AccessKey = 'user' | 'tables' | 'lastCheck' | 'mailbox' | 'folder' | 'pc' | 'password' | 'scope';

export interface ProgramSeed {
  id: ProgramId;
  name: string;
  sub?: string;
  maker?: string;
  area: string;
  /** What the program holds, in one sentence. */
  description: string;
  /** The kinds of data it contains: the chips of the list. */
  holds: Array<{ kind: FieldKind; name: string }>;
  /** What Topics reads in it, per kind, in a few words. */
  reads: Array<{ kind: FieldKind; name: string; value: string }>;
  connection: ConnectionKind;
  /** Where it stands before the reader changes anything. */
  state: ProgramStateKind;
  /** The PCs whose agent works in it (ids of `PCS`), for a program reached by an agent. */
  pcs?: string[];
  access: Array<{ key: AccessKey; value: string }>;
  /** Monogram colour, for the tiles. */
  color: string;
}

export const PROGRAMS: ProgramSeed[] = [
  {
    id: 'halley', name: 'Halley', sub: 'protocollo, atti, albo', maker: 'Halley', area: 'protocol', // allow-italian: fixture data, shown as written
    description: 'Protocollo, atti e albo dell\'ente. Topics lo usa come l\'ufficio: accede con un utente di servizio e ripete i passi.', // allow-italian: fixture data, shown as written
    holds: [{ kind: 'number', name: 'Protocollo' }, { kind: 'folder', name: 'Fascicolo' }], // allow-italian: fixture data, shown as written
    reads: [
      { kind: 'number', name: 'Protocollo', value: 'numero, data, oggetto, mittente' }, // allow-italian: fixture data, shown as written
      { kind: 'folder', name: 'Fascicolo', value: 'titolario, responsabile, stato' }, // allow-italian: fixture data, shown as written
      { kind: 'file', name: 'Atti', value: 'delibere, determine, albo' }, // allow-italian: fixture data, shown as written
    ],
    connection: 'browser', state: 'ok',
    access: [{ key: 'user', value: 'robot.protocollo' }, { key: 'password', value: '05/08' }, { key: 'lastCheck', value: '06:00' }],
    color: '#1d4ed8',
  },
  {
    id: 'pec', name: 'PEC Aruba', maker: 'Aruba', area: 'mail', // allow-italian: fixture data, shown as written
    description: 'La casella PEC dell\'ente. Topics legge le PEC in arrivo e invia le risposte solo con la ricevuta di consegna.', // allow-italian: fixture data, shown as written
    holds: [{ kind: 'mail', name: 'PEC' }, { kind: 'file', name: 'Allegato' }], // allow-italian: fixture data, shown as written
    reads: [
      { kind: 'mail', name: 'PEC', value: 'mittente, oggetto, data, ricevute' }, // allow-italian: fixture data, shown as written
      { kind: 'file', name: 'Allegato', value: 'PDF, XML, firme' }, // allow-italian: fixture data, shown as written
    ],
    connection: 'imap', state: 'ok',
    access: [{ key: 'mailbox', value: 'casella PEC dell\'ente' }, { key: 'scope', value: 'lettura e invio con conferma' }, { key: 'lastCheck', value: '10:29' }], // allow-italian: fixture data, shown as written
    color: '#2563eb',
  },
  {
    id: 'm365', name: 'Microsoft 365', maker: 'Microsoft', area: 'mail', // allow-italian: fixture data, shown as written
    description: 'Documenti Word e fogli Excel dell\'ente, su OneDrive e SharePoint.', // allow-italian: fixture data, shown as written
    holds: [{ kind: 'file', name: 'Documento' }, { kind: 'file', name: 'Excel' }], // allow-italian: fixture data, shown as written
    reads: [
      { kind: 'file', name: 'Documento', value: 'testo, versioni, autore' }, // allow-italian: fixture data, shown as written
      { kind: 'file', name: 'Excel', value: 'fogli, celle, formule' }, // allow-italian: fixture data, shown as written
    ],
    connection: 'mcp-official', state: 'ok',
    access: [{ key: 'user', value: 'account di servizio Topics' }, { key: 'scope', value: 'cartelle scelte dall\'ufficio' }, { key: 'lastCheck', value: '10:25' }], // allow-italian: fixture data, shown as written
    color: '#c2410c',
  },
  {
    id: 'prunes', name: 'Prunes', sub: 'Advanced Systems', maker: 'Advanced Systems', area: 'cadastre',
    description: 'Catasto, ruoli e riscossione. Topics legge, non scrive: le modifiche restano a chi usa Prunes.', // allow-italian: fixture data, shown as written
    holds: [{ kind: 'record', name: 'Contribuente' }, { kind: 'record', name: 'Avviso' }, { kind: 'record', name: 'Ruolo' }], // allow-italian: fixture data, shown as written
    reads: [
      { kind: 'record', name: 'Contribuente', value: 'codice, nome, immobili' }, // allow-italian: fixture data, shown as written
      { kind: 'record', name: 'Avviso', value: 'anno, importo, stato' }, // allow-italian: fixture data, shown as written
      { kind: 'record', name: 'Ruolo', value: 'emissione, scadenze' }, // allow-italian: fixture data, shown as written
    ],
    connection: 'database', state: 'ok',
    access: [{ key: 'user', value: 'topics_lettura' }, { key: 'tables', value: '7 di 214' }, { key: 'lastCheck', value: '06:00' }], // allow-italian: fixture data, shown as written
    color: '#92400e',
  },
  {
    id: 'teamsystem', name: 'TeamSystem', maker: 'TeamSystem', area: 'accounting', // allow-italian: fixture data, shown as written
    description: 'Contabilità e registrazione delle fatture. Non ha API: un agente sul PC della ragioneria lo usa come una persona.', // allow-italian: fixture data, shown as written
    holds: [{ kind: 'number', name: 'Fattura' }, { kind: 'person', name: 'Fornitore' }], // allow-italian: fixture data, shown as written
    reads: [
      { kind: 'number', name: 'Fattura', value: 'protocollo IVA, importi, scadenza' }, // allow-italian: fixture data, shown as written
      { kind: 'person', name: 'Fornitore', value: 'anagrafica, partita IVA' }, // allow-italian: fixture data, shown as written
    ],
    connection: 'pc-agent', state: 'ok', pcs: ['PC-RAGIONERIA-02'],
    access: [{ key: 'pc', value: 'PC-RAGIONERIA-02' }, { key: 'user', value: 'utente dell\'agente' }, { key: 'lastCheck', value: '10:28' }], // allow-italian: fixture data, shown as written
    color: '#0f766e',
  },
  {
    id: 'palegal', name: 'PA Legal', sub: 'contenzioso', maker: 'PA Legal', area: 'litigation', // allow-italian: fixture data, shown as written
    description: 'Il contenzioso dell\'ente: ricorsi, udienze, incarichi ai legali. Da collegare con il robot nel browser.', // allow-italian: fixture data, shown as written
    holds: [{ kind: 'legal', name: 'Ricorso' }, { kind: 'number', name: 'Udienza' }], // allow-italian: fixture data, shown as written
    reads: [
      { kind: 'legal', name: 'Ricorso', value: 'numero, giudice, parti' }, // allow-italian: fixture data, shown as written
      { kind: 'calendar', name: 'Udienza', value: 'data, aula, esito' }, // allow-italian: fixture data, shown as written
    ],
    connection: 'browser', state: 'to-connect',
    access: [{ key: 'user', value: 'da creare' }, { key: 'scope', value: 'sola lettura' }], // allow-italian: fixture data, shown as written
    color: '#7c3aed',
  },
  {
    id: 'publisys', name: 'Publisys', sub: 'paghe', maker: 'Publisys', area: 'litigation', // allow-italian: fixture data, shown as written
    description: 'Paghe e cedolini. Si usa dal PC del personale, che ha un sistema troppo vecchio per l\'agente: per ora solo file.', // allow-italian: fixture data, shown as written
    holds: [{ kind: 'record', name: 'Dipendente' }, { kind: 'file', name: 'Cedolino' }], // allow-italian: fixture data, shown as written
    reads: [
      { kind: 'record', name: 'Dipendente', value: 'ruolo, livello, presenze' }, // allow-italian: fixture data, shown as written
      { kind: 'file', name: 'Cedolino', value: 'PDF del mese' }, // allow-italian: fixture data, shown as written
    ],
    connection: 'file', state: 'to-connect',
    access: [{ key: 'folder', value: 'cartella condivisa del Personale' }, { key: 'pc', value: 'PC-PERSONALE-01' }], // allow-italian: fixture data, shown as written
    color: '#be185d',
  },
  {
    id: 'traspare', name: 'Traspare', maker: 'Traspare', area: 'tenders',
    description: 'Gare telematiche dell\'ente: bandi, offerte, verbali. Da collegare con il robot nel browser.', // allow-italian: fixture data, shown as written
    holds: [{ kind: 'folder', name: 'Gara' }], // allow-italian: fixture data, shown as written
    reads: [
      { kind: 'folder', name: 'Gara', value: 'CIG, stato, scadenza offerte' }, // allow-italian: fixture data, shown as written
      { kind: 'file', name: 'Offerta', value: 'documenti di gara' }, // allow-italian: fixture data, shown as written
    ],
    connection: 'browser', state: 'to-connect',
    access: [{ key: 'user', value: 'da creare' }, { key: 'scope', value: 'sola lettura' }], // allow-italian: fixture data, shown as written
    color: '#0369a1',
  },
  {
    id: 'anac', name: 'ANAC dati aperti', maker: 'ANAC', area: 'tenders', // allow-italian: fixture data, shown as written
    description: 'Dati pubblici dell\'autorità sui contratti: CIG, stazioni appaltanti, esiti. Si legge da un\'API pubblica, senza password.', // allow-italian: fixture data, shown as written
    holds: [{ kind: 'folder', name: 'CIG' }], // allow-italian: fixture data, shown as written
    reads: [
      { kind: 'folder', name: 'CIG', value: 'oggetto, importo, aggiudicatario' }, // allow-italian: fixture data, shown as written
    ],
    connection: 'api', state: 'to-connect',
    access: [{ key: 'scope', value: 'dati pubblici' }], // allow-italian: fixture data, shown as written
    color: '#7c3aed',
  },
  {
    id: 'qgis', name: 'QGIS', maker: 'QGIS.org', area: 'territory',
    description: 'Mappe, particelle e reticolo dei canali. Si collega con un MCP open source.', // allow-italian: fixture data, shown as written
    holds: [{ kind: 'record', name: 'Particella' }], // allow-italian: fixture data, shown as written
    reads: [
      { kind: 'record', name: 'Particella', value: 'foglio, particella, canale' }, // allow-italian: fixture data, shown as written
      { kind: 'file', name: 'Livelli', value: 'reticolo, perimetro di contribuenza' }, // allow-italian: fixture data, shown as written
    ],
    connection: 'mcp-open', state: 'ok', pcs: ['PC-TECNICO-04'],
    access: [{ key: 'pc', value: 'PC-TECNICO-04' }, { key: 'scope', value: 'sola lettura' }, { key: 'lastCheck', value: '10:20' }], // allow-italian: fixture data, shown as written
    color: '#15803d',
  },
  {
    id: 'autocad', name: 'AutoCAD', maker: 'Autodesk', area: 'territory',
    description: 'Tavole tecniche in DWG. Topics legge i file dal PC dell\'ufficio tecnico, non apre il programma.', // allow-italian: fixture data, shown as written
    holds: [{ kind: 'file', name: 'Tavola DWG' }], // allow-italian: fixture data, shown as written
    reads: [{ kind: 'file', name: 'Tavola DWG', value: 'nome, revisione, livelli' }], // allow-italian: fixture data, shown as written
    connection: 'file', state: 'file', pcs: ['PC-TECNICO-04'],
    access: [{ key: 'folder', value: 'cartella tavole dell\'ufficio tecnico' }, { key: 'pc', value: 'PC-TECNICO-04' }, { key: 'lastCheck', value: '10:20' }], // allow-italian: fixture data, shown as written
    color: '#475569',
  },
];

export const programSeed = (id: string): ProgramSeed | undefined => PROGRAMS.find((p) => p.id === id);

/* ---------- competitors and migration ---------- */

export interface AlternativeSeed {
  id: string;
  name: string;
  holds: string;
  connection: ConnectionKind;
  /** How it connects, in a few words (data: «API documentate»). */
  connectionNote: string;
  cloud: string;
  /** An estimate of the work to move the data over. */
  effort: string;
}

export interface MigrationAdvice {
  verdict: Verdict;
  headline: string;
  reason: string;
  /** When to look at it again, and what to do then. */
  revisit: Array<{ when: string; then: string }>;
  /** The plan if migrating, in months (estimates). */
  plan: Array<{ label: string; months: number }>;
  risks: string;
  /** What counts for the organization, as rows. */
  matters: Array<{ label: string; value: string }>;
}

export interface MigrationSeed {
  program: ProgramId;
  /** What the first column of the comparison is called for this program. */
  holdsLabel: string;
  alternatives: AlternativeSeed[];
  advice: MigrationAdvice;
  /** The agent's last research: date and number of sources, an estimate. */
  research: { date: string; sources: number };
}

const NOTE_SOURCES = { date: '2026-11-05', sources: 14 };

export const MIGRATIONS: MigrationSeed[] = [
  {
    program: 'halley', holdsLabel: 'Protocollo e atti', research: NOTE_SOURCES, // allow-italian: fixture data, shown as written
    alternatives: [
      { id: 'suite-a', name: 'Suite PA nazionale A', holds: 'sì', connection: 'api', connectionNote: 'API documentate', cloud: 'sì', effort: 'media, 3-4 mesi' }, // allow-italian: fixture data, shown as written
      { id: 'suite-b', name: 'Suite PA nazionale B', holds: 'sì', connection: 'mcp-official', connectionNote: 'MCP annunciato', cloud: 'sì', effort: 'alta, 6 mesi' }, // allow-italian: fixture data, shown as written
      { id: 'proto-oss', name: 'Protocollo open source', holds: 'solo protocollo', connection: 'api', connectionNote: 'API aperte', cloud: 'dipende da chi lo ospita', effort: 'media' }, // allow-italian: fixture data, shown as written
      { id: 'riuso', name: 'Software in riuso', holds: 'parziale', connection: 'file', connectionNote: 'da costruire', cloud: 'no', effort: 'alta' }, // allow-italian: fixture data, shown as written
    ],
    advice: {
      verdict: 'stay', headline: 'Restare su Halley per ora', // allow-italian: fixture data, shown as written
      reason: 'Il robot regge (1 errore in 30 giorni, per una password scaduta). Migrare oggi costerebbe mesi di lavoro per guadagnare poco.', // allow-italian: fixture data, shown as written
      revisit: [
        { when: 'Se Halley pubblica API o MCP', then: 'si passa a quelle' }, // allow-italian: fixture data, shown as written
        { when: 'Se gli errori superano il 2%', then: 'si valuta' }, // allow-italian: fixture data, shown as written
        { when: 'Sei mesi prima della scadenza del contratto', then: 'prima della gara' }, // allow-italian: fixture data, shown as written
      ],
      plan: [{ label: 'Prova con i dati di un anno', months: 1 }, { label: 'Due programmi in parallelo', months: 2 }, { label: 'Spegnimento e archivio', months: 1 }], // allow-italian: fixture data, shown as written
      risks: 'Conservazione a norma dei documenti già protocollati · formazione di 14 persone · numerazione del protocollo che non deve interrompersi.', // allow-italian: fixture data, shown as written
      matters: [
        { label: 'Errori del robot su Halley, 30 gg', value: '1' }, // allow-italian: fixture data, shown as written
        { label: 'Contratto Halley', value: 'scadenza da caricare' }, // allow-italian: fixture data, shown as written
        { label: 'Persone che lo usano, esempio', value: '14 delle 31' }, // allow-italian: fixture data, shown as written
      ],
    },
  },
  {
    program: 'prunes', holdsLabel: 'Catasto e ruoli', research: NOTE_SOURCES, // allow-italian: fixture data, shown as written
    alternatives: [
      { id: 'gest-catasto', name: 'Gestionale catasto consortile', holds: 'sì', connection: 'api', connectionNote: 'API REST', cloud: 'sì, qualificato ACN', effort: 'alta, 6-8 mesi' }, // allow-italian: fixture data, shown as written
      { id: 'riuso-consorzio', name: 'Software in riuso da un altro consorzio', holds: 'parziale', connection: 'file', connectionNote: 'da valutare', cloud: 'no', effort: 'alta, serve chi lo mantiene' }, // allow-italian: fixture data, shown as written
    ],
    advice: {
      verdict: 'stay', headline: 'Restare su Prunes', // allow-italian: fixture data, shown as written
      reason: 'La lettura diretta dal database dà tutto ciò che serve ai flussi e non rompe niente: Topics non scrive. Ruoli e riscossione non si spostano a cuor leggero.', // allow-italian: fixture data, shown as written
      revisit: [
        { when: 'Se Prunes pubblica un MCP o API', then: 'si passa a quelle' }, // allow-italian: fixture data, shown as written
        { when: 'Se la lettura dal database viene negata dal fornitore', then: 'si valuta' }, // allow-italian: fixture data, shown as written
        { when: 'Prima di ogni emissione dei ruoli', then: 'si controlla il collegamento' }, // allow-italian: fixture data, shown as written
      ],
      plan: [{ label: 'Prova con i ruoli di un anno', months: 2 }, { label: 'Due programmi in parallelo', months: 4 }, { label: 'Spegnimento e archivio', months: 1 }], // allow-italian: fixture data, shown as written
      risks: 'Storico dei ruoli e delle cartelle esattoriali · continuità della riscossione · allineamento del catasto consortile.', // allow-italian: fixture data, shown as written
      matters: [
        { label: 'Errori del collegamento, 30 gg', value: '0' }, // allow-italian: fixture data, shown as written
        { label: 'Contratto Prunes', value: 'scadenza da caricare' }, // allow-italian: fixture data, shown as written
      ],
    },
  },
  {
    program: 'teamsystem', holdsLabel: 'Contabilità', research: NOTE_SOURCES, // allow-italian: fixture data, shown as written
    alternatives: [
      { id: 'cont-a', name: 'Contabilità armonizzata A', holds: 'sì', connection: 'api', connectionNote: 'API documentate', cloud: 'sì', effort: 'media, 4-5 mesi' }, // allow-italian: fixture data, shown as written
      { id: 'cont-b', name: 'Contabilità armonizzata B', holds: 'sì', connection: 'mcp-official', connectionNote: 'MCP annunciato', cloud: 'sì', effort: 'alta, 6 mesi' }, // allow-italian: fixture data, shown as written
      { id: 'erp-oss', name: 'ERP open source', holds: 'parziale', connection: 'api', connectionNote: 'API aperte', cloud: 'dipende da chi lo ospita', effort: 'alta' }, // allow-italian: fixture data, shown as written
    ],
    advice: {
      verdict: 'evaluate', headline: 'Valutare un\'alternativa con API', // allow-italian: fixture data, shown as written
      reason: 'L\'agente sul PC funziona, ma è il collegamento più delicato: dipende da un PC del 2015 e da maschere che cambiano a ogni aggiornamento. Vale la pena guardare chi offre API prima del prossimo rinnovo.', // allow-italian: fixture data, shown as written
      revisit: [
        { when: 'Se TeamSystem pubblica API per la registrazione', then: 'si passa a quelle' }, // allow-italian: fixture data, shown as written
        { when: 'Se l\'agente sbaglia più del 2% delle registrazioni', then: 'si valuta' }, // allow-italian: fixture data, shown as written
        { when: 'Sei mesi prima del rinnovo', then: 'si confronta con le alternative' }, // allow-italian: fixture data, shown as written
      ],
      plan: [{ label: 'Prova con le fatture di un anno', months: 1 }, { label: 'Due programmi in parallelo', months: 3 }, { label: 'Chiusura dell\'esercizio e archivio', months: 1 }], // allow-italian: fixture data, shown as written
      risks: 'Chiusura dell\'esercizio · split payment e registri IVA · formazione della ragioneria.', // allow-italian: fixture data, shown as written
      matters: [
        { label: 'Contratto TeamSystem', value: 'scadenza da caricare' }, // allow-italian: fixture data, shown as written
      ],
    },
  },
  {
    program: 'traspare', holdsLabel: 'Gare', research: NOTE_SOURCES, // allow-italian: fixture data, shown as written
    alternatives: [
      { id: 'gare-a', name: 'Piattaforma gare A', holds: 'sì', connection: 'api', connectionNote: 'API pubbliche', cloud: 'sì', effort: 'media, 2 mesi' }, // allow-italian: fixture data, shown as written
      { id: 'gare-b', name: 'Piattaforma gare B', holds: 'sì', connection: 'browser', connectionNote: 'solo robot', cloud: 'sì', effort: 'media, 2 mesi' }, // allow-italian: fixture data, shown as written
    ],
    advice: {
      verdict: 'integrate', headline: 'Integrare Traspare con il robot', // allow-italian: fixture data, shown as written
      reason: 'Le gare sono poche e il portale va bene: conviene collegarlo col robot nel browser e leggere i CIG dai dati aperti, senza cambiare piattaforma.', // allow-italian: fixture data, shown as written
      revisit: [
        { when: 'Se la piattaforma pubblica API', then: 'si passa a quelle' }, // allow-italian: fixture data, shown as written
        { when: 'Alla prossima gara con accordo quadro', then: 'si ricontrolla' }, // allow-italian: fixture data, shown as written
      ],
      plan: [{ label: 'Collegare il robot e provarlo', months: 1 }, { label: 'Due piattaforme in parallelo', months: 1 }],  // allow-italian: fixture data, shown as written
      risks: 'Gare in corso sulla piattaforma attuale · credenziali dei responsabili del procedimento.', // allow-italian: fixture data, shown as written
      matters: [{ label: 'Contratto Traspare', value: 'scadenza da caricare' }], // allow-italian: fixture data, shown as written
    },
  },
  {
    program: 'autocad', holdsLabel: 'Tavole tecniche', research: NOTE_SOURCES, // allow-italian: fixture data, shown as written
    alternatives: [
      { id: 'cad-oss', name: 'CAD open source', holds: 'sì', connection: 'mcp-open', connectionNote: 'MCP open source', cloud: 'no', effort: 'bassa, i DWG restano' }, // allow-italian: fixture data, shown as written
      { id: 'cad-abb', name: 'CAD in abbonamento', holds: 'sì', connection: 'api', connectionNote: 'API documentate', cloud: 'sì', effort: 'media' }, // allow-italian: fixture data, shown as written
    ],
    advice: {
      verdict: 'stay', headline: 'Restare su AutoCAD', // allow-italian: fixture data, shown as written
      reason: 'A Topics servono i file, non il programma: leggere i DWG dalla cartella basta. Cambiare CAD non cambierebbe niente per i flussi.', // allow-italian: fixture data, shown as written
      revisit: [{ when: 'Se serve leggere i livelli dentro le tavole', then: 'si valuta un CAD con MCP' }], // allow-italian: fixture data, shown as written
      plan: [{ label: 'Prova con le tavole di un anno', months: 1 }, { label: 'Passaggio degli utenti', months: 2 }], // allow-italian: fixture data, shown as written
      risks: 'Licenze e abbonamenti in corso · formazione dell\'ufficio tecnico.', // allow-italian: fixture data, shown as written
      matters: [{ label: 'Contratto AutoCAD', value: 'scadenza da caricare' }], // allow-italian: fixture data, shown as written
    },
  },
  {
    program: 'publisys', holdsLabel: 'Paghe', research: NOTE_SOURCES, // allow-italian: fixture data, shown as written
    alternatives: [],
    advice: {
      verdict: 'integrate', headline: 'Integrare Publisys con i file', // allow-italian: fixture data, shown as written
      reason: 'Si resta su Publisys, ma si sostituisce il PC del personale: con l\'agente al suo posto i cedolini arrivano da soli.', // allow-italian: fixture data, shown as written
      revisit: [{ when: 'Appena il PC del personale è sostituito', then: 'si installa l\'agente' }], // allow-italian: fixture data, shown as written
      plan: [{ label: 'Sostituire il PC e installare l\'agente', months: 1 }], // allow-italian: fixture data, shown as written
      risks: 'Dati dei dipendenti: l\'agente legge solo la cartella dei cedolini.', // allow-italian: fixture data, shown as written
      matters: [{ label: 'Contratto Publisys', value: 'scadenza da caricare' }], // allow-italian: fixture data, shown as written
    },
  },
  {
    program: 'palegal', holdsLabel: 'Contenzioso', research: NOTE_SOURCES, // allow-italian: fixture data, shown as written
    alternatives: [],
    advice: {
      verdict: 'integrate', headline: 'Integrare PA Legal con il robot', // allow-italian: fixture data, shown as written
      reason: 'Non ci sono alternative da confrontare: conviene collegarlo, così i ricorsi arrivano nelle pratiche senza ricopiare.', // allow-italian: fixture data, shown as written
      revisit: [{ when: 'Dopo il primo mese di robot', then: 'si guardano gli errori' }], // allow-italian: fixture data, shown as written
      plan: [{ label: 'Collegare il robot e provarlo', months: 1 }], // allow-italian: fixture data, shown as written
      risks: 'Dati di persone vere: il robot legge solo i ricorsi dell\'ente.', // allow-italian: fixture data, shown as written
      matters: [{ label: 'Contratto PA Legal', value: 'scadenza da caricare' }], // allow-italian: fixture data, shown as written
    },
  },
  {
    program: 'qgis', holdsLabel: 'Territorio', research: NOTE_SOURCES, // allow-italian: fixture data, shown as written
    alternatives: [],
    advice: {
      verdict: 'stay', headline: 'Restare su QGIS', // allow-italian: fixture data, shown as written
      reason: 'È open source e ha già un MCP: non c\'è niente da migliorare.', // allow-italian: fixture data, shown as written
      revisit: [{ when: 'Se l\'MCP non viene più aggiornato', then: 'si valuta' }], // allow-italian: fixture data, shown as written
      plan: [],
      risks: '',
      matters: [],
    },
  },
  {
    program: 'm365', holdsLabel: 'Documenti', research: NOTE_SOURCES, // allow-italian: fixture data, shown as written
    alternatives: [],
    advice: {
      verdict: 'stay', headline: 'Restare su Microsoft 365', // allow-italian: fixture data, shown as written
      reason: 'Ha un MCP ufficiale: è il collegamento più solido che l\'ente ha.', // allow-italian: fixture data, shown as written
      revisit: [{ when: 'Se cambia il piano di licenza', then: 'si ricontrolla' }], // allow-italian: fixture data, shown as written
      plan: [],
      risks: '',
      matters: [],
    },
  },
  {
    program: 'pec', holdsLabel: 'Posta certificata', research: NOTE_SOURCES, // allow-italian: fixture data, shown as written
    alternatives: [],
    advice: {
      verdict: 'stay', headline: 'Restare su PEC Aruba', // allow-italian: fixture data, shown as written
      reason: 'Il collegamento IMAP con invio con conferma regge: la PEC è un canale a norma, non conviene cambiarlo.', // allow-italian: fixture data, shown as written
      revisit: [{ when: 'Se cambia l\'indirizzo PEC dell\'ente', then: 'si ricollega' }], // allow-italian: fixture data, shown as written
      plan: [],
      risks: '',
      matters: [],
    },
  },
];

export const migrationOf = (program: string): MigrationSeed | undefined => MIGRATIONS.find((m) => m.program === program);

/* ---------- PCs and agents ---------- */

/** The version of the agent that is current; a PC on an older one can be updated. */
export const AGENT_VERSION = '1.8.2';

/** What the agent costs a PC: declared figures, the same on every screen. */
export const AGENT_FOOTPRINT = { memoryMb: 60, installerMb: 9, minFreeGb: 2, minWindows: 10 };

export type PcKind = 'agent' | 'remote-only' | 'none' | 'server';

export interface PcSeed {
  id: string;
  office: string;
  os: string;
  ramGb: number;
  /** Year of the machine, when known. */
  year?: number;
  kind: PcKind;
  /** The programs the agent works in. */
  programs: ProgramId[];
  /** What the PC does, as shown (data). */
  does: string;
  version?: string;
  /** Minutes since the last signal. */
  lastSeenMin: number;
  /** Too old to receive the agent. */
  tooOld?: boolean;
  /** The line under the table for a PC that cannot take the agent. */
  advice?: string;
  /** The window the remote control shows on this PC. */
  window: 'teamsystem' | 'halley' | 'qgis' | 'desktop';
}

export const COMPUTERS: PcSeed[] = [
  { id: 'PC-RAGIONERIA-02', office: 'Ragioneria', os: 'Windows 10', ramGb: 4, year: 2015, kind: 'agent', programs: ['teamsystem'], does: 'agente: TeamSystem', version: '1.8.2', lastSeenMin: 0, window: 'teamsystem' }, // allow-italian: fixture data, shown as written
  { id: 'PC-PROTOCOLLO-01', office: 'Protocollo', os: 'Windows 11', ramGb: 8, kind: 'remote-only', programs: [], does: 'solo controllo remoto', version: '1.8.2', lastSeenMin: 2, window: 'halley' }, // allow-italian: fixture data, shown as written
  { id: 'PC-TECNICO-04', office: 'Ufficio tecnico', os: 'Windows 10', ramGb: 8, kind: 'agent', programs: ['qgis', 'autocad'], does: 'agente: QGIS, AutoCAD', version: '1.8.0', lastSeenMin: 1, window: 'qgis' }, // allow-italian: fixture data, shown as written
  {
    id: 'PC-PERSONALE-01', office: 'Personale', os: 'Windows 7', ramGb: 2, kind: 'none', programs: [], does: '', lastSeenMin: 0, tooOld: true, window: 'desktop', // allow-italian: fixture data, shown as written
    advice: 'Windows 7 non riceve più aggiornamenti di sicurezza: l\'agente non si installa. Consiglio: sostituire il PC; fino ad allora Publisys si usa da un altro PC dell\'ufficio.', // allow-italian: fixture data, shown as written
  },
];

/** The Topics server for the programs that run in a browser. */
export const SERVER_PC = { id: 'Server Topics', where: 'Italia', traits: 'browser senza finestra', programs: ['halley', 'traspare', 'palegal'] as ProgramId[] }; // allow-italian: fixture data, shown as written

/** The offices a new PC can be linked to. */
export const PC_OFFICES = ['Ragioneria', 'Protocollo', 'Ufficio tecnico', 'Personale', 'Segreteria', 'Catasto e ruoli']; // allow-italian: fixture data, shown as written

/* ---------- smart search: where a kind of document lives ---------- */

export interface DocumentLocation {
  id: string;
  document: string;
  /** Other words that find it. */
  keywords: string;
  program: ProgramId;
  /** The path to it inside the program. */
  path: string[];
  /** How Topics gets it, one sentence (data: it names the program's screens). */
  fetch: string;
  /** What a first fetch finds: an example of the result. */
  example: string;
}

export const DOCUMENT_LOCATIONS: DocumentLocation[] = [
  { id: 'protocolli', document: 'Protocolli in entrata e in uscita', keywords: 'protocollo registro numero mittente posta', program: 'halley', path: ['Protocollo', 'Registro'], fetch: 'Il robot filtra per data e numero e legge la scheda del protocollo.', example: '12 protocolli dell\'ultima settimana (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'fascicoli', document: 'Fascicoli', keywords: 'fascicolo titolario pratica archivio', program: 'halley', path: ['Protocollo', 'Fascicoli'], fetch: 'Il robot apre il fascicolo dal numero e legge i documenti collegati.', example: '3 fascicoli aperti da ieri (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'delibere', document: 'Delibere e determine', keywords: 'delibera determina determinazione atti consiglio', program: 'halley', path: ['Atti', 'Delibere e determine'], fetch: 'Il robot cerca per anno e numero e scarica il PDF firmato.', example: '5 atti dell\'ultimo mese (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'albo', document: 'Albo pretorio', keywords: 'albo pubblicazione pretorio avviso pubblico', program: 'halley', path: ['Albo', 'Pubblicazioni in corso'], fetch: 'Il robot legge l\'elenco delle pubblicazioni e le date di scadenza.', example: '8 pubblicazioni in corso (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'avvisi', document: 'Avvisi di pagamento dei contributi', keywords: 'avviso avvisi contributo contributi pagamento cartella', program: 'prunes', path: ['Riscossione', 'Avvisi'], fetch: 'Lettura diretta dal database: anno, importo e stato, senza aprire il programma.', example: 'Avvisi dell\'anno in corso, con stato pagato o aperto (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'ruoli', document: 'Ruoli', keywords: 'ruolo ruoli emissione scadenze riscossione', program: 'prunes', path: ['Ruoli', 'Emissioni'], fetch: 'Lettura diretta dal database: emissione e scadenze di ogni ruolo.', example: 'Ruoli emessi negli ultimi due anni (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'contribuenti', document: 'Contribuenti e immobili', keywords: 'contribuente contribuenti immobili catasto consortile particelle intestatario', program: 'prunes', path: ['Catasto', 'Contribuenti'], fetch: 'Lettura diretta dal database: codice, nome e immobili del contribuente.', example: 'Un contribuente di esempio con 3 immobili' }, // allow-italian: fixture data, shown as written
  { id: 'fatture', document: 'Fatture passive registrate', keywords: 'fattura fatture passive acquisti registrazione iva fornitore', program: 'teamsystem', path: ['Contabilità', 'Acquisti', 'Registrazione fattura'], fetch: 'L\'agente sul PC della ragioneria apre la registrazione e legge il numero.', example: 'Registrazione 2026/1188, Ricambi Sud (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'fornitori', document: 'Anagrafica fornitori', keywords: 'fornitore fornitori anagrafica partita iva', program: 'teamsystem', path: ['Contabilità', 'Anagrafiche', 'Fornitori'], fetch: 'L\'agente cerca il fornitore per nome o partita IVA e legge la scheda.', example: 'Un fornitore di esempio con partita IVA e condizioni' }, // allow-italian: fixture data, shown as written
  { id: 'cedolini', document: 'Cedolini e anagrafica dipendenti', keywords: 'cedolino cedolini paghe dipendenti stipendi personale', program: 'publisys', path: ['Cartella condivisa del Personale', 'Cedolini'], fetch: 'Legge i PDF del mese dalla cartella condivisa; il PC del personale non ha l\'agente.', example: 'PDF dei cedolini del mese (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'ricorsi', document: 'Ricorsi e udienze', keywords: 'ricorso ricorsi udienza udienze contenzioso giudice tar cgt', program: 'palegal', path: ['Contenzioso', 'Ricorsi'], fetch: 'Il robot nel browser apre la scheda del ricorso e legge udienze ed esiti.', example: 'Ricorsi aperti con la prossima udienza (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'gare', document: 'Gare e CIG', keywords: 'gara gare cig bando appalto offerte accordo quadro', program: 'traspare', path: ['Gare', 'Procedure in corso'], fetch: 'Il robot nel browser legge CIG, stato e scadenza delle offerte.', example: 'Gare in corso con il CIG (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'particelle', document: 'Particelle e perimetro di contribuenza', keywords: 'particella particelle perimetro mappa catasto foglio canale reticolo', program: 'qgis', path: ['Progetto del comprensorio', 'Livello particelle'], fetch: 'L\'MCP di QGIS risponde con foglio, particella e canale più vicino.', example: 'Foglio e particella con il canale di riferimento (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'tavole', document: 'Tavole tecniche', keywords: 'tavola tavole dwg disegno progetto cad rilievo', program: 'autocad', path: ['Cartella tavole', 'DWG'], fetch: 'Legge il file DWG dalla cartella dell\'ufficio tecnico, senza aprire il programma.', example: 'Elenco dei DWG con nome e revisione (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'pec-ricevute', document: 'PEC e ricevute di consegna', keywords: 'pec ricevuta ricevute consegna posta certificata allegati', program: 'pec', path: ['Casella PEC', 'Posta in arrivo'], fetch: 'Legge la casella via IMAP; ogni invio parte solo con la conferma di una persona.', example: 'PEC arrivate oggi con le ricevute (esempio)' }, // allow-italian: fixture data, shown as written
  { id: 'documenti', document: 'Documenti di lavoro e fogli Excel', keywords: 'word excel documento documenti foglio fogli onedrive sharepoint', program: 'm365', path: ['OneDrive e SharePoint', 'Cartelle scelte dall\'ufficio'], fetch: 'L\'MCP ufficiale legge i file delle cartelle scelte dall\'ufficio.', example: 'File modificati negli ultimi 7 giorni (esempio)' }, // allow-italian: fixture data, shown as written
];

/* ---------- smart search: the catalogue of programs ---------- */

export type CatalogTag = 'in-use' | 'competitor' | 'reuse' | 'open-source';

export interface CatalogEntry {
  id: string;
  name: string;
  maker: string;
  initial: string;
  color: string;
  tag?: CatalogTag;
  description: string;
  connection: ConnectionKind;
  connectionNote?: string;
  /** Short facts shown as chips, e.g. «cloud qualificato ACN». */
  facts: string[];
  /** The sources, by label; they open a source panel. */
  links: string[];
  /** The program of the organization this is, when it is in use. */
  program?: ProgramId;
  /** Words the facets of the question are matched on. */
  sectors: string[];
  functions: string[];
  /** The way it connects to an AI, as a kind: `mcp` or `api`. */
  hooks: Array<'mcp' | 'api' | 'robot' | 'file'>;
  regions: string[];
}

export const CATALOG: CatalogEntry[] = [
  {
    id: 'cat-prunes', name: 'Prunes', maker: 'Advanced Systems', initial: 'P', color: '#92400e', tag: 'in-use', program: 'prunes',
    description: 'Catasto consortile, ruoli e riscossione.', // allow-italian: fixture data, shown as written
    connection: 'database', connectionNote: 'database · lettura', facts: ['MCP: non pubblicato'], links: ['sito del produttore', 'capitolato ente'], // allow-italian: fixture data, shown as written
    sectors: ['consorzi di bonifica'], functions: ['catasto', 'ruoli', 'riscossione'], hooks: ['api'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-gestionale-catasto', name: 'Gestionale catasto consortile', maker: 'fornitore regionale', initial: 'C', color: '#0369a1', tag: 'competitor', // allow-italian: fixture data, shown as written
    description: 'Catasto e ruoli in cloud, con API documentate. Esempio di concorrente.', // allow-italian: fixture data, shown as written
    connection: 'api', connectionNote: 'API REST', facts: ['cloud qualificato ACN'], links: ['catalogo ACN', 'documentazione API'], // allow-italian: fixture data, shown as written
    sectors: ['consorzi di bonifica'], functions: ['catasto', 'ruoli', 'riscossione'], hooks: ['api'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-qgis', name: 'QGIS + plugin catasto', maker: 'open source', initial: 'Q', color: '#15803d', tag: 'in-use', program: 'qgis', // allow-italian: fixture data, shown as written
    description: 'Non gestisce i ruoli, ma tiene le particelle e il perimetro di contribuenza. Si collega via MCP open source.', // allow-italian: fixture data, shown as written
    connection: 'mcp-open', connectionNote: 'MCP open source', facts: [], links: ['GitHub'],
    sectors: ['consorzi di bonifica', 'enti pubblici'], functions: ['catasto', 'territorio'], hooks: ['mcp'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-riuso', name: 'Software in riuso da un altro consorzio', maker: 'catalogo Developers Italia', initial: 'R', color: '#64748b', tag: 'reuse', // allow-italian: fixture data, shown as written
    description: 'Codice pubblicato per il riuso tra enti. Gratuito, ma senza assistenza: serve chi lo mantiene.', // allow-italian: fixture data, shown as written
    connection: 'file', connectionNote: 'da valutare', facts: [], links: ['Developers Italia'], // allow-italian: fixture data, shown as written
    sectors: ['consorzi di bonifica', 'enti pubblici'], functions: ['catasto', 'ruoli', 'riscossione'], hooks: ['file'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-halley', name: 'Halley', maker: 'Halley', initial: 'H', color: '#1d4ed8', tag: 'in-use', program: 'halley',
    description: 'Protocollo, atti e albo.', // allow-italian: fixture data, shown as written
    connection: 'browser', connectionNote: 'solo robot', facts: ['cloud qualificato ACN'], links: ['sito del produttore'], // allow-italian: fixture data, shown as written
    sectors: ['enti pubblici', 'consorzi di bonifica'], functions: ['protocollo', 'atti', 'albo'], hooks: ['robot'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-suite-a', name: 'Suite PA nazionale A', maker: 'fornitore nazionale', initial: 'S', color: '#4338ca', tag: 'competitor', // allow-italian: fixture data, shown as written
    description: 'Protocollo e atti in cloud, con API documentate. Esempio di concorrente.', // allow-italian: fixture data, shown as written
    connection: 'api', connectionNote: 'API documentate', facts: ['cloud qualificato ACN'], links: ['catalogo ACN', 'documentazione API'], // allow-italian: fixture data, shown as written
    sectors: ['enti pubblici'], functions: ['protocollo', 'atti', 'albo'], hooks: ['api'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-suite-b', name: 'Suite PA nazionale B', maker: 'fornitore nazionale', initial: 'S', color: '#7c3aed', tag: 'competitor', // allow-italian: fixture data, shown as written
    description: 'Protocollo e atti in cloud, MCP annunciato dal produttore. Esempio di concorrente.', // allow-italian: fixture data, shown as written
    connection: 'mcp-official', connectionNote: 'MCP annunciato', facts: ['cloud qualificato ACN'], links: ['catalogo ACN'], // allow-italian: fixture data, shown as written
    sectors: ['enti pubblici'], functions: ['protocollo', 'atti', 'albo'], hooks: ['mcp'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-proto-oss', name: 'Protocollo open source', maker: 'open source', initial: 'P', color: '#0f766e', tag: 'open-source', // allow-italian: fixture data, shown as written
    description: 'Solo protocollo, con API aperte. Dipende da chi lo ospita.', // allow-italian: fixture data, shown as written
    connection: 'api', connectionNote: 'API aperte', facts: [], links: ['GitHub'],
    sectors: ['enti pubblici'], functions: ['protocollo'], hooks: ['api'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-teamsystem', name: 'TeamSystem', maker: 'TeamSystem', initial: 'T', color: '#0f766e', tag: 'in-use', program: 'teamsystem', // allow-italian: fixture data, shown as written
    description: 'Contabilità e registrazione delle fatture.', // allow-italian: fixture data, shown as written
    connection: 'pc-agent', connectionNote: 'agente sul PC', facts: [], links: ['sito del produttore'], // allow-italian: fixture data, shown as written
    sectors: ['enti pubblici', 'consorzi di bonifica'], functions: ['contabilità', 'fatture'], hooks: ['robot'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-cont-a', name: 'Contabilità armonizzata A', maker: 'fornitore nazionale', initial: 'C', color: '#b45309', tag: 'competitor', // allow-italian: fixture data, shown as written
    description: 'Contabilità armonizzata in cloud, con API documentate. Esempio di concorrente.', // allow-italian: fixture data, shown as written
    connection: 'api', connectionNote: 'API documentate', facts: ['cloud qualificato ACN'], links: ['catalogo ACN'], // allow-italian: fixture data, shown as written
    sectors: ['enti pubblici'], functions: ['contabilità', 'fatture'], hooks: ['api'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-publisys', name: 'Publisys', maker: 'Publisys', initial: 'P', color: '#be185d', tag: 'in-use', program: 'publisys', // allow-italian: fixture data, shown as written
    description: 'Paghe e cedolini.', // allow-italian: fixture data, shown as written
    connection: 'file', connectionNote: 'solo file', facts: [], links: ['sito del produttore'], // allow-italian: fixture data, shown as written
    sectors: ['enti pubblici'], functions: ['paghe', 'cedolini', 'personale'], hooks: ['file'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-palegal', name: 'PA Legal', maker: 'PA Legal', initial: 'L', color: '#7c3aed', tag: 'in-use', program: 'palegal', // allow-italian: fixture data, shown as written
    description: 'Contenzioso dell\'ente: ricorsi e udienze.', // allow-italian: fixture data, shown as written
    connection: 'browser', connectionNote: 'solo robot', facts: [], links: ['sito del produttore'], // allow-italian: fixture data, shown as written
    sectors: ['enti pubblici'], functions: ['contenzioso', 'ricorsi', 'legale'], hooks: ['robot'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-traspare', name: 'Traspare', maker: 'Traspare', initial: 'T', color: '#0369a1', tag: 'in-use', program: 'traspare', // allow-italian: fixture data, shown as written
    description: 'Gare telematiche.', // allow-italian: fixture data, shown as written
    connection: 'browser', connectionNote: 'solo robot', facts: [], links: ['sito del produttore'], // allow-italian: fixture data, shown as written
    sectors: ['enti pubblici'], functions: ['gare', 'appalti'], hooks: ['robot'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-gare-a', name: 'Piattaforma gare A', maker: 'fornitore nazionale', initial: 'G', color: '#4338ca', tag: 'competitor', // allow-italian: fixture data, shown as written
    description: 'Gare telematiche con API pubbliche. Esempio di concorrente.', // allow-italian: fixture data, shown as written
    connection: 'api', connectionNote: 'API pubbliche', facts: ['cloud qualificato ACN'], links: ['catalogo ACN'], // allow-italian: fixture data, shown as written
    sectors: ['enti pubblici'], functions: ['gare', 'appalti'], hooks: ['api'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-autocad', name: 'AutoCAD', maker: 'Autodesk', initial: 'A', color: '#475569', tag: 'in-use', program: 'autocad',
    description: 'Tavole tecniche in DWG.', // allow-italian: fixture data, shown as written
    connection: 'file', connectionNote: 'solo file', facts: [], links: ['sito del produttore'], // allow-italian: fixture data, shown as written
    sectors: ['enti pubblici', 'consorzi di bonifica'], functions: ['cad', 'tavole', 'territorio'], hooks: ['file'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-m365', name: 'Microsoft 365', maker: 'Microsoft', initial: 'M', color: '#c2410c', tag: 'in-use', program: 'm365', // allow-italian: fixture data, shown as written
    description: 'Documenti Word e fogli Excel, con MCP ufficiale.', // allow-italian: fixture data, shown as written
    connection: 'mcp-official', connectionNote: 'MCP ufficiale', facts: [], links: ['sito del produttore'], // allow-italian: fixture data, shown as written
    sectors: ['enti pubblici', 'consorzi di bonifica'], functions: ['documenti', 'posta'], hooks: ['mcp'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
  {
    id: 'cat-pec', name: 'PEC Aruba', maker: 'Aruba', initial: 'P', color: '#2563eb', tag: 'in-use', program: 'pec', // allow-italian: fixture data, shown as written
    description: 'Posta elettronica certificata.', // allow-italian: fixture data, shown as written
    connection: 'imap', connectionNote: 'IMAP + invio con conferma', facts: [], links: ['sito del produttore'], // allow-italian: fixture data, shown as written
    sectors: ['enti pubblici', 'consorzi di bonifica'], functions: ['pec', 'posta'], hooks: ['api'], regions: ['campania'], // allow-italian: fixture data, shown as written
  },
];

/** The words of a question that become facets, each with the facet it stands for (data: sector vocabulary). */
export interface FacetRule {
  kind: 'sector' | 'function' | 'hook' | 'region';
  /** The value the facet takes, shown as written. */
  value: string;
  /** A word that triggers it (a prefix, accents ignored). */
  words: string[];
}

export const FACET_RULES: FacetRule[] = [
  { kind: 'sector', value: 'consorzi di bonifica', words: ['consorz', 'bonifica'] }, // allow-italian: fixture data, shown as written
  { kind: 'sector', value: 'enti pubblici', words: ['ente', 'enti', 'comune', 'pubblic'] }, // allow-italian: fixture data, shown as written
  { kind: 'function', value: 'catasto, ruoli, riscossione', words: ['catast', 'ruol', 'riscoss', 'contribu'] }, // allow-italian: fixture data, shown as written
  { kind: 'function', value: 'protocollo, atti, albo', words: ['protocoll', 'atti', 'albo', 'delibere'] }, // allow-italian: fixture data, shown as written
  { kind: 'function', value: 'contabilità, fatture', words: ['contabil', 'fattur', 'bilancio'] }, // allow-italian: fixture data, shown as written
  { kind: 'function', value: 'paghe, cedolini', words: ['paghe', 'cedolin', 'stipend', 'personale'] }, // allow-italian: fixture data, shown as written
  { kind: 'function', value: 'gare, appalti', words: ['gara', 'gare', 'appalt', 'bandi'] }, // allow-italian: fixture data, shown as written
  { kind: 'function', value: 'contenzioso, ricorsi', words: ['contenzios', 'ricors', 'legale'] }, // allow-italian: fixture data, shown as written
  { kind: 'function', value: 'cad, tavole, territorio', words: ['cad', 'tavol', 'gis', 'mappe', 'particell'] }, // allow-italian: fixture data, shown as written
  { kind: 'function', value: 'pec, posta', words: ['pec', 'posta', 'mail'] }, // allow-italian: fixture data, shown as written
  { kind: 'hook', value: 'MCP o API', words: ['mcp', 'api', 'collegar'] }, // allow-italian: fixture data, shown as written
  { kind: 'region', value: 'Campania', words: ['campania', 'napoli', 'salerno'] },
];

/** Maps the display value of a function facet back to the entries' own function words. */
export const FUNCTION_WORDS: Record<string, string[]> = {
  'catasto, ruoli, riscossione': ['catasto', 'ruoli', 'riscossione'], // allow-italian: fixture data, shown as written
  'protocollo, atti, albo': ['protocollo', 'atti', 'albo'], // allow-italian: fixture data, shown as written
  'contabilità, fatture': ['contabilità', 'fatture'], // allow-italian: fixture data, shown as written
  'paghe, cedolini': ['paghe', 'cedolini', 'personale'], // allow-italian: fixture data, shown as written
  'gare, appalti': ['gare', 'appalti'], // allow-italian: fixture data, shown as written
  'contenzioso, ricorsi': ['contenzioso', 'ricorsi', 'legale'], // allow-italian: fixture data, shown as written
  'cad, tavole, territorio': ['cad', 'tavole', 'territorio'], // allow-italian: fixture data, shown as written
  'pec, posta': ['pec', 'posta'], // allow-italian: fixture data, shown as written
};

/** The example catalogue's declared numbers, the same wherever they are shown. */
export const CATALOG_STATS = { programs: 184, officialMcp: 23, api: 71, robotOrAgent: 90 };

/** What was archived lately, before the reader archives anything. */
export const RECENTLY_ARCHIVED: Array<{ name: string; where: string }> = [
  { name: 'WinWaste', where: 'ORBIT · ieri' }, // allow-italian: fixture data, shown as written
  { name: 'Enviro', where: 'ORBIT · ieri' }, // allow-italian: fixture data, shown as written
  { name: 'Traspare', where: 'Nocera · 3/11' }, // allow-italian: fixture data, shown as written
];

/** The question the smart search opens with. */
export const DEFAULT_CATALOG_QUERY = 'un programma per il catasto consortile e i ruoli che si possa collegare all\'AI'; // allow-italian: fixture data, shown as written

/** Suggestions under the search box, as people would ask. */
export const WHERE_SUGGESTIONS = ['avvisi', 'ruoli', 'protocolli', 'delibere', 'fatture', 'cedolini']; // allow-italian: fixture data, shown as written

/* ---------- the agent at work on the accounting PC (p02) ---------- */

export interface InvoiceExample {
  id: string;
  title: string;
  vatProtocol: string;
  supplier: string;
  documentNumber: string;
  documentDate: string;
  taxable: string;
  vatCode: string;
  vat: string;
  total: string;
  costCentre: string;
  due: string;
}

/** The invoices in the agent's queue. They are examples: the supplier is an invented name and says so on the screen. */
export const INVOICES: InvoiceExample[] = [
  { id: 'i1188', title: 'Registra la fattura 1188, Ricambi Sud', vatProtocol: '2026/1188', supplier: 'RICAMBI SUD SRL', documentNumber: '004571203', documentDate: '28/10/2026', taxable: '1.842,00', vatCode: '22 · SPLIT PAYMENT', vat: '405,24', total: '2.247,24', costCentre: 'IMPIANTI IDROVORI', due: '28/11/2026' }, // allow-italian: fixture data, shown as written
  { id: 'i1189', title: 'Registra la fattura 1189, Forniture Tecniche', vatProtocol: '2026/1189', supplier: 'FORNITURE TECNICHE SRL', documentNumber: '000812/26', documentDate: '29/10/2026', taxable: '960,00', vatCode: '22 · SPLIT PAYMENT', vat: '211,20', total: '1.171,20', costCentre: 'MANUTENZIONE CANALI', due: '28/11/2026' }, // allow-italian: fixture data, shown as written
  { id: 'i1190', title: 'Registra la fattura 1190, Servizi Ambientali', vatProtocol: '2026/1190', supplier: 'SERVIZI AMBIENTALI SRL', documentNumber: '3318', documentDate: '30/10/2026', taxable: '2.450,00', vatCode: '22 · SPLIT PAYMENT', vat: '539,00', total: '2.989,00', costCentre: 'TAGLIO VEGETAZIONE', due: '29/11/2026' }, // allow-italian: fixture data, shown as written
];

/** The steps of the registration, and which fields of the mask each one fills. */
export const AGENT_STEPS: Array<{ id: string; label: string; short: string; fields: string[] }> = [
  { id: 's1', label: 'Apre la registrazione acquisti', short: 'Apre acquisti', fields: [] }, // allow-italian: fixture data, shown as written
  { id: 's2', label: 'Fornitore e documento', short: 'Fornitore', fields: ['supplier', 'vatProtocol', 'example', 'documentNumber', 'documentDate'] }, // allow-italian: fixture data, shown as written
  { id: 's3', label: 'Imponibile e imposta', short: 'Importi', fields: ['taxable', 'vat', 'total'] }, // allow-italian: fixture data, shown as written
  { id: 's4', label: 'Codice IVA split payment', short: 'IVA', fields: ['vatCode'] }, // allow-italian: fixture data, shown as written
  { id: 's5', label: 'Centro di costo e scadenza', short: 'Centro di costo', fields: ['costCentre', 'due'] }, // allow-italian: fixture data, shown as written
  { id: 's6', label: 'Registra e legge il numero', short: 'Registra', fields: [] }, // allow-italian: fixture data, shown as written
];

/** The labels of the accounting mask and the column each field sits in. */
export const AGENT_MASK_FIELDS: Array<{ id: string; label: string; column: 0 | 1 }> = [
  { id: 'supplier', label: 'Fornitore', column: 0 }, // allow-italian: fixture data, shown as written
  { id: 'vatProtocol', label: 'Protocollo IVA', column: 0 }, // allow-italian: fixture data, shown as written
  { id: 'documentNumber', label: 'Numero documento', column: 0 }, // allow-italian: fixture data, shown as written
  { id: 'taxable', label: 'Imponibile', column: 0 }, // allow-italian: fixture data, shown as written
  { id: 'vat', label: 'Imposta', column: 0 }, // allow-italian: fixture data, shown as written
  { id: 'costCentre', label: 'Centro di costo', column: 0 }, // allow-italian: fixture data, shown as written
  { id: 'vatNumber', label: 'Partita IVA', column: 1 }, // allow-italian: fixture data, shown as written
  { id: 'example', label: 'Esempio', column: 1 }, // allow-italian: fixture data, shown as written
  { id: 'documentDate', label: 'Data documento', column: 1 }, // allow-italian: fixture data, shown as written
  { id: 'vatCode', label: 'Codice IVA', column: 1 }, // allow-italian: fixture data, shown as written
  { id: 'total', label: 'Totale', column: 1 }, // allow-italian: fixture data, shown as written
  { id: 'due', label: 'Scadenza', column: 1 }, // allow-italian: fixture data, shown as written
];

export const AGENT_TASK = {
  pc: 'PC-RAGIONERIA-02',
  program: 'teamsystem' as ProgramId,
  description: 'Una pratica del flusso «Fattura passiva → pagamento», visto dato dal responsabile della ragioneria ieri alle 18:40. Fornitore di esempio.', // allow-italian: fixture data, shown as written
  windowTitle: 'Contabilità · Registrazione fattura di acquisto', // allow-italian: fixture data, shown as written
  menu: ['Anagrafiche', 'Contabilità generale', 'Registrazione acquisti', 'Registri IVA', 'Scadenzario'], // allow-italian: fixture data, shown as written
  menuHighlight: 2,
  exampleValue: 'fornitore di esempio', // allow-italian: fixture data, shown as written
  checks: [{ label: 'Totale uguale alla fattura SdI', ok: true }], // allow-italian: fixture data, shown as written
  queue: { label: 'Fatture da registrare', total: 14, avgTime: '1 min 10 s' }, // allow-italian: fixture data, shown as written
  buttons: ['Annulla', 'Registra'], // allow-italian: fixture data, shown as written
  taskbar: ['TeamSystem', 'Esplora file'], // allow-italian: fixture data, shown as written
  /** Minutes the already done steps took place before the demo's now, oldest first. */
  doneAgoMin: [3, 2, 1],
};

/* ---------- remote control: why, and on which PC ---------- */

export interface RemoteReason {
  id: string;
  pc: string;
  label: string;
  /** How the person at the PC reads it: «il robot di Halley». */
  consent: string;
  window: 'teamsystem' | 'halley' | 'qgis' | 'desktop';
}

export const REMOTE_REASONS: RemoteReason[] = [
  { id: 'halley-password', pc: 'PC-PROTOCOLLO-01', label: 'Cambiare la password del robot di Halley', consent: 'il robot di Halley', window: 'halley' }, // allow-italian: fixture data, shown as written
  { id: 'halley-check', pc: 'PC-PROTOCOLLO-01', label: 'Controllare la schermata di Halley', consent: 'la schermata di Halley', window: 'halley' }, // allow-italian: fixture data, shown as written
  { id: 'ts-agent', pc: 'PC-RAGIONERIA-02', label: 'Controllare l\'agente di TeamSystem', consent: 'l\'agente di TeamSystem', window: 'teamsystem' }, // allow-italian: fixture data, shown as written
  { id: 'qgis-agent', pc: 'PC-TECNICO-04', label: 'Controllare il collegamento con QGIS', consent: 'il collegamento con QGIS', window: 'qgis' }, // allow-italian: fixture data, shown as written
];

/** The Halley window of the remote session, and how long a session may last. */
export const REMOTE_MAX_MINUTES = 30;
export const HALLEY_ROBOT_USER = 'robot.protocollo';
