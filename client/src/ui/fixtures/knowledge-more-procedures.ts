/**
 * The procedures of «Procedure interne»: how the Consorzio works, step by
 * step, written by the AI from the closed example cases and the norms they
 * cite, then approved by a person (x04). Three wait for review (the ones
 * n13 lists), one is in test, three are approved. Every step says what it
 * rests on: an article of a norm, a case, or only the cases it was derived
 * from. Counts of cases are computed from `CASES`, never written here.
 */
import type { CaseKind, Office } from './org/types';

export type ProcedureStatus = 'da-rivedere' | 'in-collaudo' | 'approvata';

export interface ProcedureStepSeed {
  id: string;
  text: string;
  /** An article of a norm, `<item>/<article>`. */
  norm?: string;
  /** The step rests on the first case of this kind. */
  caseKind?: CaseKind;
  /** The step a person added to what the AI wrote. */
  added?: boolean;
}

export interface ProcedureSeed {
  id: string;
  title: string;
  status: ProcedureStatus;
  office: Office;
  /** The person-role who owns it: `Ruoli e riscossione`. */
  who: string;
  /** The time the procedure fixes, as an example: `entro 30 giorni`. (allow-italian: quotes the Italian interface) */
  timing: string;
  programs: string[];
  /** The kind of case it was derived from. */
  caseKind: CaseKind;
  /** The id of the flow that uses it, empty when none does yet. */
  flow: string;
  /** Norms it is based on, `<item>/<article>`, or a label when no article is linked yet. */
  base: Array<{ norm?: string; label: string }>;
  steps: ProcedureStepSeed[];
  mistakes: string;
  /** Who reviews it. */
  reviewer: string;
  /** YYYY-MM-DD, when the AI wrote it. */
  writtenAt: string;
  /** Closed cases it was derived from when it is in test: fixed and not computed. */
  fixedCases?: number;
  comments: Array<{ who: string; text: string; at: string }>;
  /** Mail and notes read besides the cases. */
  alsoRead?: string;
  /** Roles that may approve it as the procedure of their office. */
  approver: string;
}

