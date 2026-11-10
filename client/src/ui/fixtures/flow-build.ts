/**
 * Fixtures of the flow-building area: who owns each flow and when it last
 * changed (n01), the templates of a sector and the suggestions (n02), the
 * conversation that builds a flow (n03) and the interview that captures what
 * a person knows (o02). Everything about the organizations is from
 * `DATI-VERI.md`; people are roles, volumes and times are examples.
 */
import type { FlowSeed, FlowStepSeed, Office } from './org/types';

export interface FlowFacts {
  /** The role that answers for the flow, as the list shows it. */
  owner: string;
  monogram: string;
  color: string;
  /** YYYY-MM-DD of the last change. */
  modified: string;
  /** Errors in the last 30 days, the same the overview prints. */
  errors: number;
}

export const FLOW_FACTS: Record<string, FlowFacts> = {
  pec: { owner: 'Resp. protocollo', monogram: 'RP', color: '#15803d', modified: '2026-11-05', errors: 1 }, // allow-italian: fixture data, shown as written
  fatture: { owner: 'Resp. ragioneria', monogram: 'RR', color: '#7c3aed', modified: '2026-11-03', errors: 2 }, // allow-italian: fixture data, shown as written
  irrigua: { owner: 'Tecnico', monogram: 'TEC', color: '#c2410c', modified: '2026-10-28', errors: 0 }, // allow-italian: fixture data, shown as written
  personale: { owner: 'Resp. personale', monogram: 'RPE', color: '#0f766e', modified: '2026-10-20', errors: 0 }, // allow-italian: fixture data, shown as written
  gara: { owner: 'Avv. interno', monogram: 'AVV', color: '#b91c1c', modified: '2026-10-15', errors: 0 }, // allow-italian: fixture data, shown as written
  segnalazioni: { owner: 'Resp. manutenzione', monogram: 'RM', color: '#0369a1', modified: '2026-10-30', errors: 1 }, // allow-italian: fixture data, shown as written
  concessioni: { owner: 'Tecnico', monogram: 'TEC', color: '#c2410c', modified: '2026-11-04', errors: 0 }, // allow-italian: fixture data, shown as written
  accesso: { owner: 'Resp. protocollo', monogram: 'RP', color: '#15803d', modified: '2026-11-06', errors: 0 }, // allow-italian: fixture data, shown as written
  'orbit-segnalazioni': { owner: 'Call center', monogram: 'CC', color: '#b45309', modified: '2026-11-02', errors: 3 }, // allow-italian: fixture data, shown as written
  'orbit-fatture': { owner: 'Amministrazione', monogram: 'AM', color: '#4d7c0f', modified: '2026-10-27', errors: 1 }, // allow-italian: fixture data, shown as written
};

/** The owner a flow made in the preview gets: the role of its office. */
export const OFFICE_OWNER: Partial<Record<Office, Pick<FlowFacts, 'owner' | 'monogram' | 'color'>>> = {
  protocollo: { owner: 'Resp. protocollo', monogram: 'RP', color: '#15803d' }, // allow-italian: fixture data, shown as written
  legale: { owner: 'Avv. interno', monogram: 'AVV', color: '#b91c1c' }, // allow-italian: fixture data, shown as written
  catasto: { owner: 'Resp. catasto', monogram: 'RC', color: '#92400e' }, // allow-italian: fixture data, shown as written
  tecnico: { owner: 'Tecnico', monogram: 'TEC', color: '#c2410c' }, // allow-italian: fixture data, shown as written
  manutenzione: { owner: 'Resp. manutenzione', monogram: 'RM', color: '#0369a1' }, // allow-italian: fixture data, shown as written
  ragioneria: { owner: 'Resp. ragioneria', monogram: 'RR', color: '#7c3aed' }, // allow-italian: fixture data, shown as written
  segreteria: { owner: 'Segreteria', monogram: 'SEG', color: '#475569' }, // allow-italian: fixture data, shown as written
  irrigazione: { owner: 'Tecnico irrigazione', monogram: 'TI', color: '#0e7490' }, // allow-italian: fixture data, shown as written
  direzione: { owner: 'Direzione', monogram: 'DIR', color: '#0f766e' }, // allow-italian: fixture data, shown as written
  amministrazione: { owner: 'Resp. personale', monogram: 'RPE', color: '#0f766e' }, // allow-italian: fixture data, shown as written
};

/* ---------- n02: sectors and templates ---------- */

