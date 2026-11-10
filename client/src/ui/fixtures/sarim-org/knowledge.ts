/**
 * The documents SARIM works with, as «Conoscenza» shows them: the laws and (allow-italian: quotes the Italian interface)
 * rules behind the repetitive work of the questionnaire, the company's own
 * papers, and the internal procedures the agents wrote from the closed cards.
 *
 * Every law reference and every link was opened on the official source on
 * 8/11/2026 (normattiva.it, gazzettaufficiale.it, arera.it, the CCNL as the
 * signatory associations publish it, sarimambiente.it and SARIM's ARERA
 * portal). A `quote` is a short passage copied from that text, never written
 * by hand; a `summary` says what the part means for SARIM's work and is not
 * the text of the law. The procedures, their steps, dates and approvals are
 * examples, coherent with the cards, the flows and the contracts.
 *
 * Citations point at what exists in the other fixtures: a card id of
 * `cards.ts`, a flow and step of `flows.ts`, a contract and clause of
 * `contracts.ts`. A procedure step rests on parts of the other documents
 * (`<doc>/<part>`) or on a contract clause (`contract:<id>/<clause>`).
 */
import type { SarimArea } from './people';

export type KnowledgeCollection = 'norme' | 'azienda' | 'procedure'; // allow-italian: address segments, compared by value

/** Who cites a part: a card, a step of a flow, a clause of a contract. */
export interface KnowledgeCitation {
  kind: 'card' | 'flow' | 'contract';
  /** The card id, the flow id or the contract id. */
  id: string;
  /** The step of the flow or the clause of the contract. */
  at?: string;
  /** Why it cites the part, in one line. */
  why: string;
}

export interface KnowledgePart {
  /** Address segment: `/conoscenza/dlgs-36-2023/art-120-c3`. (allow-italian: address segment, not shown) */
  id: string;
  /** As printed above the part. */
  heading: string;
  /** The chip of the strip of parts. */
  short: string;
  /** A short passage of the official text, copied from `url`, `KnowledgeDoc.url` or `KnowledgeDoc.textUrl`. */
  quote?: string;
  /** The official page of this part, when it is not the one of the document. */
  url?: string;
  /** What the part means for SARIM's work, in plain words: a summary, not the text. */
  summary: string;
  /** For a step of a procedure: what it rests on, `<doc>/<part>` or `contract:<id>/<clause>`. */
  rests?: string[];
  /** What the agents check because of it, with the step of the flow that applies it. */
  checks?: Array<{ label: string; flow?: string; step?: string }>;
  citedBy?: KnowledgeCitation[];
  /** Extra words that should find it in search and in the question box. */
  keywords?: string;
}

export interface KnowledgeVersion {
  id: string;
  label: string;
  detail: string;
  status: { text: string; tone: 'green' | 'amber' | 'neutral' };
  current?: boolean;
}

/** What makes a document a procedure: who wrote it, who approves it, how it is used. */
export interface KnowledgeProcedure {
  /** The agent that wrote the draft (`people.ts`). */
  writtenBy: string;
  /** `YYYY-MM-DD` */
  writtenAt: string;
  /** `draft`: written by the agent, waits for a person; `approved`: in use. */
  state: 'draft' | 'approved';
  /** The person who approves it (a persona id); for an approved one, who did. */
  approver: string;
  approvedAt?: string;
  area: SarimArea;
  /** The flows that follow it. */
  flows: string[];
  programs: string[];
  /** How long it takes, an example. */
  time: string;
  /** What the agent wrote it from. */
  basedOn: string;
  mistakes: string;
}

export interface KnowledgeDoc {
  /** Address segment: `/conoscenza/dlgs-152-2006`. (allow-italian: address segment, not shown) */
  id: string;
  collection: KnowledgeCollection;
  /** Short name, for the tree, the chips and the sources. */
  label: string;
  title: string;
  subtitle?: string;
  /** Who issued it. */
  issuer: string;
  /** The official page of the document (opened as an external link); an internal procedure has none. */
  url?: string;
  /** The host shown on the link. */
  host?: string;
  /** Where the quotes were read, when not on `url` itself. */
  textUrl?: string;
  /** One line under the title: in force since, published in. */
  note: string;
  status: { text: string; tone: 'green' | 'amber' | 'neutral' };
  facts: Array<{ label: string; value: string }>;
  parts: KnowledgePart[];
  versions: KnowledgeVersion[];
  procedure?: KnowledgeProcedure;
  keywords?: string;
}

export interface KnowledgeCollectionDef {
  id: KnowledgeCollection;
  label: string;
  description: string;
  /** Who can read it. */
  viewers: string;
  /** Where its documents come from. */
  source: string;
}

/** A question people ask often, with the answer the box gives: each sentence cites the part it comes from (`<doc>/<part>`). */
export interface KnowledgeQuestion {
  question: string;
  answer: Array<{ text: string; source: string }>;
}

/* ---------- collections ---------- */

export const SARIM_KNOWLEDGE_COLLECTIONS: KnowledgeCollectionDef[] = [
  {
    id: 'norme', label: 'Norme e regole', // allow-italian: fixture data, shown as written
    description: 'Le leggi e le regole che governano i lavori ripetitivi del questionario: formulari e RENTRI, subappalti e varianti, trasparenza e qualità del servizio, CCNL.', // allow-italian: fixture data, shown as written
    viewers: 'tutti', source: 'Normattiva, Gazzetta Ufficiale, ARERA, associazioni firmatarie', // allow-italian: fixture data, shown as written
  },
  {
    id: 'azienda', label: 'Documenti di SARIM', // allow-italian: fixture data, shown as written
    description: "I documenti pubblici dell'azienda: carte della qualità, certificazioni, iscrizione all'Albo, portale della trasparenza.", // allow-italian: fixture data, shown as written
    viewers: 'tutti', source: 'sarimambiente.it e portale ARERA di SARIM', // allow-italian: fixture data, shown as written
  },
  {
    id: 'procedure', label: 'Procedure interne', // allow-italian: fixture data, shown as written
    description: "Come si lavora, passo per passo. Le scrive l'agente dalle card chiuse e dalle norme che citano; una persona le approva prima che entrino nei flussi.", // allow-italian: fixture data, shown as written
    viewers: 'tutti', source: 'scritte dagli agenti, approvate da una persona', // allow-italian: fixture data, shown as written
  },
];

/* ---------- laws and rules ---------- */

const NORMATTIVA = 'normattiva.it';
const ART_119 = 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2023-03-31;36~art119'; // allow-italian: official address of the source, not shown as text
const ART_120 = 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2023-03-31;36~art120'; // allow-italian: official address of the source, not shown as text
const ART_188_BIS = 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2006-04-03;152~art188bis'; // allow-italian: official address of the source, not shown as text

const ENVIRONMENT_CODE: KnowledgeDoc = {
  id: 'dlgs-152-2006', collection: 'norme', label: 'D.Lgs. 152/2006', // allow-italian: fixture data, shown as written
  title: 'Decreto legislativo 3 aprile 2006, n. 152', // allow-italian: fixture data, shown as written
  subtitle: 'Norme in materia ambientale, Parte quarta: gestione dei rifiuti', // allow-italian: fixture data, shown as written
  issuer: 'Stato', url: 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2006-04-03;152~art193', host: NORMATTIVA, // allow-italian: fixture data, shown as written
  note: 'Art. 193 nel testo in vigore dal 16/06/2023, art. 188-bis dal 01/01/2026', // allow-italian: fixture data, shown as written
  status: { text: 'In vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Data', value: '3 aprile 2006' }, // allow-italian: fixture data, shown as written
    { label: 'Parti usate', value: 'art. 188-bis, art. 193' }, // allow-italian: fixture data, shown as written
    { label: 'Testo letto su', value: NORMATTIVA }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'art-193-c1', short: 'Art. 193 c. 1', heading: 'Art. 193, comma 1 · Trasporto dei rifiuti', // allow-italian: fixture data, shown as written
      quote: 'Il trasporto dei rifiuti, eseguito da enti o imprese, è accompagnato da un formulario di identificazione (FIR)', // allow-italian: fixture data, shown as written
      summary: 'Ogni trasporto ha il suo FIR. Il formulario dice chi produce e chi detiene il rifiuto, origine, tipo e quantità, impianto di destinazione, data e percorso, destinatario.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'FIR presente per ogni ritiro chiuso', flow: 'sarim-fir', step: 's1' }, { label: 'codice EER, pesi, targa e destinatario letti', flow: 'sarim-fir', step: 's1' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'sarim-fir', at: 's1', why: "L'agente legge il formulario con i dati che l'articolo elenca" }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'FIR-0941', why: 'Formulario organico di Castellabate da leggere' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'FIR-0939', why: 'Formulario carta e cartone di Agropoli da controllare' }, // allow-italian: fixture data, shown as written
        { kind: 'contract', id: 'c-albanella', at: 'art-5', why: 'Il rendiconto mensile al Comune va dato con i formulari' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'formulario fir trasporto rifiuti produttore detentore destinatario quantità percorso', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-193-c2', short: 'Art. 193 c. 2', heading: 'Art. 193, comma 2 · Modello, numerazione e vidimazione', // allow-italian: fixture data, shown as written
      quote: 'sono disciplinati il modello del formulario di identificazione del rifiuto e le modalità di numerazione, vidimazione', // allow-italian: fixture data, shown as written
      summary: "Modello del FIR, numerazione, vidimazione, tenuta e trasmissione al RENTRI li stabilisce il decreto dell'art. 188-bis: è il D.M. 59/2023.", // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'sarim-fir', at: 's7', why: 'La registrazione va trasmessa al RENTRI e il formulario archiviato' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'FIR-0931', why: 'Organico di Capaccio Paestum, registrato e archiviato' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'vidimazione numerazione modello rentri trasmissione', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-188bis', short: 'Art. 188-bis', heading: 'Art. 188-bis · Sistema di tracciabilità dei rifiuti', // allow-italian: fixture data, shown as written
      url: ART_188_BIS,
      quote: 'Il sistema di tracciabilità dei rifiuti si compone delle procedure e degli strumenti di tracciabilità dei rifiuti integrati', // allow-italian: fixture data, shown as written
      summary: 'Registro di carico e scarico, formulario e catasto stanno in un unico sistema di tracciabilità, il RENTRI. Il testo letto è quello in vigore dal 01/01/2026.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-fir', at: 's4', why: "L'agente prepara la registrazione di carico e scarico per il RENTRI" }], // allow-italian: fixture data, shown as written
      keywords: 'tracciabilità rentri registro elettronico sistema', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-2023', label: 'Art. 193, testo in vigore dal 16/06/2023', detail: 'Quello che usano gli agenti: le citazioni vengono da qui.', status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
    { id: 'v-2006', label: 'Testo originario del 2006', detail: 'Superato da più aggiornamenti; resta su Normattiva come storico.', status: { text: 'Superato', tone: 'neutral' } }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'codice ambiente testo unico ambientale rifiuti', // allow-italian: fixture data, shown as written
};