export const PROCEDURES: ProcedureSeed[] = [
  {
    id: 'concessione-attraversamento',
    title: "Concessione di attraversamento di un canale consortile", // allow-italian: fixture data, shown as written
    status: 'da-rivedere',
    office: 'tecnico',
    who: 'Tecnico', // allow-italian: fixture data, shown as written
    timing: 'entro 30 giorni dall\'istanza (esempio)', // allow-italian: fixture data, shown as written
    programs: ['Halley', 'QGIS'],
    caseKind: 'concessione',
    flow: 'concessioni',
    reviewer: 'Responsabile tecnico', // allow-italian: fixture data, shown as written
    approver: 'Direzione', // allow-italian: fixture data, shown as written
    writtenAt: '2026-11-04',
    base: [
      { norm: 'rd-368/a134', label: 'R.D. 368/1904, art. 134' },
      { norm: 'rd-523/a93', label: 'R.D. 523/1904, art. 93' },
    ],
    steps: [
      { id: 's1', text: 'Registrare la richiesta in protocollo e collegarla alla particella e al canale interessato', caseKind: 'concessione' }, // allow-italian: fixture data, shown as written
      { id: 's2', text: 'Verificare gli allegati: elaborato grafico dell\'attraversamento e dati catastali del richiedente' }, // allow-italian: fixture data, shown as written
      { id: 's3', text: 'Parere dell\'ufficio tecnico sul tratto: distanze dalle sponde, sezione idraulica, tipo di attraversamento', norm: 'rd-368/a134' }, // allow-italian: fixture data, shown as written
      { id: 's4', text: 'Se il corso d\'acqua è nel reticolo regionale, applicare anche la disciplina delle opere in alveo', norm: 'rd-523/a93' }, // allow-italian: fixture data, shown as written
      { id: 's5', text: 'Atto di concessione firmato dal responsabile del servizio, con le prescrizioni del parere' }, // allow-italian: fixture data, shown as written
      { id: 's6', text: 'Comunicare l\'esito al richiedente via PEC e annotare il protocollo di uscita in Halley' }, // allow-italian: fixture data, shown as written
    ],
    mistakes: 'Rispondere senza il parere dell\'ufficio tecnico · dimenticare che un tratto nel reticolo regionale segue anche il R.D. 523/1904 · non collegare la concessione alla particella, così la prossima richiesta sullo stesso canale non la trova.', // allow-italian: fixture data, shown as written
    comments: [],
    alsoRead: 'richieste di attraversamento e scarico dello stesso anno', // allow-italian: fixture data, shown as written
  },
  {
    id: 'costituzione-in-giudizio',
    title: 'Costituzione in giudizio contro un ricorso tributario', // allow-italian: fixture data, shown as written
    status: 'da-rivedere',
    office: 'legale',
    who: 'Legale', // allow-italian: fixture data, shown as written
    timing: '60 giorni dalla notifica del ricorso', // allow-italian: fixture data, shown as written
    programs: ['PA Legal', 'PEC Aruba'],
    caseKind: 'ricorso',
    flow: 'pec',
    reviewer: 'Avvocato interno', // allow-italian: fixture data, shown as written
    approver: 'Direzione', // allow-italian: fixture data, shown as written
    writtenAt: '2026-11-03',
    base: [
      { norm: 'dlgs-546-1992/a23c1', label: 'D.Lgs. 546/1992, art. 23' },
      { norm: 'piano-classifica-1996/riparto', label: 'Piano di Classifica 1996' }, // allow-italian: fixture data, shown as written
    ],
    steps: [
      { id: 's1', text: 'Registrare il ricorso e calcolare il termine: 60 giorni dalla consegna della PEC, spostato al primo giorno lavorativo se cade di sabato, domenica o festivo', norm: 'dlgs-546-1992/a23c1', caseKind: 'ricorso' }, // allow-italian: fixture data, shown as written
      { id: 's2', text: 'Chiedere a Catasto e ruoli l\'avviso di contributo e la prova della sua notifica' }, // allow-italian: fixture data, shown as written
      { id: 's3', text: 'Controllare che la classifica dell\'immobile e il riparto dell\'avviso siano quelli del Piano di Classifica', norm: 'piano-classifica-1996/riparto' }, // allow-italian: fixture data, shown as written
      { id: 's4', text: 'Scrivere le controdeduzioni: posizione sui motivi, prove, eccezioni e conclusioni', norm: 'dlgs-546-1992/a23c2' }, // allow-italian: fixture data, shown as written
      { id: 's5', text: 'Autorizzazione a costituirsi firmata dal responsabile e firma del legale' }, // allow-italian: fixture data, shown as written
      { id: 's6', text: 'Deposito telematico delle controdeduzioni con il fascicolo; conservare la ricevuta' }, // allow-italian: fixture data, shown as written
      { id: 's7', text: 'Annotare scadenza e deposito in PA Legal' }, // allow-italian: fixture data, shown as written
    ],
    mistakes: 'Contare i 60 giorni da una data diversa dalla consegna della PEC · depositare dopo la scadenza · dimenticare di prendere posizione su uno dei motivi del ricorso.', // allow-italian: fixture data, shown as written
    comments: [],
    alsoRead: 'le controdeduzioni dei ricorsi già depositati', // allow-italian: fixture data, shown as written
  },
  {
    id: 'turno-irriguo-emergenza',
    title: "Turno irriguo d'emergenza", // allow-italian: fixture data, shown as written
    status: 'da-rivedere',
    office: 'irrigazione',
    who: 'Irrigazione', // allow-italian: fixture data, shown as written
    timing: 'entro il giorno dopo (esempio)', // allow-italian: fixture data, shown as written
    programs: ['Telecontrollo', 'Halley'],
    caseKind: 'irrigazione',
    flow: 'irrigua',
    reviewer: 'Responsabile irrigazione', // allow-italian: fixture data, shown as written
    approver: 'Direzione', // allow-italian: fixture data, shown as written
    writtenAt: '2026-11-05',
    base: [
      { norm: 'piano-classifica-1996/irrigazione', label: 'Piano di Classifica 1996' }, // allow-italian: fixture data, shown as written
      { norm: 'libro-anno-2025/irrigazione', label: "Libro dell'anno 2025" }, // allow-italian: fixture data, shown as written
    ],
    steps: [
      { id: 's1', text: 'Registrare la richiesta con il bacino di irrigazione, gli ettari e la coltura', caseKind: 'irrigazione' }, // allow-italian: fixture data, shown as written
      { id: 's2', text: 'Verificare che l\'utenza sia in uno dei sette bacini di irrigazione collettiva', norm: 'piano-classifica-1996/irrigazione' }, // allow-italian: fixture data, shown as written
      { id: 's3', text: 'Guardare nel telecontrollo il livello delle vasche di accumulo e i pozzi disponibili', norm: 'libro-anno-2025/irrigazione' }, // allow-italian: fixture data, shown as written
      { id: 's4', text: 'Assegnare giorno e ora del turno e avvisare il personale di zona' }, // allow-italian: fixture data, shown as written
      { id: 's5', text: 'Confermare il turno al richiedente' }, // allow-italian: fixture data, shown as written
      { id: 's6', text: 'Registrare a fine turno la durata, per la contabilità dell\'acqua' }, // allow-italian: fixture data, shown as written
    ],
    mistakes: 'Assegnare un turno senza guardare le vasche · confermare al richiedente prima di avvisare il personale di zona.', // allow-italian: fixture data, shown as written
    comments: [],
  },
  {
    id: 'rimborso-contributo-doppio',
    title: 'Rimborso di un contributo pagato due volte', // allow-italian: fixture data, shown as written
    status: 'in-collaudo',
    office: 'catasto',
    who: 'Ruoli e riscossione', // allow-italian: fixture data, shown as written
    timing: 'entro 30 giorni', // allow-italian: fixture data, shown as written
    programs: ['Prunes', 'TeamSystem'],
    caseKind: 'sgravio',
    flow: '',
    reviewer: 'Responsabile ruoli e riscossione', // allow-italian: fixture data, shown as written
    approver: 'Direzione', // allow-italian: fixture data, shown as written
    writtenAt: '2026-10-29',
    fixedCases: 12,
    alsoRead: '2 mail dell\'ufficio di settembre', // allow-italian: fixture data, shown as written
    base: [{ label: 'Regolamento di riscossione, articolo da collegare' }], // allow-italian: fixture data, shown as written
    steps: [
      { id: 's1', text: 'Verificare in Prunes i due pagamenti sullo stesso avviso', caseKind: 'sgravio' }, // allow-italian: fixture data, shown as written
      { id: 's2', text: "Chiedere l'IBAN al contribuente se non è già in anagrafica" }, // allow-italian: fixture data, shown as written
      { id: 's3', text: 'Determina di rimborso firmata dal responsabile del servizio', added: true }, // allow-italian: fixture data, shown as written
      { id: 's4', text: 'Mandato di pagamento in TeamSystem' }, // allow-italian: fixture data, shown as written
      { id: 's5', text: "Annotare il rimborso sull'avviso in Prunes" }, // allow-italian: fixture data, shown as written
    ],
    mistakes: "Rimborsare senza controllare che il secondo pagamento non copra un altro anno · dimenticare l'annotazione in Prunes, che fa ripartire il sollecito.", // allow-italian: fixture data, shown as written
    comments: [{ who: 'RU', text: "il passo 3 mancava, l'ho aggiunto io: senza determina la Ragioneria non paga.", at: '2026-11-02' }], // allow-italian: fixture data, shown as written
  },
  {
    id: 'verbale-polizia-idraulica',
    title: 'Verbale di polizia idraulica', // allow-italian: fixture data, shown as written
    status: 'approvata',
    office: 'tecnico',
    who: 'Tecnico', // allow-italian: fixture data, shown as written
    timing: 'subito dopo il sopralluogo (esempio)', // allow-italian: fixture data, shown as written
    programs: ['Halley', 'QGIS'],
    caseKind: 'verbale',
    flow: '',
    reviewer: 'Responsabile tecnico', // allow-italian: fixture data, shown as written
    approver: 'Direzione', // allow-italian: fixture data, shown as written
    writtenAt: '2026-09-18',
    base: [
      { norm: 'lr-7-2025/a10c2', label: 'L.R. 7/2025, art. 10, comma 2' },
      { norm: 'rd-368/a133', label: 'R.D. 368/1904, art. 133' },
      { norm: 'lr-13-1983/sanzioni', label: 'L.R. 13/1983' },
    ],
    steps: [
      { id: 's1', text: 'Il sorvegliante o l\'ufficiale idraulico accerta la violazione sul posto e la localizza sulla mappa', norm: 'libro-anno-2025/p447', caseKind: 'verbale' }, // allow-italian: fixture data, shown as written
      { id: 's2', text: 'Indicare la norma violata: R.D. 368/1904 per le opere di bonifica, R.D. 523/1904 per il reticolo regionale', norm: 'rd-368/a133' }, // allow-italian: fixture data, shown as written
      { id: 's3', text: 'Redigere il verbale e contestarlo: il Consorzio lo fa da solo, come Autorità di Polizia Idraulica, senza aspettare la Regione', norm: 'lr-7-2025/a10c2' }, // allow-italian: fixture data, shown as written
      { id: 's4', text: 'Applicare la sanzione amministrativa pecuniaria secondo la L.R. 13/1983', norm: 'lr-13-1983/sanzioni' }, // allow-italian: fixture data, shown as written
      { id: 's5', text: 'Passare alla Ragioneria la destinazione dei proventi: gestione e manutenzione delle opere vigilate', norm: 'lr-7-2025/a10c2' }, // allow-italian: fixture data, shown as written
    ],
    mistakes: 'Citare una sola norma quando il tratto è nel reticolo regionale · mandare il verbale alla Regione invece di contestarlo.', // allow-italian: fixture data, shown as written
    comments: [{ who: 'TEC', text: 'ok, è come lavoriamo.', at: '2026-09-18' }], // allow-italian: fixture data, shown as written
  },
  {
    id: 'accesso-agli-atti',
    title: 'Accesso agli atti e accesso civico', // allow-italian: fixture data, shown as written
    status: 'approvata',
    office: 'protocollo',
    who: 'Protocollo', // allow-italian: fixture data, shown as written
    timing: '30 giorni dall\'istanza', // allow-italian: fixture data, shown as written
    programs: ['Halley', 'PEC Aruba'],
    caseKind: 'accesso',
    flow: 'accesso',
    reviewer: 'Responsabile del protocollo', // allow-italian: fixture data, shown as written
    approver: 'Direzione', // allow-italian: fixture data, shown as written
    writtenAt: '2026-09-22',
    base: [
      { norm: 'dlgs-33-2013/a5c6', label: 'D.Lgs. 33/2013, art. 5' },
      { norm: 'l-241-1990/a2c1', label: 'L. 241/1990, art. 2' },
    ],
    steps: [
      { id: 's1', text: 'Protocollare l\'istanza e distinguere l\'accesso civico semplice dal generalizzato', norm: 'dlgs-33-2013/a5c2', caseKind: 'accesso' }, // allow-italian: fixture data, shown as written
      { id: 's2', text: 'Informare gli eventuali controinteressati' }, // allow-italian: fixture data, shown as written
      { id: 's3', text: 'Rispondere con provvedimento espresso e motivato entro trenta giorni dalla presentazione', norm: 'dlgs-33-2013/a5c6' }, // allow-italian: fixture data, shown as written
      { id: 's4', text: 'Chiudere il procedimento con un provvedimento espresso anche quando si nega l\'accesso', norm: 'l-241-1990/a2c1' }, // allow-italian: fixture data, shown as written
    ],
    mistakes: 'Lasciar scadere i trenta giorni senza rispondere · rispondere senza motivare.', // allow-italian: fixture data, shown as written
    comments: [],
  },
  {
    id: 'pagamento-fattura-passiva',
    title: 'Pagamento di una fattura passiva', // allow-italian: fixture data, shown as written
    status: 'approvata',
    office: 'ragioneria',
    who: 'Ragioneria', // allow-italian: fixture data, shown as written
    timing: '30 giorni dalla ricezione', // allow-italian: fixture data, shown as written
    programs: ['TeamSystem'],
    caseKind: 'fattura',
    flow: 'fatture',
    reviewer: 'Responsabile della ragioneria', // allow-italian: fixture data, shown as written
    approver: 'Direzione', // allow-italian: fixture data, shown as written
    writtenAt: '2026-09-25',
    base: [{ norm: 'dlgs-231-2002/a4c2', label: 'D.Lgs. 231/2002, art. 4' }],
    steps: [
      { id: 's1', text: 'Registrare la fattura ricevuta dal Sistema di Interscambio e la data di ricevimento', caseKind: 'fattura' }, // allow-italian: fixture data, shown as written
      { id: 's2', text: 'Controllare che ordine, importo e fornitore corrispondano', }, // allow-italian: fixture data, shown as written
      { id: 's3', text: 'Calcolare la scadenza: trenta giorni dalla data di ricevimento della fattura', norm: 'dlgs-231-2002/a4c2' }, // allow-italian: fixture data, shown as written
      { id: 's4', text: 'Mandato di pagamento in TeamSystem entro la scadenza' }, // allow-italian: fixture data, shown as written
    ],
    mistakes: 'Contare i trenta giorni dalla data della fattura invece che dalla sua ricezione.', // allow-italian: fixture data, shown as written
    comments: [],
  },
];