export interface SectorModel {
  id: string;
  name: string;
}

export const SECTORS: SectorModel[] = [
  { id: 'bonifica', name: 'Consorzi di bonifica' }, // allow-italian: fixture data, shown as written
  { id: 'ambiente', name: 'Servizi ambientali' }, // allow-italian: fixture data, shown as written
];

/** A flow a sector package offers: the description a card shows, and the flow it makes. */
export interface TemplateModel {
  id: string;
  sector: string;
  /** The flow of the preview this template already is, when the organization has it. */
  existing?: string;
  description: string;
  seed: Pick<FlowSeed, 'name' | 'trigger' | 'office' | 'steps'>;
}

const seedOf = (name: string, trigger: string, office: Office, steps: FlowStepSeed[]) => ({ name, trigger, office, steps });

export const TEMPLATES: TemplateModel[] = [
  {
    id: 'tpl-pec', sector: 'bonifica', existing: 'pec', // allow-italian: fixture data, shown as written
    description: "Legge, classifica, protocolla in Halley e assegna all'ufficio.", // allow-italian: fixture data, shown as written
    seed: seedOf('PEC in arrivo → protocollo', 'arriva una PEC sulla casella protocollo@', 'protocollo', []), // allow-italian: fixture data, shown as written
  },
  {
    id: 'tpl-fatture', sector: 'bonifica', existing: 'fatture', // allow-italian: fixture data, shown as written
    description: 'Controllo IVA e split payment, visto, registrazione in TeamSystem.', // allow-italian: fixture data, shown as written
    seed: seedOf('Fattura passiva → pagamento', 'arriva una fattura dallo SdI', 'ragioneria', []), // allow-italian: fixture data, shown as written
  },
  {
    id: 'tpl-irrigua', sector: 'bonifica', existing: 'irrigua', // allow-italian: fixture data, shown as written
    description: "Dal modulo del sito al turno del bacino, con avviso all'utente.", // allow-italian: fixture data, shown as written
    seed: seedOf('Richiesta irrigua → turno', 'arriva una richiesta dal modulo sul sito', 'irrigazione', []), // allow-italian: fixture data, shown as written
  },
  {
    id: 'tpl-accesso', sector: 'bonifica', existing: 'accesso', // allow-italian: fixture data, shown as written
    description: 'Scadenza dei 30 giorni, controinteressati, bozza di risposta.', // allow-italian: fixture data, shown as written
    seed: seedOf('Accesso agli atti', 'arriva una PEC con «accesso»', 'protocollo', []), // allow-italian: fixture data, shown as written
  },
  {
    id: 'tpl-gara', sector: 'bonifica', existing: 'gara', // allow-italian: fixture data, shown as written
    description: 'Legge il capitolato, prepara la determina, controlla CIG e requisiti.', // allow-italian: fixture data, shown as written
    seed: seedOf('Gara → determina', 'a mano, dalla chat', 'legale', []), // allow-italian: fixture data, shown as written
  },
  {
    id: 'tpl-personale', sector: 'bonifica', existing: 'personale', // allow-italian: fixture data, shown as written
    description: 'Contratti a termine, visite, certificati: avviso 30 giorni prima.', // allow-italian: fixture data, shown as written
    seed: seedOf('Scadenzario personale', 'ogni giorno alle 7', 'amministrazione', []), // allow-italian: fixture data, shown as written
  },
  {
    id: 'tpl-segnalazioni', sector: 'bonifica', existing: 'segnalazioni', // allow-italian: fixture data, shown as written
    description: "Dalla segnalazione di allagamento o ostruzione alla squadra sul canale, con avviso a chi ha segnalato.", // allow-italian: fixture data, shown as written
    seed: seedOf('Segnalazione dal territorio → intervento', 'arriva una segnalazione', 'manutenzione', []), // allow-italian: fixture data, shown as written
  },
  {
    id: 'tpl-concessioni', sector: 'bonifica', existing: 'concessioni', // allow-italian: fixture data, shown as written
    description: 'Dalla richiesta di attraversamento o scarico al provvedimento, con la procedura di Conoscenza.', // allow-italian: fixture data, shown as written
    seed: seedOf('Concessione o autorizzazione idraulica', 'arriva una richiesta di attraversamento o scarico', 'tecnico', []), // allow-italian: fixture data, shown as written
  },
  {
    id: 'tpl-certificato', sector: 'bonifica', // allow-italian: fixture data, shown as written
    description: 'Una richiesta via PEC, sempre la stessa risposta con i dati da Prunes.', // allow-italian: fixture data, shown as written
    seed: seedOf('Certificato di contribuenza', 'arriva una richiesta di certificato via PEC', 'catasto', [ // allow-italian: fixture data, shown as written
      { id: 's1', label: 'Riconosce la richiesta e il contribuente', kind: 'classify', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Legge la posizione del contribuente', kind: 'robot', program: 'Prunes', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: 'Prepara il certificato con i dati di Prunes', kind: 'ai', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'Il responsabile controlla e firma', kind: 'person', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 's5', label: 'Invia il certificato via PEC', kind: 'send', office: 'protocollo' }, // allow-italian: fixture data, shown as written
    ]),
  },
  {
    id: 'tpl-verbale', sector: 'bonifica', existing: 'verbale', // allow-italian: fixture data, shown as written
    description: 'Con la L.R. 7/2025, art. 10 c.2, il consorzio contesta e sanziona da sé (L.R. 13/1983): dal verbale alla sanzione.', // allow-italian: fixture data, shown as written
    seed: seedOf('Verbale di polizia idraulica', "arriva il verbale dell'ufficiale idraulico", 'tecnico', [ // allow-italian: fixture data, shown as written
      { id: 's1', label: 'Legge il verbale e il tipo di violazione', kind: 'ai', office: 'tecnico' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Trova il responsabile e la particella', kind: 'robot', program: 'Prunes', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: 'Calcola la sanzione secondo la L.R. 13/1983', kind: 'rule', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: "L'ufficiale idraulico conferma", kind: 'person', office: 'tecnico' }, // allow-italian: fixture data, shown as written
      { id: 's5', label: 'Prepara la contestazione', kind: 'ai', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 's6', label: 'Protocolla la contestazione', kind: 'robot', program: 'Halley', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 's7', label: 'Notifica al trasgressore', kind: 'send', office: 'protocollo' }, // allow-italian: fixture data, shown as written
    ]),
  },
  {
    id: 'tpl-send', sector: 'bonifica', // allow-italian: fixture data, shown as written
    description: 'Con SEND le notifiche hanno valore legale (adozione di maggio 2026): dal provvedimento alla notifica e alla ricevuta.', // allow-italian: fixture data, shown as written
    seed: seedOf('Notifica via SEND', 'un provvedimento è firmato e va notificato', 'protocollo', [ // allow-italian: fixture data, shown as written
      { id: 's1', label: 'Legge il provvedimento e il destinatario', kind: 'ai', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Controlla che i dati del destinatario siano completi', kind: 'rule', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: "Un operatore controlla e conferma l'invio", kind: 'person', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'Invia la notifica a SEND', kind: 'send', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 's5', label: 'Protocolla la ricevuta di notifica', kind: 'robot', program: 'Halley', office: 'protocollo' }, // allow-italian: fixture data, shown as written
    ]),
  },
  {
    id: 'tpl-ambiente-seg', sector: 'ambiente', existing: 'orbit-segnalazioni', // allow-italian: fixture data, shown as written
    description: 'Mail AMA, portale utenze e telefonate in un solo flusso, fino al turno e al rendiconto.', // allow-italian: fixture data, shown as written
    seed: seedOf('Segnalazioni AMA e utenze → intervento', 'arriva una segnalazione', 'call-center', []), // allow-italian: fixture data, shown as written
  },
  {
    id: 'tpl-ambiente-fatture', sector: 'ambiente', existing: 'orbit-fatture', // allow-italian: fixture data, shown as written
    description: 'Controllo con ordine, registrazione in SAP, riconciliazione.', // allow-italian: fixture data, shown as written
    seed: seedOf('Fattura passiva → riconciliazione', 'arriva una fattura dal fornitore', 'amministrazione', []), // allow-italian: fixture data, shown as written
  },
  {
    id: 'tpl-ambiente-fir', sector: 'ambiente', existing: 'orbit-fir', // allow-italian: fixture data, shown as written
    description: 'Dal ritiro al formulario FIR e alla registrazione RENTRI.', // allow-italian: fixture data, shown as written
    seed: seedOf('Formulario FIR e RENTRI', 'si chiude un ritiro', 'servizi', [ // allow-italian: fixture data, shown as written
      { id: 's1', label: 'Legge il ritiro e il tipo di rifiuto', kind: 'ai', office: 'servizi' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Prepara il formulario FIR', kind: 'ai', office: 'servizi' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: "Un operatore controlla e firma", kind: 'person', office: 'servizi' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'Registra su RENTRI', kind: 'rule', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
    ]),
  },
  {
    id: 'tpl-ambiente-foglie', sector: 'ambiente', // allow-italian: fixture data, shown as written
    description: 'Il servizio foglie dal cantiere al rendiconto mensile ad AMA.', // allow-italian: fixture data, shown as written
    seed: seedOf('Rendicontazione servizio foglie', 'ogni fine mese', 'servizi', [ // allow-italian: fixture data, shown as written
      { id: 's1', label: 'Raccoglie i fogli dei cantieri del mese', kind: 'rule', office: 'servizi' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Somma i passaggi per zona', kind: 'rule', office: 'servizi' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: 'Un responsabile controlla i totali', kind: 'person', office: 'servizi' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'Invia il rendiconto ad AMA', kind: 'send', office: 'servizi' }, // allow-italian: fixture data, shown as written
    ]),
  },
  {
    id: 'tpl-ambiente-turni', sector: 'ambiente', // allow-italian: fixture data, shown as written
    description: 'Scadenze dei tempi determinati e turni del personale, con avviso prima.', // allow-italian: fixture data, shown as written
    seed: seedOf('Scadenze e turni del personale', 'ogni giorno alle 7', 'amministrazione', [ // allow-italian: fixture data, shown as written
      { id: 's1', label: 'Legge i contratti a tempo determinato', kind: 'rule', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Trova quelli che scadono entro 30 giorni', kind: 'rule', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: 'Avvisa il responsabile', kind: 'send', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
    ]),
  },
];

export interface SuggestionModel {
  id: string;
  title: string;
  body: string;
  /** The template it starts from. */
  template: string;
}

/** n01: flows suggested by what the organization does by hand. */
export const SUGGESTIONS: SuggestionModel[] = [
  { id: 'sg-certificato', title: 'Certificato di contribuenza', body: '31 richieste via PEC, sempre la stessa risposta con i dati da Prunes. Stima: 6 ore al mese.', template: 'tpl-certificato' }, // allow-italian: fixture data, shown as written
  { id: 'sg-send', title: 'Notifica via SEND', body: 'Dal 05/2026 le notifiche a valore legale passano da SEND: oggi si preparano a mano, ogni volta con gli stessi controlli.', template: 'tpl-send' }, // allow-italian: fixture data, shown as written
];

/** What a free description starts from: three generic steps. */
export const BLANK_STEPS: FlowStepSeed[] = [
  { id: 's1', label: 'Legge e capisce il documento', kind: 'ai' }, // allow-italian: fixture data, shown as written
  { id: 's2', label: 'Una persona controlla e conferma', kind: 'person' }, // allow-italian: fixture data, shown as written
  { id: 's3', label: 'Chiude e avvisa chi ha chiesto', kind: 'send' }, // allow-italian: fixture data, shown as written
];

/* ---------- n03: the flow built from a chat ---------- */

export type BuildKind = FlowStepSeed['kind'] | 'trigger' | 'action';

export interface ChatDraftStep {
  id: string;
  kind: BuildKind;
  program?: string;
  office?: Office;
  label: string;
  detail?: string;
  /** The question whose answer settles this step. */
  question?: string;
}

export interface ChatOption {
  id: string;
  label: string;
  recommended?: boolean;
}

export interface ChatQuestion {
  id: string;
  title: string;
  options: ChatOption[];
}

export const INVOICE_CHAT = {
  flowName: 'Fattura passiva → pagamento', // allow-italian: fixture data, shown as written
  flowTrigger: 'arriva una fattura dallo SdI', // allow-italian: fixture data, shown as written
  flowOffice: 'ragioneria' as Office,
  userText: "Quando arriva una fattura passiva la ragioneria controlla importi e IVA, il dirigente del servizio dà il visto, poi si registra in TeamSystem e si paga a 30 giorni. Se c'è split payment lo segniamo a mano.", // allow-italian: fixture data, shown as written
  intro: 'Ho preparato la bozza a destra: 8 passi, e lo split payment diventa una regola fissa invece di una cosa da ricordare.', // allow-italian: fixture data, shown as written
  needTwo: 'Mi servono due risposte per finirla:', // allow-italian: fixture data, shown as written
  sources: "Ho preso dalla Conoscenza il regolamento di contabilità (la regola del visto, da verificare con la Ragioneria) e dai Dati l'elenco fornitori.", // allow-italian: fixture data, shown as written
  questions: [
    {
      id: 'visto', title: 'Chi dà il visto sopra i 5.000 €?', // allow-italian: fixture data, shown as written
      options: [
        { id: 'direttore', label: 'Il direttore', recommended: true }, // allow-italian: fixture data, shown as written
        { id: 'dirigente', label: 'Il dirigente del servizio' }, // allow-italian: fixture data, shown as written
        { id: 'entrambi', label: 'Entrambi' }, // allow-italian: fixture data, shown as written
      ],
    },
    {
      id: 'registra', title: 'La registrazione in TeamSystem chi la fa?', // allow-italian: fixture data, shown as written
      options: [
        { id: 'robot', label: 'Il robot, poi controllo a campione', recommended: true }, // allow-italian: fixture data, shown as written
        { id: 'persona', label: 'Una persona' }, // allow-italian: fixture data, shown as written
      ],
    },
  ] as ChatQuestion[],
  draft: [
    { id: 't', kind: 'trigger', label: 'Fattura dallo SdI', detail: "Arriva nel cassetto fiscale dell'organizzazione" }, // allow-italian: fixture data, shown as written
    { id: 's1', kind: 'ai', label: 'Legge righe, importi, IVA', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
    { id: 's2', kind: 'rule', label: 'Controllo IVA e split payment', detail: 'Confronto con ordine e fornitore', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
    { id: 's3', kind: 'person', label: 'Ragioneria verifica', detail: 'se la differenza non torna', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
    { id: 's4', kind: 'person', label: 'Visto del dirigente', detail: 'Sopra 5.000 €: chi?', office: 'direzione', question: 'visto' }, // allow-italian: fixture data, shown as written
    { id: 's5', kind: 'robot', program: 'TeamSystem', label: 'Registra in TeamSystem', office: 'ragioneria', question: 'registra' }, // allow-italian: fixture data, shown as written
    { id: 's6', kind: 'rule', label: 'Scadenza a 30 giorni in Dati', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
    { id: 's7', kind: 'action', label: 'Card in Board al pagamento', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
  ] as ChatDraftStep[],
  /** The step label each answer gives. */
  answerLabel: {
    visto: {
      direttore: { label: 'Visto del direttore', office: 'direzione' as Office }, // allow-italian: fixture data, shown as written
      dirigente: { label: 'Visto del dirigente del servizio', office: 'amministrazione' as Office }, // allow-italian: fixture data, shown as written
      entrambi: { label: 'Visto del direttore e del dirigente del servizio', office: 'direzione' as Office }, // allow-italian: fixture data, shown as written
    },
    registra: {
      robot: { label: 'Registra in TeamSystem, poi controllo a campione', kind: 'robot' as const }, // allow-italian: fixture data, shown as written
      persona: { label: 'Una persona registra in TeamSystem', kind: 'person' as const }, // allow-italian: fixture data, shown as written
    },
  },
  reply: {
    answered: (step: string) => `Ok, ho aggiornato il passo «${step}» a destra.`, // allow-italian: fixture data, shown as written
    complete: 'Ho tutto quello che serve: puoi creare il flusso. Resta una bozza finché non lo collaudi.', // allow-italian: fixture data, shown as written
    threshold: (amount: string) => `Ho capito: sotto ${amount} € il visto non serve. L'ho scritto come regola sul passo del visto e lo vedi a destra.`, // allow-italian: fixture data, shown as written
    vistoNote: (amount: string) => `Sotto ${amount} € il visto non serve`, // allow-italian: fixture data, shown as written
    generic: (quote: string) => `Ho preso nota di «${quote}» e l'ho aggiunta come annotazione alla bozza. Se vuoi un passo nuovo, dimmi dopo quale.`, // allow-italian: fixture data, shown as written
  },
};

/* ---------- o02: an interview that captures what one person knows ---------- */

export interface InterviewTurn {
  role: 'assistant' | 'person';
  text: string;
}

export interface KnowledgeFact {
  id: string;
  title: string;
  who: string;
  often: string;
  programs: string;
  data: Array<{ kind: 'record' | 'number' | 'calendar' | 'file'; name: string }>;
  exception: string;
  /** What is missing: the document the rule is written in, still to find. */
  missing: string;
}

export const INTERVIEW = {
  personRole: 'Responsabile del catasto e dei ruoli', // allow-italian: fixture data, shown as written
  office: 'catasto' as Office,
  duration: '14 min',
  turns: [
    { role: 'assistant', text: 'Cosa fa ogni anno che nessun altro in ufficio sa fare?' }, // allow-italian: fixture data, shown as written
    { role: 'person', text: "La bonifica dei ruoli prima dell'emissione: controllo a mano le particelle frazionate, perché in Prunes il frazionamento non aggiorna da solo l'intestatario. Lo faccio con un foglio Excel mio. Ci sono le eccezioni delle successioni, che si contano a parte." }, // allow-italian: fixture data, shown as written
    { role: 'assistant', text: 'Chi la sostituisce quando è in ferie?' }, // allow-italian: fixture data, shown as written
    { role: 'person', text: 'Nessuno, aspettano che torni.' }, // allow-italian: fixture data, shown as written
    { role: 'assistant', text: 'Dove sta scritta la regola delle successioni?' }, // allow-italian: fixture data, shown as written
    { role: 'person', text: 'In una nota interna, credo nella cartella condivisa del catasto.' }, // allow-italian: fixture data, shown as written
  ] as InterviewTurn[],
  /** The questions the assistant asks next, one for each answer the reader gives. */
  nextQuestions: [
    'Quante particelle controlli in un anno, più o meno?', // allow-italian: fixture data, shown as written
    'Quali errori trovi più spesso?', // allow-italian: fixture data, shown as written
    "C'è qualcosa che hai imparato negli anni e non è scritto da nessuna parte?", // allow-italian: fixture data, shown as written
  ],
  closing: 'Grazie, ho tutto quello che serve per una bozza di procedura. Puoi rivederla in Conoscenza.', // allow-italian: fixture data, shown as written
  fact: {
    id: 'fatto-frazionamenti', // allow-italian: fixture data, shown as written
    title: 'Controllo delle particelle frazionate prima del ruolo', // allow-italian: fixture data, shown as written
    who: 'solo il responsabile del catasto', // allow-italian: fixture data, shown as written
    often: 'annuale, 3 giorni (stima)', // allow-italian: fixture data, shown as written
    programs: 'Prunes, foglio Excel', // allow-italian: fixture data, shown as written
    data: [{ kind: 'record', name: 'Particella' }, { kind: 'record', name: 'Intestatario' }], // allow-italian: fixture data, shown as written
    exception: 'le successioni si contano a parte.', // allow-italian: fixture data, shown as written
    missing: 'nota interna, da trovare', // allow-italian: fixture data, shown as written
  } as KnowledgeFact,
  /** What comes out of the interview. */
  outputs: [
    { id: 'o-procedura', kind: 'procedure', title: 'Procedura «Controllo delle particelle frazionate»' }, // allow-italian: fixture data, shown as written
    { id: 'o-richiesta', kind: 'request', title: 'Richiesta al direttore: la nota interna sulle successioni' }, // allow-italian: fixture data, shown as written
    { id: 'o-flusso', kind: 'flow', title: 'Proposta di flusso: controllo dei frazionamenti prima del ruolo' }, // allow-italian: fixture data, shown as written
    { id: 'o-persona', kind: 'person', title: 'Seconda persona da formare come sostituto' }, // allow-italian: fixture data, shown as written
  ] as Array<{ id: string; kind: 'procedure' | 'request' | 'flow' | 'person'; title: string }>,
  /** The draft flow «Crea la bozza» makes from the interview. (allow-italian: quotes the Italian interface) */
  draftFlow: {
    name: 'Controllo dei frazionamenti prima del ruolo', // allow-italian: fixture data, shown as written
    trigger: 'si avvicina la data di emissione del ruolo', // allow-italian: fixture data, shown as written
    office: 'catasto' as Office,
    steps: [
      { id: 's1', label: 'Trova le particelle frazionate nell’anno', kind: 'robot', program: 'Prunes', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Confronta intestatario e successioni', kind: 'ai', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: 'Il responsabile del catasto controlla le eccezioni', kind: 'person', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'Aggiorna gli intestatari in Prunes', kind: 'robot', program: 'Prunes', office: 'catasto' }, // allow-italian: fixture data, shown as written
    ] as FlowStepSeed[],
  },
};

/** n02: where the organization is in its first steps; the people counts are an example. */
export const FIRST_STEPS = {
  mail: 'Casella protocollo@ collegata', // allow-italian: fixture data, shown as written
  docs: "Statuto, regolamenti, Libro dell'anno", // allow-italian: fixture data, shown as written
  people: { invited: 19, total: 31 },
};