const DM_59: KnowledgeDoc = {
  id: 'dm-59-2023', collection: 'norme', label: 'D.M. 59/2023 (RENTRI)', // allow-italian: fixture data, shown as written
  title: 'Decreto 4 aprile 2023, n. 59', // allow-italian: fixture data, shown as written
  subtitle: 'Regolamento sul sistema di tracciabilità dei rifiuti e sul registro elettronico nazionale (RENTRI)', // allow-italian: fixture data, shown as written
  issuer: "Ministero dell'Ambiente e della Sicurezza Energetica", // allow-italian: fixture data, shown as written
  url: 'https://www.gazzettaufficiale.it/atto/serie_generale/caricaDettaglioAtto/originario?atto.dataPubblicazioneGazzetta=2023-05-31&atto.codiceRedazionale=23G00065&elenco30giorni=false', // allow-italian: official address of the source, not shown as text
  host: 'gazzettaufficiale.it',
  note: 'GU Serie Generale n. 126 del 31/05/2023, in vigore dal 15/06/2023', // allow-italian: fixture data, shown as written
  status: { text: 'In vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Pubblicato', value: 'GU n. 126 del 31/05/2023' }, // allow-italian: fixture data, shown as written
    { label: 'In vigore dal', value: '15/06/2023' }, // allow-italian: fixture data, shown as written
    { label: 'Articoli', value: '24, più 3 allegati' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'art-1', short: 'Art. 1', heading: 'Art. 1 · Oggetto e finalità', // allow-italian: fixture data, shown as written
      quote: "il presente regolamento disciplina il sistema di tracciabilita' dei rifiuti", // allow-italian: fixture data, shown as written
      summary: 'Il regolamento mette insieme registro (art. 190), formulario (art. 193) e catasto (art. 189) del D.Lgs. 152/2006 nel RENTRI.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-fir', at: 's4', why: 'La registrazione preparata segue i modelli del RENTRI' }], // allow-italian: fixture data, shown as written
      keywords: 'rentri regolamento oggetto', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-4', short: 'Art. 4', heading: 'Art. 4, comma 2 · Registro cronologico di carico e scarico', // allow-italian: fixture data, shown as written
      quote: 'Nel registro cronologico di carico e scarico sono integrate anche le informazioni dei formulari di identificazione del rifiuto.', // allow-italian: fixture data, shown as written
      summary: 'Quello che è scritto sul FIR finisce nel registro: un peso corretto sul formulario va corretto anche nella registrazione.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'registro allineato al formulario', flow: 'sarim-fir', step: 's4' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'sarim-fir', at: 's4', why: 'La registrazione di carico e scarico riprende i dati del formulario' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'FIR-0938', why: 'Peso a destino più alto della stima: registro da allineare' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'registro cronologico carico scarico peso', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-5', short: 'Art. 5', heading: 'Art. 5, commi 2 e 3 · Chi emette il formulario', // allow-italian: fixture data, shown as written
      quote: "il formulario puo' essere emesso e compilato a cura del trasportatore, a seguito di richiesta del produttore o del detentore.", // allow-italian: fixture data, shown as written
      summary: 'Il FIR lo emette il produttore o il detentore; gli altri operatori lo integrano e lo firmano per la loro parte. SARIM, come trasportatore, può compilarlo su richiesta, ma chi lo chiede resta responsabile dei suoi dati.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'richiesta del produttore agli atti quando compila SARIM', flow: 'sarim-fir', step: 's1' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'sarim-fir', at: 's1', why: "L'agente prepara il formulario per conto del Comune" }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'FIR-0941', why: 'Formulario compilato da SARIM come trasportatore' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'emette compila trasportatore produttore detentore chi firma', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-6', short: 'Art. 6', heading: 'Art. 6, comma 4 · Formulario cartaceo in due copie', // allow-italian: fixture data, shown as written
      quote: "e' riprodotto in due copie, compilate, datate e firmate dal produttore o detentore, sottoscritte altresi' dal trasportatore.", // allow-italian: fixture data, shown as written
      summary: "Una copia resta al produttore; l'altra la firma e la data il destinatario all'arrivo, che ne dà una riproduzione al trasportatore. Senza la copia firmata a destino il peso verificato manca.", // allow-italian: fixture data, shown as written
      checks: [{ label: 'copia firmata dal destinatario con il peso', flow: 'sarim-fir', step: 's2' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'card', id: 'FIR-0936', why: "Manca il peso verificato a destino: serve la copia firmata dall'impianto" }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'FIR-0933', why: 'Ingombranti di Pontecagnano Faiano: copia di ritorno controllata' }, // allow-italian: fixture data, shown as written
        { kind: 'flow', id: 'sarim-fir', at: 's2', why: "Il customer service chiede all'impianto i dati che mancano" }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'copie cartaceo firma destinatario peso verificato arrivo', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-7', short: 'Art. 7', heading: 'Art. 7, comma 2 · Formulario digitale e codice univoco', // allow-italian: fixture data, shown as written
      quote: "Il formulario e' vidimato digitalmente tramite l'assegnazione di un codice univoco", // allow-italian: fixture data, shown as written
      summary: "Il FIR digitale prende un codice univoco dall'applicazione del RENTRI, con il servizio di vidimazione delle camere di commercio.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-fir', at: 's7', why: 'Registrazione trasmessa al RENTRI con il codice del formulario' }], // allow-italian: fixture data, shown as written
      keywords: 'digitale vidimazione codice univoco camera di commercio', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-13', short: 'Art. 13', heading: 'Art. 13 · Tempistiche di iscrizione al RENTRI', // allow-italian: fixture data, shown as written
      quote: 'a decorrere dal diciottesimo mese ed entro i sessanta giorni successivi', // allow-italian: fixture data, shown as written
      summary: "L'iscrizione è scaglionata: prima i produttori con più di cinquanta dipendenti e tutti i soggetti diversi dai produttori iniziali, come chi trasporta e gestisce rifiuti; poi i più piccoli.", // allow-italian: fixture data, shown as written
      keywords: 'iscrizione rentri tempi scadenze dipendenti', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-gu', label: 'Testo pubblicato in GU n. 126 del 31/05/2023', detail: 'Le citazioni vengono dal testo della Gazzetta Ufficiale.', status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'rentri registro elettronico nazionale tracciabilità formulario', // allow-italian: fixture data, shown as written
};

const CONTRACTS_CODE: KnowledgeDoc = {
  id: 'dlgs-36-2023', collection: 'norme', label: 'D.Lgs. 36/2023', // allow-italian: fixture data, shown as written
  title: 'Decreto legislativo 31 marzo 2023, n. 36', // allow-italian: fixture data, shown as written
  subtitle: 'Codice dei contratti pubblici: subappalto (art. 119) e modifiche dei contratti (art. 120)', // allow-italian: fixture data, shown as written
  issuer: 'Stato', url: ART_120, host: NORMATTIVA, // allow-italian: fixture data, shown as written
  note: 'Artt. 119 e 120 nel testo in vigore dal 31/12/2024', // allow-italian: fixture data, shown as written
  status: { text: 'In vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Data', value: '31 marzo 2023' }, // allow-italian: fixture data, shown as written
    { label: 'Testo in vigore dal', value: '31/12/2024' }, // allow-italian: fixture data, shown as written
    { label: 'Parti usate', value: 'art. 119, art. 120' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'art-119-c2', short: 'Art. 119 c. 2', heading: 'Art. 119, comma 2 · Che cos\'è il subappalto', // allow-italian: fixture data, shown as written
      url: ART_119,
      quote: "Il subappalto è il contratto con il quale l'appaltatore affida a terzi l'esecuzione di parte delle prestazioni o lavorazioni", // allow-italian: fixture data, shown as written
      summary: 'Se una parte del servizio la fa un altro, con i suoi mezzi o il suo personale, è subappalto: serve tutto quello che chiede l\'art. 119.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'contract', id: 'c-sub-lavaggio', at: 'art-1', why: 'Il lavaggio dei contenitori di Castellabate affidato a un altro' }], // allow-italian: fixture data, shown as written
      keywords: 'subappalto definizione terzi prestazioni', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-119-c4', short: 'Art. 119 c. 4', heading: 'Art. 119, comma 4 · Quando si può subappaltare', // allow-italian: fixture data, shown as written
      url: ART_119,
      quote: "all'atto dell'offerta siano stati indicati i lavori o le parti di opere ovvero i servizi e le forniture", // allow-italian: fixture data, shown as written
      summary: "Si subappalta con l'autorizzazione della stazione appaltante, se il subappaltatore ha i requisiti, non ha motivi di esclusione e se la parte era già indicata nell'offerta.", // allow-italian: fixture data, shown as written
      checks: [{ label: 'parti da subappaltare indicate in offerta', flow: 'sarim-gara', step: 's4' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'contract', id: 'c-castellabate', at: 'art-11', why: 'La clausola del subappalto del contratto principale' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'CT-N12', why: 'Autorizzazione al subappalto del lavaggio contenitori' }, // allow-italian: fixture data, shown as written
        { kind: 'flow', id: 'sarim-gara', at: 's4', why: 'Il Legale controlla in gara cosa si vuole subappaltare' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'autorizzazione requisiti offerta subappaltatore esclusione', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-119-c6', short: 'Art. 119 c. 6', heading: 'Art. 119, comma 6 · Responsabilità in solido', // allow-italian: fixture data, shown as written
      url: ART_119,
      quote: 'Il contraente principale e il subappaltatore sono responsabili in solido nei confronti della stazione appaltante', // allow-italian: fixture data, shown as written
      summary: 'Per le prestazioni del subappalto SARIM risponde insieme al subappaltatore: per questo prima di pagarlo controlla DURC e rapporti di lavoro.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'contract', id: 'c-sub-lavaggio', at: 'art-5', why: 'DURC del subappaltatore prima di ogni pagamento' }], // allow-italian: fixture data, shown as written
      keywords: 'solido responsabilità durc pagamento subappaltatore', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-119-c16', short: 'Art. 119 c. 16', heading: 'Art. 119, comma 16 · Trenta giorni per autorizzare', // allow-italian: fixture data, shown as written
      url: ART_119,
      quote: "La stazione appaltante rilascia l'autorizzazione di cui al comma 4 entro trenta giorni dalla relativa richiesta", // allow-italian: fixture data, shown as written
      summary: "Il termine si proroga una sola volta, per giustificati motivi; passato senza risposta, l'autorizzazione si intende concessa. I termini sono a metà per i subappalti sotto il 2% del valore o sotto 100.000 euro.", // allow-italian: fixture data, shown as written
      checks: [{ label: 'trenta giorni dalla richiesta in scadenzario', flow: 'sarim-varianti', step: 's1' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'card', id: 'CT-N12', why: 'Richiesta al RUP: il termine dei trenta giorni corre' }, // allow-italian: fixture data, shown as written
        { kind: 'contract', id: 'c-sub-lavaggio', at: 'art-2', why: 'Il subappalto parte solo con l\'autorizzazione del committente' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'trenta giorni autorizzazione silenzio assenso proroga termine rup', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-120-c1a', short: 'Art. 120 c. 1 a)', heading: 'Art. 120, comma 1, lettera a) · Modifiche previste nel contratto', // allow-italian: fixture data, shown as written
      url: ART_120,
      quote: 'se le modifiche, a prescindere dal loro valore monetario, sono state previste in clausole chiare, precise e inequivocabili', // allow-italian: fixture data, shown as written
      summary: 'Una modifica già scritta nei documenti di gara in modo chiaro si fa senza nuova procedura, qualunque sia il valore.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'contract', id: 'c-castellabate', at: 'art-4', why: 'Servizi e frequenze, con le frequenze estive delle frazioni costiere' }], // allow-italian: fixture data, shown as written
      keywords: 'modifica clausola prevista documenti gara opzione', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-120-c3', short: 'Art. 120 c. 3', heading: 'Art. 120, comma 3 · Modifiche sotto soglia e sotto il 10%', // allow-italian: fixture data, shown as written
      url: ART_120,
      quote: 'il 10 per cento del valore iniziale del contratto per i contratti di servizi e forniture', // allow-italian: fixture data, shown as written
      summary: "Senza nuova procedura la modifica deve stare sotto entrambi i valori: le soglie dell'art. 14 e il 10% del valore iniziale per servizi e forniture (15% per i lavori).", // allow-italian: fixture data, shown as written
      checks: [{ label: 'quota della variante sul valore iniziale', flow: 'sarim-varianti', step: 's4' }, { label: "confronto con le soglie dell'art. 14", flow: 'sarim-varianti', step: 's5' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'card', id: 'CT-V07', why: 'Variante di Castellabate: +4,2% del valore' }, // allow-italian: fixture data, shown as written
        { kind: 'flow', id: 'sarim-varianti', at: 's4', why: "L'agente confronta il valore della variante con quello iniziale" }, // allow-italian: fixture data, shown as written
        { kind: 'contract', id: 'c-castellabate', at: 'art-4', why: 'La variante tocca i servizi e le frequenze' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'variante dieci per cento soglia valore iniziale nuova gara modifica', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-120-c9', short: 'Art. 120 c. 9', heading: 'Art. 120, comma 9 · Aumento o diminuzione fino a un quinto', // allow-italian: fixture data, shown as written
      url: ART_120,
      quote: "un aumento o una diminuzione delle prestazioni fino a concorrenza del quinto dell'importo del contratto", // allow-italian: fixture data, shown as written
      summary: "Entro un quinto dell'importo la stazione appaltante può imporre all'appaltatore l'esecuzione alle condizioni originarie del contratto.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'card', id: 'CT-V07', why: "La variante resta dentro il quinto dell'importo" }], // allow-italian: fixture data, shown as written
      keywords: 'quinto importo aumento diminuzione prestazioni condizioni originarie', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-2024', label: 'Testo in vigore dal 31/12/2024', detail: 'Con le modifiche del correttivo: le citazioni vengono da qui.', status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
    { id: 'v-2023', label: 'Testo originario del 2023', detail: 'In vigore dal 1° aprile 2023, efficace dal 1° luglio 2023; superato.', status: { text: 'Superato', tone: 'neutral' } }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'codice appalti contratti pubblici subappalto variante', // allow-italian: fixture data, shown as written
};

const TITR: KnowledgeDoc = {
  id: 'arera-titr', collection: 'norme', label: 'ARERA 444/2019 (TITR)', // allow-italian: fixture data, shown as written
  title: 'Delibera ARERA 31 ottobre 2019, 444/2019/R/rif', // allow-italian: fixture data, shown as written
  subtitle: 'Disposizioni in materia di trasparenza nel servizio di gestione dei rifiuti urbani e assimilati', // allow-italian: fixture data, shown as written
  issuer: 'ARERA', url: 'https://www.arera.it/atti-e-provvedimenti/dettaglio/19/444-19', host: 'arera.it', // allow-italian: fixture data, shown as written
  textUrl: 'https://www.arera.it/fileadmin/allegati/docs/19/444-19all.pdf',
  note: 'Allegato TITR; aggiornato dalle delibere 15/2022/R/rif e 386/2023/R/rif', // allow-italian: fixture data, shown as written
  status: { text: 'In vigore, aggiornata', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Data', value: '31 ottobre 2019' }, // allow-italian: fixture data, shown as written
    { label: 'Allegato', value: 'TITR' }, // allow-italian: fixture data, shown as written
    { label: 'Dove la applica SARIM', value: 'portale sarimambiente-arera.com' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'art-3-1', short: 'Art. 3.1', heading: 'Art. 3.1 · Sezione trasparenza del sito', // allow-italian: fixture data, shown as written
      quote: 'un’apposita sezione del proprio sito internet, facilmente accessibile dalla home page', // allow-italian: fixture data, shown as written
      summary: 'Il gestore tiene aggiornata una sezione del sito con le informazioni minime per ogni ambito servito: SARIM lo fa con il portale ARERA, una scheda per comune.', // allow-italian: fixture data, shown as written
      keywords: 'trasparenza sito internet sezione informazioni minime', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-3-1-b', short: 'Art. 3.1 b)', heading: 'Art. 3.1, lettera b) · Recapiti per segnalazioni e reclami', // allow-italian: fixture data, shown as written
      quote: 'recapiti telefonici, postali e di posta elettronica per l’invio di richieste di informazioni, segnalazione di disservizi e reclami', // allow-italian: fixture data, shown as written
      summary: 'Telefono, posta ed email per segnalare un disservizio o fare reclamo devono stare sul sito: per SARIM il numero verde 800.983850.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'contract', id: 'c-sarno', at: 'art-4', why: 'Risposta scritta ai reclami degli utenti' }], // allow-italian: fixture data, shown as written
      keywords: 'recapiti numero verde reclami segnalazioni disservizi email', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-3-1-g', short: 'Art. 3.1 g)', heading: 'Art. 3.1, lettera g) · Carta della qualità scaricabile', // allow-italian: fixture data, shown as written
      quote: 'Carta della qualità del servizio vigente, liberamente scaricabile', // allow-italian: fixture data, shown as written
      summary: 'La Carta della qualità in vigore va messa sul sito, scaricabile da tutti.', // allow-italian: fixture data, shown as written
      keywords: 'carta della qualità scaricabile sito', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-agg', label: 'TITR aggiornato con le delibere 15/2022 e 386/2023', detail: 'Il testo coordinato pubblicato da ARERA.', status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
    { id: 'v-2019', label: 'Allegato originario, periodo 1° aprile 2020 - 31 dicembre 2023', detail: 'Le citazioni vengono da questo testo.', status: { text: 'Storico', tone: 'neutral' } }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'arera trasparenza titr tari rifiuti urbani', // allow-italian: fixture data, shown as written
};

const SERVICE_QUALITY: KnowledgeDoc = {
  id: 'arera-tqrif', collection: 'norme', label: 'ARERA 15/2022 (TQRIF)', // allow-italian: fixture data, shown as written
  title: 'Delibera ARERA 18 gennaio 2022, 15/2022/R/rif', // allow-italian: fixture data, shown as written
  subtitle: 'Regolazione della qualità del servizio di gestione dei rifiuti urbani (Allegato A, TQRIF)', // allow-italian: fixture data, shown as written
  issuer: 'ARERA', url: 'https://www.arera.it/atti-e-provvedimenti/dettaglio/22/015-22', host: 'arera.it', // allow-italian: fixture data, shown as written
  textUrl: 'https://www.arera.it/fileadmin/allegati/docs/22/015-22alla.pdf', // allow-italian: official address of the source, not shown as text
  note: 'Obblighi di qualità dal 1° gennaio 2023; ARERA pubblica anche l\'Allegato A aggiornato', // allow-italian: fixture data, shown as written
  status: { text: 'In vigore, aggiornata', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Data', value: '18 gennaio 2022' }, // allow-italian: fixture data, shown as written
    { label: 'Allegato', value: 'A, TQRIF' }, // allow-italian: fixture data, shown as written
    { label: 'Agropoli', value: 'schema I, dalla Carta della qualità' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'art-5-1', short: 'Art. 5.1', heading: 'Art. 5.1 · Una Carta della qualità per gestione', // allow-italian: fixture data, shown as written
      quote: 'L’Ente territorialmente competente approva per ogni singola gestione un’unica Carta della qualità del servizio integrato di gestione dei rifiuti urbani', // allow-italian: fixture data, shown as written
      summary: "Per ogni comune servito c'è una sola Carta della qualità, approvata dall'ente territoriale: quella di Agropoli è aggiornata a novembre 2024.", // allow-italian: fixture data, shown as written
      keywords: 'carta della qualità ente territoriale approva gestione', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-29-2', short: 'Art. 29.2', heading: 'Art. 29.2 · Ritiro su chiamata degli ingombranti', // allow-italian: fixture data, shown as written
      quote: 'un numero minimo di un (1) ritiro mensile per utenza almeno a bordo strada con un limite di cinque (5) pezzi per ciascun ritiro', // allow-italian: fixture data, shown as written
      summary: 'Il ritiro degli ingombranti a domicilio è senza oneri aggiuntivi: almeno uno al mese per utenza, a bordo strada, fino a cinque pezzi.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'pezzi della prenotazione entro cinque', flow: 'sarim-segnalazioni', step: 's1' }], // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'card', id: 'SG-4132', why: 'Prenotazione ingombranti dall\'app: quattro pezzi' }], // allow-italian: fixture data, shown as written
      keywords: 'ingombranti ritiro chiamata pezzi gratis mensile bordo strada', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-31-1', short: 'Art. 31.1', heading: 'Art. 31.1 · Quindici giorni lavorativi per il ritiro', // allow-italian: fixture data, shown as written
      quote: 'Il tempo di ritiro dei rifiuti su chiamata, pari a quindici (15) giorni lavorativi', // allow-italian: fixture data, shown as written
      summary: 'Dalla richiesta al ritiro passano al massimo 15 giorni lavorativi. Dal calcolo restano fuori le prenotazioni in cui l\'utente sceglie una data più lontana di quella proposta (31.2).', // allow-italian: fixture data, shown as written
      checks: [{ label: 'data proposta entro 15 giorni lavorativi', flow: 'sarim-segnalazioni', step: 's3' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'card', id: 'SG-4132', why: 'Turno ingombranti proposto per martedì 10/11' }, // allow-italian: fixture data, shown as written
        { kind: 'flow', id: 'sarim-segnalazioni', at: 's3', why: "L'agente propone il turno del cantiere di zona" }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'quindici giorni lavorativi tempo ritiro richiesta', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-32-1', short: 'Art. 32.1', heading: 'Art. 32.1 · Come si segnala un disservizio', // allow-italian: fixture data, shown as written
      quote: 'La segnalazione per disservizi può essere presentata dall’utente al gestore della raccolta e trasporto', // allow-italian: fixture data, shown as written
      summary: 'Una segnalazione arriva per posta, email, sportello fisico o online, o telefono: tutti i canali valgono e vanno letti allo stesso modo.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'canale di arrivo registrato', flow: 'sarim-segnalazioni', step: 's1' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'sarim-segnalazioni', at: 's1', why: "L'agente legge mail AMA, numero verde, app ed Enviro" }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'SG-4126', why: 'Abbandono segnalato al numero verde, senza foto' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'segnalazione disservizio canali telefono email sportello', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-33-1', short: 'Art. 33.1', heading: 'Art. 33.1 · Cinque giorni lavorativi per intervenire', // allow-italian: fixture data, shown as written
      quote: 'Il tempo di intervento in caso di segnalazioni per disservizi, pari a cinque (5) giorni lavorativi', // allow-italian: fixture data, shown as written
      summary: 'Dalla segnalazione alla soluzione del disservizio passano al massimo 5 giorni lavorativi; il tempo è differenziato se serve un sopralluogo (33.2).', // allow-italian: fixture data, shown as written
      checks: [{ label: 'segnalazione chiusa entro 5 giorni lavorativi', flow: 'sarim-segnalazioni', step: 's5' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'card', id: 'SG-4129', why: 'Abbandono di rifiuti da demolizione a Pontecagnano Faiano' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'SG-4124', why: 'Ingombranti accanto ai contenitori a Sarno' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'cinque giorni intervento disservizio sopralluogo', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-37-2', short: 'Art. 37.2', heading: 'Art. 37.2 · Recupero del servizio non fatto', // allow-italian: fixture data, shown as written
      quote: 'ventiquattro (24) ore per la raccolta domiciliare', // allow-italian: fixture data, shown as written
      summary: 'Un passaggio saltato del porta a porta si recupera entro 24 ore; per la raccolta stradale e di prossimità entro 24 o 72 ore, secondo la zona e la frazione.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'recupero entro 24 ore nel porta a porta', flow: 'sarim-segnalazioni', step: 's3' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'card', id: 'SG-4131', why: 'Organico non ritirato a una utenza non domestica di Roma' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'SG-4134', why: 'Multimateriale non ritirato a Matinella, Albanella' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'SG-4127', why: 'Carta non ritirata a Castellabate' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'SG-4118', why: 'Vetro di Montecorvino Rovella, recuperato' }, // allow-italian: fixture data, shown as written
        { kind: 'flow', id: 'sarim-segnalazioni', at: 's3', why: "L'agente propone il recupero nel primo giro utile" }, // allow-italian: fixture data, shown as written
        { kind: 'contract', id: 'c-rocca-priora', at: 'art-5', why: 'Penale per la raccolta non recuperata il giorno dopo' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'recupero ritiro saltato mancato ventiquattro ore settantadue porta a porta', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-agg', label: 'Allegato A aggiornato', detail: 'Il testo coordinato pubblicato da ARERA, con le modifiche della delibera 374/2025/R/rif.', status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
    { id: 'v-2022', label: 'Allegato A originario, 18/01/2022', detail: 'Le citazioni vengono da questo testo.', status: { text: 'Storico', tone: 'neutral' } }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'arera qualità tqrif standard tempi disservizi ingombranti', // allow-italian: fixture data, shown as written
};

const LABOUR_AGREEMENT: KnowledgeDoc = {
  id: 'ccnl-servizi-ambientali', collection: 'norme', label: 'CCNL Servizi Ambientali', // allow-italian: fixture data, shown as written
  title: 'Contratto collettivo nazionale di lavoro dei servizi ambientali 18 maggio 2022', // allow-italian: fixture data, shown as written
  subtitle: 'Testo unico firmato al CNEL il 10/07/2024', // allow-italian: fixture data, shown as written
  issuer: 'Utilitalia, Confindustria Cisambiente, Legacoop Produzione e Servizi, Confcooperative Lavoro e Servizi, AGCI Servizi, Assoambiente; FP CGIL, FIT CISL, Uiltrasporti, Fiadel', // allow-italian: fixture data, shown as written
  url: 'https://www.legacoop.coop/testo-unico-per-i-ccnl-delligiene-ambientale/', host: 'legacoop.coop',
  textUrl: 'https://www.amagambiente.it/wp-content/uploads/2026/09/ccnl-vigente-2022.pdf',
  note: 'Decorre dal 1° gennaio 2022, scadenza al 31 dicembre 2024 (art. 72)', // allow-italian: fixture data, shown as written
  status: { text: 'Testo vigente', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Firmato', value: '18 maggio 2022' }, // allow-italian: fixture data, shown as written
    { label: 'Testo unico', value: 'CNEL, 10 luglio 2024' }, // allow-italian: fixture data, shown as written
    { label: 'SARIM', value: 'iscritta ad Assoambiente dal 1992; il CCNL applicato non è dichiarato' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'art-6-c1', short: 'Art. 6 c. 1', heading: 'Art. 6, comma 1 · Cambio di gestore di un appalto', // allow-italian: fixture data, shown as written
      quote: 'in caso di avvicendamento nella gestione dell’appalto/affidamento di servizi', // allow-italian: fixture data, shown as written
      summary: "Quando un appalto passa da un'impresa all'altra e tutte e due applicano il CCNL, il passaggio del personale segue la procedura dell'articolo.", // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'contract', id: 'c-accordo-castellabate', at: 'art-1', why: 'Passaggio dei lavoratori della Castellabate Servizi' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'CT-T04', why: 'Verbale di passaggio degli 11 lavoratori' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'cambio appalto avvicendamento subentro passaggio personale clausola sociale', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-6-c3', short: 'Art. 6 c. 3', heading: 'Art. 6, comma 3 · Chi subentra assume il personale', // allow-italian: fixture data, shown as written
      quote: 'L’azienda subentrante assume ex novo, senza effettuazione del periodo di prova, tutto il personale in forza a tempo indeterminato', // allow-italian: fixture data, shown as written
      summary: "Chi vince assume senza prova i dipendenti a tempo indeterminato addetti all'appalto, in forza nei 240 giorni prima della nuova gestione: in gara va contato il personale da assorbire.", // allow-italian: fixture data, shown as written
      checks: [{ label: 'personale da assorbire nella scheda di gara', flow: 'sarim-gara', step: 's2' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'contract', id: 'c-castellabate', at: 'art-12', why: 'Personale e clausola sociale del contratto di Castellabate' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'GA-033', why: 'Unione di comuni: 23 addetti da assorbire' }, // allow-italian: fixture data, shown as written
        { kind: 'flow', id: 'sarim-gara', at: 's2', why: "L'agente scrive nella scheda personale e CCNL" }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'assume subentrante personale tempo indeterminato 240 giorni prova', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-11-c2', short: 'Art. 11 c. 2', heading: 'Art. 11, comma 2 · Tempo determinato oltre 12 mesi', // allow-italian: fixture data, shown as written
      quote: 'può essere apposto un termine di durata superiore a 12 mesi e fino a 24 mesi nelle ipotesi previste dalla legge', // allow-italian: fixture data, shown as written
      summary: 'Un contratto a termine può superare i 12 mesi solo fino a 24 e solo nei casi ammessi: chi è vicino ai 24 mesi va deciso prima della scadenza.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'mesi fatti e proroghe usate per ogni contratto', flow: 'sarim-scadenze', step: 's3' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'card', id: 'PE-117', why: 'Matricola 0590: 22 mesi fatti su 24' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'PE-118', why: '3 contratti estivi di Castellabate in scadenza il 30/11' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'PE-112', why: 'Proroga di 2 contratti a Pontecagnano Faiano' }, // allow-italian: fixture data, shown as written
        { kind: 'contract', id: 'c-td-castellabate', at: 'art-2', why: 'Durata dei contratti a termine estivi' }, // allow-italian: fixture data, shown as written
        { kind: 'flow', id: 'sarim-scadenze', at: 's3', why: "L'agente conta mesi fatti e proroghe" }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'tempo determinato contratto a termine 12 mesi 24 mesi proroga durata', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-11-c3', short: 'Art. 11 c. 3', heading: 'Art. 11, comma 3 · Le esigenze che lo consentono', // allow-italian: fixture data, shown as written
      quote: 'esecuzione di un’opera o di un servizio definiti e limitati nel tempo', // allow-italian: fixture data, shown as written
      summary: 'Il termine fino a 24 mesi è ammesso anche per le esigenze specifiche elencate dal contratto, tra cui un servizio definito e limitato nel tempo, come un servizio estivo.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'contract', id: 'c-td-castellabate', at: 'art-1', why: 'Servizio estivo di Castellabate' }], // allow-italian: fixture data, shown as written
      keywords: 'esigenze specifiche servizio limitato nel tempo estivo stagionale', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-72', short: 'Art. 72', heading: 'Art. 72 · Decorrenza e durata', // allow-italian: fixture data, shown as written
      quote: 'il presente contratto decorre dal 1° gennaio 2022 e scadrà il 31 dicembre 2024', // allow-italian: fixture data, shown as written
      summary: 'Durata triennale. Si rinnova se nessuna delle parti lo disdice almeno sei mesi prima della scadenza (art. 73).', // allow-italian: fixture data, shown as written
      keywords: 'durata decorrenza scadenza rinnovo ccnl', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-2024', label: 'Testo unico, CNEL 10/07/2024', detail: 'Sostituisce i CCNL del 10/07/2016 e del 06/12/2016: le citazioni vengono da qui.', status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
    { id: 'v-2016', label: 'CCNL del 10/07/2016 e del 06/12/2016', detail: 'Sostituiti dal testo unico del 2024.', status: { text: 'Superato', tone: 'neutral' } }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'contratto collettivo lavoro igiene ambientale fise assoambiente utilitalia', // allow-italian: fixture data, shown as written
};

/* ---------- SARIM's own documents ---------- */

const QUALITY_CHARTER: KnowledgeDoc = {
  id: 'carta-qualita-agropoli', collection: 'azienda', label: 'Carta della qualità, Agropoli', // allow-italian: fixture data, shown as written
  title: 'Carta della qualità dei servizi di igiene urbana, Comune di Agropoli', // allow-italian: fixture data, shown as written
  subtitle: 'Novembre 2024, sul portale ARERA di SARIM', // allow-italian: fixture data, shown as written
  issuer: 'SARIM e Comune di Agropoli', // allow-italian: fixture data, shown as written
  url: 'https://sarimambiente-arera.com/wp-content/uploads/2024/12/Carta-della-qualita-dei-servizi-Agropoli-agg.-11.24-1.pdf', host: 'sarimambiente-arera.com',
  note: 'Aggiornamento di novembre 2024; schema regolatorio I', // allow-italian: fixture data, shown as written
  status: { text: 'In vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Comune', value: 'Agropoli' }, // allow-italian: fixture data, shown as written
    { label: 'Aggiornata', value: 'novembre 2024' }, // allow-italian: fixture data, shown as written
    { label: 'Schema', value: 'I della matrice ARERA' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: '3-3', short: '§ 3.3', heading: '§ 3.3 · Scelta dello schema di servizio', // allow-italian: fixture data, shown as written
      quote: 'L’Ente Territorialmente Competente ha individuato il posizionamento della gestione dei rifiuti urbani all’interno dello SCHEMA I', // allow-italian: fixture data, shown as written
      summary: 'Agropoli sta nello schema I: valgono gli obblighi di servizio dello schema I del TQRIF.', // allow-italian: fixture data, shown as written
      keywords: 'schema regolatorio matrice agropoli', // allow-italian: fixture data, shown as written
    },
    {
      id: '3-5-1', short: '§ 3.5.1', heading: '§ 3.5.1 · Raccolta dei rifiuti urbani: ingombranti a domicilio', // allow-italian: fixture data, shown as written
      quote: 'Servizio gratuito, per le utenze domestiche, per i ritiri al piano stradale di rifiuti ingombranti.', // allow-italian: fixture data, shown as written
      summary: 'Ad Agropoli il ritiro degli ingombranti è gratuito per le utenze domestiche, su appuntamento, prenotando al numero verde.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'card', id: 'SG-4132', why: 'Prenotazione 7731 di Via Piave, Agropoli' }], // allow-italian: fixture data, shown as written
      keywords: 'ingombranti gratuito domestiche appuntamento numero verde agropoli', // allow-italian: fixture data, shown as written
    },
    {
      id: '3-7-2', short: '§ 3.7.2', heading: '§ 3.7.2 · Ritiro su chiamata', // allow-italian: fixture data, shown as written
      quote: 'La SARIM S.r.l. garantisce all’utente il ritiro dei rifiuti ingombranti a domicilio senza oneri aggiuntivi.', // allow-italian: fixture data, shown as written
      summary: 'È l\'impegno che la Carta prende in base al TQRIF: ritiro a domicilio senza costi, nei tempi del ritiro su chiamata.', // allow-italian: fixture data, shown as written
      rests: ['arera-tqrif/art-29-2', 'arera-tqrif/art-31-1'],
      citedBy: [{ kind: 'card', id: 'SG-4132', why: 'Ritiro proposto per martedì 10/11, senza costi per l\'utente' }], // allow-italian: fixture data, shown as written
      keywords: 'ritiro su chiamata ingombranti senza oneri domicilio', // allow-italian: fixture data, shown as written
    },
    {
      id: '3-7-3', short: '§ 3.7.3', heading: '§ 3.7.3 · Disservizi e riparazione delle attrezzature', // allow-italian: fixture data, shown as written
      quote: 'Le segnalazioni per disservizi potranno essere presentate dall’utente alla SARIM S.r.l., a mezzo posta, via e-mail o tramite Numero Verde.', // allow-italian: fixture data, shown as written
      summary: 'I canali che la Carta promette sono posta, email e numero verde: una segnalazione arrivata da uno di questi entra nel flusso.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-segnalazioni', at: 's1', why: 'Le segnalazioni arrivano dai canali della Carta' }], // allow-italian: fixture data, shown as written
      keywords: 'disservizi riparazione attrezzature canali numero verde', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-1124', label: 'Aggiornamento di novembre 2024', detail: 'Pubblicata sul portale ARERA di SARIM, scheda di Agropoli.', status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'carta qualità agropoli servizi igiene urbana', // allow-italian: fixture data, shown as written
};

const DECLARATION_URL = 'https://sarimambiente.it/wp-content/uploads/2026/07/DA-SARIM-convalidato-RINA_29.06.2026.pdf';

const CERTIFICATIONS: KnowledgeDoc = {
  id: 'certificazioni', collection: 'azienda', label: 'Certificazioni e registrazioni', // allow-italian: fixture data, shown as written
  title: 'Certificazioni, registrazione EMAS e rating di legalità', // allow-italian: fixture data, shown as written
  subtitle: 'Dalla pagina Certificazioni di sarimambiente.it', // allow-italian: fixture data, shown as written
  issuer: 'SARIM', url: 'https://sarimambiente.it/certificazioni/', host: 'sarimambiente.it', // allow-italian: fixture data, shown as written
  note: 'ISO 37001 scade il 21/12/2026, SA 8000 il 01/03/2028', // allow-italian: fixture data, shown as written
  status: { text: 'Valide', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Sistemi ISO', value: '9001, 14001, 45001, 37001' }, // allow-italian: fixture data, shown as written
    { label: 'EMAS', value: 'IT-001690' }, // allow-italian: fixture data, shown as written
    { label: 'Rating di legalità', value: 'RT 7468, tre stelle' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'iso', short: 'ISO', heading: 'ISO 9001, 14001, 45001 e 37001', // allow-italian: fixture data, shown as written
      quote: 'Certificazione che attesta la qualità dell’organizzazione e dei processi aziendali.', // allow-italian: fixture data, shown as written
      summary: 'Qualità (9001), ambiente (14001), salute e sicurezza (45001), anticorruzione (37001). Il certificato 37001 pubblicato scade il 21/12/2026: da tenere presente per le gare del 2027.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'certificazioni valide alla scadenza delle offerte', flow: 'sarim-gara', step: 's4' }], // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-gara', at: 's4', why: 'Il Legale controlla i requisiti della gara' }], // allow-italian: fixture data, shown as written
      keywords: 'iso 9001 14001 45001 37001 qualità ambiente sicurezza anticorruzione certificato', // allow-italian: fixture data, shown as written
    },
    {
      id: 'sa8000', short: 'SA 8000', heading: 'SA 8000 e UNI/PdR 125', // allow-italian: fixture data, shown as written
      quote: 'Certificazione che attesta il nostro comportamento eticamente corretto nei confronti dei lavoratori.', // allow-italian: fixture data, shown as written
      summary: 'Responsabilità sociale (SA 8000, scade il 01/03/2028) e parità di genere (UNI/PdR 125).', // allow-italian: fixture data, shown as written
      keywords: 'sa8000 responsabilità sociale parità di genere pdr 125', // allow-italian: fixture data, shown as written
    },
    {
      id: 'emas', short: 'EMAS', heading: 'Registrazione EMAS IT-001690', // allow-italian: fixture data, shown as written
      quote: 'Certificato di Registrazione Emas N. IT – 001690', // allow-italian: fixture data, shown as written; allow-emdash: copied as printed on sarimambiente.it
      summary: 'La Dichiarazione Ambientale 2025 è convalidata da RINA il 29/06/2026.', // allow-italian: fixture data, shown as written
      keywords: 'emas dichiarazione ambientale rina', // allow-italian: fixture data, shown as written
    },
    {
      id: 'rating', short: 'Rating', heading: 'Rating di legalità AGCM', // allow-italian: fixture data, shown as written
      quote: 'Rating di legalità – RT 7468 ★★★', // allow-italian: fixture data, shown as written; allow-emdash: copied as printed on sarimambiente.it
      summary: "Tre stelle; l'AGCM ne ha deliberato il rinnovo il 28/07/2026, per tre anni.", // allow-italian: fixture data, shown as written
      keywords: 'rating legalità agcm stelle', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-page', label: 'Pagina Certificazioni, novembre 2026', detail: 'Con i PDF dei certificati pubblicati dall\'azienda.', status: { text: 'Aggiornata', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'certificazioni iso emas rating', // allow-italian: fixture data, shown as written
};

const REGISTER: KnowledgeDoc = {
  id: 'albo-gestori', collection: 'azienda', label: 'Albo Gestori NA00165', // allow-italian: fixture data, shown as written
  title: "Iscrizione all'Albo Nazionale Gestori Ambientali, sezione Campania", // allow-italian: fixture data, shown as written
  subtitle: 'N. NA00165, dalla Dichiarazione Ambientale convalidata da RINA', // allow-italian: fixture data, shown as written
  issuer: 'Albo Nazionale Gestori Ambientali', url: DECLARATION_URL, host: 'sarimambiente.it', // allow-italian: fixture data, shown as written
  note: 'Dichiarazione Ambientale, revisione del 18/06/2026', // allow-italian: fixture data, shown as written
  status: { text: 'Iscritta', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Numero', value: 'NA00165' }, // allow-italian: fixture data, shown as written
    { label: 'Sezione', value: 'Campania' }, // allow-italian: fixture data, shown as written
    { label: 'Categorie', value: '1 A, 2bis, 4 B, 5 D, 8 C' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'iscrizione', short: 'Iscrizione', heading: 'Iscrizione', // allow-italian: fixture data, shown as written
      quote: 'S.A.R.I.M. srl è autorizzata dall’Albo Nazionale Gestori Ambientali sez. Campania ai sensi del Dlgs 152/06 n° iscrizione NA00165', // allow-italian: fixture data, shown as written
      summary: 'Il numero va su ogni formulario dove SARIM è trasportatore e in ogni offerta di gara.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'numero di iscrizione sul formulario', flow: 'sarim-fir', step: 's1' }], // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-fir', at: 's5', why: 'Il customer service controlla i dati del trasportatore' }], // allow-italian: fixture data, shown as written
      keywords: 'albo gestori ambientali iscrizione trasportatore numero', // allow-italian: fixture data, shown as written
    },
    {
      id: 'categorie', short: 'Categorie', heading: 'Categorie e classi', // allow-italian: fixture data, shown as written
      summary: 'Categoria 1 classe A, con le sottocategorie spazzamento meccanizzato e centri di raccolta; 2bis; 4 classe B; 5 classe D; 8 classe C. In gara si confronta con la categoria e la classe chieste dal bando.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'categoria e classe chieste dal bando', flow: 'sarim-gara', step: 's4' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'card', id: 'GA-030', why: 'Il bando chiede la categoria 1, classe D' }, // allow-italian: fixture data, shown as written
        { kind: 'flow', id: 'sarim-gara', at: 's4', why: 'Il Legale controlla i requisiti' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'categoria classe requisito gara spazzamento centri di raccolta', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-da', label: 'Dichiarazione Ambientale 2025, convalidata il 29/06/2026', detail: 'Il documento pubblico che riporta iscrizione e categorie.', status: { text: 'Valida', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'albo gestori na00165 iscrizione categorie', // allow-italian: fixture data, shown as written
};

const PORTAL: KnowledgeDoc = {
  id: 'portale-arera', collection: 'azienda', label: 'Portale trasparenza ARERA', // allow-italian: fixture data, shown as written
  title: 'Portale della trasparenza ARERA di SARIM', // allow-italian: fixture data, shown as written
  subtitle: 'Una scheda per comune, come chiede il TITR', // allow-italian: fixture data, shown as written
  issuer: 'SARIM', url: 'https://sarimambiente-arera.com/home/comuni/agropoli/', host: 'sarimambiente-arera.com', // allow-italian: fixture data, shown as written
  note: 'Scheda di Agropoli letta il 6/11/2026', // allow-italian: fixture data, shown as written
  status: { text: 'Online', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Numero verde', value: '800.983850' }, // allow-italian: fixture data, shown as written
    { label: 'Pronto intervento', value: 'lun-ven 9-13 e 14-17:30, sabato 9-13 (voce 3.1T)' }, // allow-italian: fixture data, shown as written
    { label: 'Comuni sul portale', value: '19, una scheda ciascuno' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'recapiti', short: 'Recapiti', heading: 'Recapiti e numero verde', // allow-italian: fixture data, shown as written
      quote: 'Tel. 800.983850', // allow-italian: fixture data, shown as written
      summary: "Nella scheda di Agropoli, alla voce 3.1T (pronto intervento), il numero 800.983850 risponde dal lunedì al venerdì dalle 9 alle 13 e dalle 14 alle 17:30, il sabato dalle 9 alle 13. L'intestazione del portale lo indica attivo dalle 8 alle 19.", // allow-italian: fixture data, shown as written
      keywords: 'numero verde orari recapiti telefono', // allow-italian: fixture data, shown as written
    },
    {
      id: 'schede', short: 'Schede', heading: 'Le sezioni della scheda di un comune', // allow-italian: fixture data, shown as written
      summary: 'Le sezioni seguono le lettere dell\'art. 3.1 del TITR: si va da 3.1A Gestori a 3.1T Pronto intervento, con la Carta della qualità alla 3.1G.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-segnalazioni', at: 's7', why: 'La risposta a chi ha segnalato rimanda ai calendari della scheda' }], // allow-italian: fixture data, shown as written
      keywords: 'scheda comune calendario moduli reclami differenziata pronto intervento', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-online', label: 'Scheda di Agropoli, letta il 6/11/2026', detail: 'Il portale lo tiene aggiornato SARIM.', status: { text: 'Online', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'portale arera trasparenza schede comuni', // allow-italian: fixture data, shown as written
};

/* ---------- internal procedures (examples) ---------- */

const PROC_REPORTS: KnowledgeDoc = {
  id: 'proc-segnalazioni', collection: 'procedure', label: 'Verifica di una segnalazione AMA', // allow-italian: fixture data, shown as written
  title: 'Come si verifica una segnalazione AMA', // allow-italian: fixture data, shown as written
  subtitle: 'Segnalazioni di AMA sui servizi di Roma: utenze non domestiche, foglie, Smart Leaf', // allow-italian: fixture data, shown as written
  issuer: 'SARIM, Customer service e Call center', // allow-italian: fixture data, shown as written
  note: "Scritta dall'agente segnalazioni il 04/11 da 31 segnalazioni chiuse a ottobre", // allow-italian: fixture data, shown as written
  status: { text: "scritta dall'agente, da approvare", tone: 'amber' }, // allow-italian: fixture data, shown as written
  facts: [],
  procedure: {
    writtenBy: 'ag-segnalazioni', writtenAt: '2026-11-04', state: 'draft', approver: 'sarim-dg', area: 'customer',
    flows: ['sarim-segnalazioni'], programs: ['Posta e PEC', 'SAP', 'WinWaste'], // allow-italian: fixture data, shown as written
    time: 'circa 12 minuti a segnalazione', // allow-italian: fixture data, shown as written
    basedOn: '31 segnalazioni AMA chiuse a ottobre', // allow-italian: fixture data, shown as written
    mistakes: "Chiudere la segnalazione senza l'ora del passaggio; rispondere ad AMA prima che il call center abbia confermato; trattare come nuova una segnalazione già aperta per lo stesso indirizzo.", // allow-italian: fixture data, shown as written
  },
  parts: [
    {
      id: 's1', short: 'Passo 1', heading: 'Passo 1 · Leggere la segnalazione', // allow-italian: fixture data, shown as written
      summary: "Dalla mail AMA l'agente legge numero, municipio, indirizzo, codice dell'utenza, frazione e giro previsto. Se manca un dato non lo inventa: lo segna da chiedere.", // allow-italian: fixture data, shown as written
      rests: ['arera-tqrif/art-32-1', 'contract:c-smart-leaf/art-6'],
      citedBy: [{ kind: 'flow', id: 'sarim-segnalazioni', at: 's1', why: 'Il passo del flusso che lo applica' }, { kind: 'card', id: 'SG-4131', why: 'Segnalazione AMA 18452, appena letta' }], // allow-italian: fixture data, shown as written
      keywords: 'leggere mail ama municipio utenza frazione', // allow-italian: fixture data, shown as written
    },
    {
      id: 's2', short: 'Passo 2', heading: 'Passo 2 · Cercare i doppioni', // allow-italian: fixture data, shown as written
      summary: 'Stesso indirizzo entro 50 metri negli ultimi 7 giorni: la nuova segnalazione si unisce a quella aperta, non apre un secondo intervento.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-segnalazioni', at: 's2', why: 'La regola dei doppioni' }, { kind: 'card', id: 'SG-4130', why: 'Doppione di Via Matteotti, Sarno' }], // allow-italian: fixture data, shown as written
      keywords: 'doppione stesso indirizzo 50 metri 7 giorni', // allow-italian: fixture data, shown as written
    },
    {
      id: 's3', short: 'Passo 3', heading: 'Passo 3 · Controllare il giro in WinWaste', // allow-italian: fixture data, shown as written
      summary: "Il passaggio era in programma? È stato fatto, a che ora, con quale mezzo? Se il giro risulta fatto, la segnalazione va al call center con le prove prima di rispondere.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'card', id: 'SG-4128', why: 'Foglie non raccolte in Viale dei Colli Portuensi: il passaggio va controllato' }], // allow-italian: fixture data, shown as written
      keywords: 'winwaste giro programmato passaggio mezzo ora', // allow-italian: fixture data, shown as written
    },
    {
      id: 's4', short: 'Passo 4', heading: 'Passo 4 · Proporre il recupero', // allow-italian: fixture data, shown as written
      summary: "Nel porta a porta il recupero va fatto entro 24 ore; per AMA la segnalazione si chiude entro 24 ore. L'agente propone il primo giro utile del cantiere di zona, con turno e mezzo.", // allow-italian: fixture data, shown as written
      rests: ['arera-tqrif/art-37-2', 'contract:c-smart-leaf/art-6', 'contract:c-smart-leaf/art-7'],
      citedBy: [{ kind: 'flow', id: 'sarim-segnalazioni', at: 's3', why: 'Proposta di turno e mezzo' }, { kind: 'card', id: 'SG-4131', why: 'Organico non ritirato in Via Prenestina 312' }], // allow-italian: fixture data, shown as written
      keywords: 'recupero 24 ore turno mezzo cantiere proposta', // allow-italian: fixture data, shown as written
    },
    {
      id: 's5', short: 'Passo 5', heading: 'Passo 5 · Conferma del call center', // allow-italian: fixture data, shown as written
      summary: "L'operatrice controlla quello che l'agente ha letto e proposto e lo conferma; un intervento fuori giro lo approva il responsabile tecnico. L'agente non risponde ad AMA da solo.", // allow-italian: fixture data, shown as written
      rests: ['arera-tqrif/art-33-1'],
      citedBy: [{ kind: 'flow', id: 'sarim-segnalazioni', at: 's5', why: 'Verifica del call center' }, { kind: 'flow', id: 'sarim-segnalazioni', at: 's6', why: 'Approvazione degli interventi fuori giro' }], // allow-italian: fixture data, shown as written
      keywords: 'conferma call center verifica approva fuori giro', // allow-italian: fixture data, shown as written
    },
    {
      id: 's6', short: 'Passo 6', heading: 'Passo 6 · Rispondere ad AMA e chiudere', // allow-italian: fixture data, shown as written
      summary: "Risposta ad AMA con l'ora del passaggio, ordine di servizio in SAP, giro aggiornato in WinWaste. La segnalazione resta aperta finché il passaggio non risulta fatto.", // allow-italian: fixture data, shown as written
      rests: ['portale-arera/schede'], // allow-italian: a reference id, not shown
      citedBy: [{ kind: 'flow', id: 'sarim-segnalazioni', at: 's7', why: 'Chiusura in SAP e avviso a chi ha segnalato' }, { kind: 'card', id: 'SG-4118', why: 'Vetro di Montecorvino Rovella, chiusa' }], // allow-italian: fixture data, shown as written
      keywords: 'risposta ama chiusura sap ordine di servizio', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v1', label: 'Versione 1', detail: "Scritta dall'agente segnalazioni il 04/11 alle 18:20.", status: { text: 'Da approvare', tone: 'amber' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'procedura segnalazione ama verifica roma utenze non domestiche', // allow-italian: fixture data, shown as written
};

const PROC_FORMS: KnowledgeDoc = {
  id: 'proc-fir', collection: 'procedure', label: 'FIR e RENTRI passo per passo', // allow-italian: fixture data, shown as written
  title: 'FIR e RENTRI passo per passo', // allow-italian: fixture data, shown as written
  subtitle: 'Dal formulario del ritiro alla registrazione trasmessa', // allow-italian: fixture data, shown as written
  issuer: 'SARIM, Customer service e Tecnica', // allow-italian: fixture data, shown as written
  note: 'Approvata dalla Direzione il 22/10', // allow-italian: fixture data, shown as written
  status: { text: 'Approvata', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [],
  procedure: {
    writtenBy: 'ag-fir', writtenAt: '2026-10-15', state: 'approved', approver: 'sarim-dg', approvedAt: '2026-10-22', area: 'customer',
    flows: ['sarim-fir'], programs: ['Enviro', 'RENTRI'], // allow-italian: fixture data, shown as written
    time: 'circa 6 minuti a formulario', // allow-italian: fixture data, shown as written
    basedOn: '120 formulari chiusi a settembre', // allow-italian: fixture data, shown as written
    mistakes: 'Registrare il peso stimato al posto di quello verificato a destino; trasmettere senza la copia firmata dal destinatario; dimenticare il numero di iscrizione all\'Albo.', // allow-italian: fixture data, shown as written
  },
  parts: [
    {
      id: 's1', short: 'Passo 1', heading: 'Passo 1 · Il formulario del ritiro', // allow-italian: fixture data, shown as written
      summary: "Ogni trasporto ha il suo FIR. Se lo compila SARIM come trasportatore, lo fa su richiesta del produttore; il formulario riporta l'iscrizione NA00165.", // allow-italian: fixture data, shown as written
      rests: ['dlgs-152-2006/art-193-c1', 'dm-59-2023/art-5', 'albo-gestori/iscrizione'],
      citedBy: [{ kind: 'flow', id: 'sarim-fir', at: 's1', why: 'Lettura del formulario' }, { kind: 'card', id: 'FIR-0941', why: 'Formulario organico di Castellabate' }], // allow-italian: fixture data, shown as written
      keywords: 'formulario ritiro trasportatore richiesta produttore', // allow-italian: fixture data, shown as written
    },
    {
      id: 's2', short: 'Passo 2', heading: 'Passo 2 · Il codice univoco', // allow-italian: fixture data, shown as written
      summary: 'Il formulario prende il codice univoco della vidimazione digitale prima di partire, cartaceo o digitale che sia.', // allow-italian: fixture data, shown as written
      rests: ['dm-59-2023/art-7', 'dm-59-2023/art-6'],
      keywords: 'codice univoco vidimazione partenza', // allow-italian: fixture data, shown as written
    },
    {
      id: 's3', short: 'Passo 3', heading: 'Passo 3 · Il peso a destino', // allow-italian: fixture data, shown as written
      summary: "Si registra il peso verificato all'impianto, dalla copia firmata dal destinatario. Se è più del 5% sopra o sotto la stima, l'agente lo porta al customer service.", // allow-italian: fixture data, shown as written
      rests: ['dm-59-2023/art-6'],
      citedBy: [{ kind: 'flow', id: 'sarim-fir', at: 's3', why: 'Confronto fra peso a destino e stima' }, { kind: 'card', id: 'FIR-0938', why: '8.420 kg contro 7.900 stimati' }, { kind: 'card', id: 'FIR-0936', why: 'Manca il peso verificato' }], // allow-italian: fixture data, shown as written
      keywords: 'peso destino verificato stima differenza cinque per cento', // allow-italian: fixture data, shown as written
    },
    {
      id: 's4', short: 'Passo 4', heading: 'Passo 4 · La registrazione di carico e scarico', // allow-italian: fixture data, shown as written
      summary: "L'agente prepara la registrazione con i dati del formulario: codice EER, quantità, impianto, data. Il customer service controlla codici e pesi.", // allow-italian: fixture data, shown as written
      rests: ['dm-59-2023/art-4', 'dlgs-152-2006/art-188bis'],
      citedBy: [{ kind: 'flow', id: 'sarim-fir', at: 's4', why: 'Registrazione preparata per il RENTRI' }, { kind: 'flow', id: 'sarim-fir', at: 's5', why: 'Controllo di codici e pesi' }, { kind: 'card', id: 'FIR-0935', why: 'Foglie con terra: quale codice EER' }], // allow-italian: fixture data, shown as written
      keywords: 'registrazione carico scarico codice eer quantità', // allow-italian: fixture data, shown as written
    },
    {
      id: 's5', short: 'Passo 5', heading: 'Passo 5 · Firma e trasmissione', // allow-italian: fixture data, shown as written
      summary: 'Il responsabile tecnico firma la registrazione; poi parte verso il RENTRI e il formulario si archivia. Nessuna trasmissione senza la firma di una persona.', // allow-italian: fixture data, shown as written
      rests: ['dlgs-152-2006/art-193-c2'],
      citedBy: [{ kind: 'flow', id: 'sarim-fir', at: 's6', why: 'Firma del responsabile tecnico' }, { kind: 'flow', id: 'sarim-fir', at: 's7', why: 'Trasmissione e archivio' }, { kind: 'card', id: 'FIR-0933', why: 'Ingombranti di Pontecagnano Faiano, alla firma' }], // allow-italian: fixture data, shown as written
      keywords: 'firma trasmissione rentri archivio responsabile tecnico', // allow-italian: fixture data, shown as written
    },
    {
      id: 's6', short: 'Passo 6', heading: 'Passo 6 · Il rendiconto al Comune', // allow-italian: fixture data, shown as written
      summary: 'Ogni mese i quantitativi per codice EER vanno al Comune con i formulari e le registrazioni, nei termini del contratto.', // allow-italian: fixture data, shown as written
      rests: ['contract:c-albanella/art-5'],
      citedBy: [{ kind: 'contract', id: 'c-albanella', at: 'art-5', why: 'Quantitativi entro il 15 di ogni mese' }], // allow-italian: fixture data, shown as written
      keywords: 'rendiconto mensile comune quantitativi eer', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v2', label: 'Versione 2', detail: 'Approvata dalla Direzione il 22/10: aggiunto il passo del codice univoco.', status: { text: 'Approvata', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
    { id: 'v1', label: 'Versione 1', detail: "Scritta dall'agente FIR e RENTRI il 15/10.", status: { text: 'Superata', tone: 'neutral' } }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'procedura formulario fir rentri registrazione', // allow-italian: fixture data, shown as written
};

const PROC_INVOICES: KnowledgeDoc = {
  id: 'proc-fatture', collection: 'procedure', label: 'Fattura passiva e riconciliazione', // allow-italian: fixture data, shown as written
  title: 'Fattura passiva e riconciliazione bancaria', // allow-italian: fixture data, shown as written
  subtitle: 'Dalla fattura dello SDI al movimento in banca', // allow-italian: fixture data, shown as written
  issuer: 'SARIM, Contabile e Finanziaria', // allow-italian: fixture data, shown as written
  note: "Scritta dall'agente fatture il 05/11 da 64 fatture di ottobre", // allow-italian: fixture data, shown as written
  status: { text: "scritta dall'agente, da approvare", tone: 'amber' }, // allow-italian: fixture data, shown as written
  facts: [],
  procedure: {
    writtenBy: 'ag-fatture', writtenAt: '2026-11-05', state: 'draft', approver: 'sarim-dg', area: 'contabilita',
    flows: ['sarim-fatture'], programs: ['Posta e PEC', 'Excel'], // allow-italian: fixture data, shown as written
    time: 'circa 8 minuti a fattura', // allow-italian: fixture data, shown as written
    basedOn: '64 fatture passive di ottobre', // allow-italian: fixture data, shown as written
    mistakes: 'Pagare una fattura senza ordine né contratto; non trattenere la penale scritta nel contratto; pagare un subappaltatore senza DURC valido.', // allow-italian: fixture data, shown as written
  },
  parts: [
    {
      id: 's1', short: 'Passo 1', heading: 'Passo 1 · Leggere la fattura', // allow-italian: fixture data, shown as written
      summary: "Fornitore, righe, imponibile, IVA e totale dalla fattura elettronica; l'agente controlla che i conti tornino.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-fatture', at: 's1', why: 'Lettura della fattura elettronica' }, { kind: 'card', id: 'FT-2615', why: 'Pneumatici per i compattatori' }], // allow-italian: fixture data, shown as written
      keywords: 'fattura elettronica sdi imponibile iva totale', // allow-italian: fixture data, shown as written
    },
    {
      id: 's2', short: 'Passo 2', heading: 'Passo 2 · Abbinare ordine, contratto e bolla', // allow-italian: fixture data, shown as written
      summary: 'Ogni fattura si abbina a un ordine o a un contratto e alla bolla di consegna. Senza ordine la fattura si ferma e la contabilità chiede chi l\'ha ordinata.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-fatture', at: 's2', why: 'Abbinamento' }, { kind: 'card', id: 'FT-2609', why: 'Ricambi senza ordine' }, { kind: 'card', id: 'FT-2607', why: 'Bolla di 380 mastelli, fattura di 400' }], // allow-italian: fixture data, shown as written
      keywords: 'ordine bolla contratto abbinamento quantità', // allow-italian: fixture data, shown as written
    },
    {
      id: 's3', short: 'Passo 3', heading: 'Passo 3 · Prezzo e penali dal contratto', // allow-italian: fixture data, shown as written
      summary: 'Il prezzo si controlla con la clausola del contratto; una penale scritta nel contratto si trattiene in fattura, con la clausola citata.', // allow-italian: fixture data, shown as written
      rests: ['contract:c-carburante/art-5', 'contract:c-officina/art-6'],
      citedBy: [{ kind: 'flow', id: 'sarim-fatture', at: 's3', why: 'Controllo di prezzi e quantità' }, { kind: 'card', id: 'FT-2611', why: 'Gasolio sopra il prezzo di contratto' }, { kind: 'card', id: 'FT-2604', why: 'Penale per il fermo del compattatore' }], // allow-italian: fixture data, shown as written
      keywords: 'prezzo contratto penale trattenuta clausola', // allow-italian: fixture data, shown as written
    },
    {
      id: 's4', short: 'Passo 4', heading: 'Passo 4 · DURC del subappaltatore', // allow-italian: fixture data, shown as written
      summary: 'Prima di pagare un subappaltatore serve il DURC valido: SARIM risponde in solido con lui.', // allow-italian: fixture data, shown as written
      rests: ['dlgs-36-2023/art-119-c6', 'contract:c-sub-lavaggio/art-5'],
      keywords: 'durc subappaltatore pagamento solido', // allow-italian: fixture data, shown as written
    },
    {
      id: 's5', short: 'Passo 5', heading: 'Passo 5 · Approvare e pagare', // allow-italian: fixture data, shown as written
      summary: "La contabilità controlla le differenze; un pagamento con differenze o trattenute lo approva la Direzione. L'agente non dispone pagamenti.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-fatture', at: 's5', why: 'Verifica delle differenze' }, { kind: 'flow', id: 'sarim-fatture', at: 's6', why: 'Approvazione della Direzione' }], // allow-italian: fixture data, shown as written
      keywords: 'approvazione pagamento direzione differenze', // allow-italian: fixture data, shown as written
    },
    {
      id: 's6', short: 'Passo 6', heading: 'Passo 6 · Riconciliazione con la banca', // allow-italian: fixture data, shown as written
      summary: "L'agente abbina il bonifico al movimento in banca e chiude la riconciliazione; un importo diverso torna alla contabilità.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-fatture', at: 's7', why: 'Riconciliazione' }, { kind: 'card', id: 'FT-2601', why: 'Lubrificanti di ottobre, riconciliata' }], // allow-italian: fixture data, shown as written
      keywords: 'riconciliazione bancaria bonifico movimento banca', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v1', label: 'Versione 1', detail: "Scritta dall'agente fatture il 05/11 alle 17:05.", status: { text: 'Da approvare', tone: 'amber' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'procedura fattura passiva riconciliazione bancaria pagamento', // allow-italian: fixture data, shown as written
};

const PROC_TENDERS: KnowledgeDoc = {
  id: 'proc-gare', collection: 'procedure', label: 'Valutazione preliminare di una gara', // allow-italian: fixture data, shown as written
  title: 'Valutazione preliminare di una gara', // allow-italian: fixture data, shown as written
  subtitle: 'Dal bando alla decisione di partecipare', // allow-italian: fixture data, shown as written
  issuer: 'SARIM, Gare e Legale', // allow-italian: fixture data, shown as written
  note: 'Approvata da Gare e Legale il 15/10', // allow-italian: fixture data, shown as written
  status: { text: 'Approvata', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [],
  procedure: {
    writtenBy: 'ag-gare', writtenAt: '2026-10-08', state: 'approved', approver: 'sarim-bruno', approvedAt: '2026-10-15', area: 'legale',
    flows: ['sarim-gara'], programs: ['portali gare / Innova', 'Word'], // allow-italian: fixture data, shown as written
    time: 'circa 2 ore a gara', // allow-italian: fixture data, shown as written
    basedOn: '9 gare valutate fra luglio e settembre', // allow-italian: fixture data, shown as written
    mistakes: 'Leggere il bando senza il capitolato; dimenticare il personale da assorbire; scoprire tardi che un servizio da subappaltare non era indicato in offerta.', // allow-italian: fixture data, shown as written
  },
  parts: [
    {
      id: 's1', short: 'Passo 1', heading: 'Passo 1 · Bando e disciplinare', // allow-italian: fixture data, shown as written
      summary: "L'agente legge bando, disciplinare e capitolato: oggetto, importo, durata, scadenza delle offerte. Se i documenti non dicono la stessa cosa, segna il chiarimento da chiedere.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-gara', at: 's1', why: 'Lettura dei documenti di gara' }, { kind: 'card', id: 'GA-031', why: 'Manca il chiarimento sul numero di utenze' }], // allow-italian: fixture data, shown as written
      keywords: 'bando disciplinare capitolato importo durata scadenza chiarimento', // allow-italian: fixture data, shown as written
    },
    {
      id: 's2', short: 'Passo 2', heading: 'Passo 2 · Requisiti: Albo e certificazioni', // allow-italian: fixture data, shown as written
      summary: 'Categoria e classe chieste si confrontano con l\'iscrizione NA00165; le certificazioni chieste con quelle valide alla scadenza delle offerte.', // allow-italian: fixture data, shown as written
      rests: ['albo-gestori/categorie', 'certificazioni/iso'],
      citedBy: [{ kind: 'card', id: 'GA-030', why: 'Categoria 1, classe D' }], // allow-italian: fixture data, shown as written
      keywords: 'requisiti albo categoria classe certificazioni', // allow-italian: fixture data, shown as written
    },
    {
      id: 's3', short: 'Passo 3', heading: 'Passo 3 · Personale e CCNL', // allow-italian: fixture data, shown as written
      summary: 'Quanti addetti del gestore uscente si assorbono e con quale CCNL: è il costo che pesa di più sul margine.', // allow-italian: fixture data, shown as written
      rests: ['ccnl-servizi-ambientali/art-6-c3'],
      citedBy: [{ kind: 'flow', id: 'sarim-gara', at: 's2', why: 'Scheda di valutazione' }, { kind: 'card', id: 'GA-033', why: '23 addetti da assorbire' }], // allow-italian: fixture data, shown as written
      keywords: 'personale assorbire ccnl clausola sociale costo manodopera', // allow-italian: fixture data, shown as written
    },
    {
      id: 's4', short: 'Passo 4', heading: 'Passo 4 · Subappalti da indicare', // allow-italian: fixture data, shown as written
      summary: "Se un servizio si vuole subappaltare (lavaggio, manutenzione del verde) va scritto nell'offerta: dopo non si può.", // allow-italian: fixture data, shown as written
      rests: ['dlgs-36-2023/art-119-c4'],
      keywords: 'subappalto offerta indicare servizi', // allow-italian: fixture data, shown as written
    },
    {
      id: 's5', short: 'Passo 5', heading: 'Passo 5 · Mezzi, distanza e margine', // allow-italian: fixture data, shown as written
      summary: 'La Tecnica stima mezzi, personale, distanza dai cantieri e costi; con il margine stimato la scheda va al Legale e poi alla Direzione.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-gara', at: 's3', why: 'Stima della Tecnica' }, { kind: 'card', id: 'GA-027', why: 'Gara scartata: troppo lontana dai cantieri' }], // allow-italian: fixture data, shown as written
      keywords: 'mezzi distanza cantieri margine costi tecnica', // allow-italian: fixture data, shown as written
    },
    {
      id: 's6', short: 'Passo 6', heading: 'Passo 6 · Decisione', // allow-italian: fixture data, shown as written
      summary: "Il Legale controlla requisiti, garanzie e clausole; la Direzione decide se partecipare. L'agente mette le scadenze in calendario o archivia la gara.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'sarim-gara', at: 's5', why: 'Decisione della Direzione' }, { kind: 'card', id: 'GA-029', why: 'Castelli Romani: aspetta la Direzione' }], // allow-italian: fixture data, shown as written
      keywords: 'decisione partecipare direzione legale garanzie', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v1', label: 'Versione 1', detail: "Scritta dall'agente gare l'08/10, approvata da Gare e Legale il 15/10.", status: { text: 'Approvata', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'procedura gara valutazione preliminare bando partecipare', // allow-italian: fixture data, shown as written
};

export const SARIM_KNOWLEDGE_DOCS: KnowledgeDoc[] = [
  ENVIRONMENT_CODE, DM_59, CONTRACTS_CODE, TITR, SERVICE_QUALITY, LABOUR_AGREEMENT,
  QUALITY_CHARTER, CERTIFICATIONS, REGISTER, PORTAL,
  PROC_REPORTS, PROC_FORMS, PROC_INVOICES, PROC_TENDERS,
];

/* ---------- questions people ask ---------- */

export const SARIM_KNOWLEDGE_QUESTIONS: KnowledgeQuestion[] = [
  {
    question: 'Entro quanto va recuperato un ritiro saltato?', // allow-italian: fixture data, shown as written
    answer: [
      { text: 'Nel porta a porta il servizio non fatto si recupera entro 24 ore; nella raccolta stradale e di prossimità entro 24 o 72 ore, secondo la zona e la frazione.', source: 'arera-tqrif/art-37-2' }, // allow-italian: fixture data, shown as written
      { text: 'Se arriva come segnalazione di disservizio, il tempo di intervento è di 5 giorni lavorativi.', source: 'arera-tqrif/art-33-1' }, // allow-italian: fixture data, shown as written
      { text: "Nella procedura di SARIM l'agente propone il primo giro utile e il call center conferma.", source: 'proc-segnalazioni/s4' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    question: 'Chi può compilare il formulario FIR?', // allow-italian: fixture data, shown as written
    answer: [
      { text: 'Ogni trasporto di rifiuti fatto da enti o imprese ha il suo formulario.', source: 'dlgs-152-2006/art-193-c1' }, // allow-italian: fixture data, shown as written
      { text: 'Lo emette il produttore o il detentore; può compilarlo il trasportatore su loro richiesta, e chi lo chiede resta responsabile dei suoi dati.', source: 'dm-59-2023/art-5' }, // allow-italian: fixture data, shown as written
      { text: 'Il formulario cartaceo è in due copie: una la firma il destinatario all\'arrivo.', source: 'dm-59-2023/art-6' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    question: 'La variante di Castellabate del 4,2% si può fare senza nuova gara?', // allow-italian: fixture data, shown as written
    answer: [
      { text: "Senza nuova procedura la modifica deve stare sotto entrambi i valori: le soglie dell'art. 14 e il 10% del valore iniziale per i servizi. Il 4,2% sta sotto il 10%; il confronto con la soglia resta al Legale.", source: 'dlgs-36-2023/art-120-c3' }, // allow-italian: fixture data, shown as written
      { text: "Entro un quinto dell'importo la stazione appaltante può imporre l'esecuzione alle condizioni originarie.", source: 'dlgs-36-2023/art-120-c9' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    question: 'Entro quanto il Comune deve autorizzare un subappalto?', // allow-italian: fixture data, shown as written
    answer: [
      { text: "La stazione appaltante decide entro trenta giorni dalla richiesta, prorogabili una volta; senza risposta l'autorizzazione si intende concessa.", source: 'dlgs-36-2023/art-119-c16' }, // allow-italian: fixture data, shown as written
      { text: "Si può subappaltare solo ciò che era indicato nell'offerta.", source: 'dlgs-36-2023/art-119-c4' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    question: 'Un contratto a termine può durare più di 12 mesi?', // allow-italian: fixture data, shown as written
    answer: [
      { text: 'Sì, fino a 24 mesi, nei casi previsti dalla legge.', source: 'ccnl-servizi-ambientali/art-11-c2' }, // allow-italian: fixture data, shown as written
      { text: 'Il CCNL lo ammette anche per esigenze specifiche, tra cui un servizio definito e limitato nel tempo.', source: 'ccnl-servizi-ambientali/art-11-c3' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    question: 'Quanti ingombranti si ritirano gratis a domicilio?', // allow-italian: fixture data, shown as written
    answer: [
      { text: 'Almeno un ritiro al mese per utenza, a bordo strada, fino a cinque pezzi.', source: 'arera-tqrif/art-29-2' }, // allow-italian: fixture data, shown as written
      { text: 'Dalla richiesta al ritiro passano al massimo 15 giorni lavorativi.', source: 'arera-tqrif/art-31-1' }, // allow-italian: fixture data, shown as written
      { text: 'Ad Agropoli è gratuito per le utenze domestiche, su appuntamento al numero verde.', source: 'carta-qualita-agropoli/3-5-1' }, // allow-italian: fixture data, shown as written
    ],
  },
];
