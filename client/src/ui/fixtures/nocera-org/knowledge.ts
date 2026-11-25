/**
 * The documents the Consorzio works with, as «Conoscenza» shows them: the
 * laws and rules behind its repetitive work, the Consorzio's own papers, and
 * the internal procedures the agents wrote from the closed cards. Same shape
 * as `../orbit-org/knowledge.ts`, whose types it reuses.
 *
 * Where the words come from. A `quote` is a short passage copied, to the
 * character, from a page read on 9/11/2026: the Libro dell'anno 2025 (the PDF allow-italian: quotes the words on screen
 * on bonificasarno.it, which prints the passages of L.R. 7/2025 art. 10, the
 * Regolamento di Polizia Idraulica and the irrigation service) and the three
 * news items of the Consorzio's site (SEND, the roll of lawyers, the framework
 * agreement for engineering). Where the official text of a law was not read
 * (R.D. 368/1904, R.D. 523/1904, D.Lgs. 546/1992, D.Lgs. 33/2013, the Piano
 * di Classifica, the Regolamento itself) the part has no quote, only a
 * `summary` of what it means for the work, and the document says «testo
 * ufficiale da caricare». A `summary` is never the text of the law. The allow-italian: quotes the words on screen
 * procedures, their steps, dates and approvals are examples, coherent with the
 * flows, the contracts and the cards.
 *
 * Citations point at what exists in the other fixtures: a card id of the
 * Consorzio's cards, a flow and step of `flows.ts`, a contract and clause of
 * `contracts.ts`. A procedure step rests on parts of the other documents
 * (`<doc>/<part>`) or on a contract clause (`contract:<id>/<clause>`).
 * Cards cited here: PEC-2418, PEC-2419, PEC-2421, IR-2414, SG-2420,
 * CO-2386, VP-2395, VP-2399, RC-2404, RC-2416, FT-2412, CT-2390, CT-2398,
 * CT-2400, CT-2403, CT-2404.
 */
import type { KnowledgeCollectionDef, KnowledgeDoc, KnowledgeQuestion } from '../orbit-org/knowledge';

/* ---------- collections ---------- */

export const NOCERA_KNOWLEDGE_COLLECTIONS: KnowledgeCollectionDef[] = [
  {
    id: 'norme', label: 'Norme e regole', // allow-italian: fixture data, shown as written
    description: 'Le leggi, il regolamento e il Piano di Classifica che governano il lavoro del Consorzio: polizia idraulica, concessioni, contributo di bonifica, ricorsi e accesso agli atti.', // allow-italian: fixture data, shown as written
    viewers: 'tutti', source: "Libro dell'anno 2025 del Consorzio, Normattiva, BURC", // allow-italian: fixture data, shown as written
  },
  {
    id: 'azienda', label: 'Documenti del Consorzio', // allow-italian: fixture data, shown as written
    description: "I documenti pubblici dell'ente: il Libro dell'anno 2025 e le notizie del sito su SEND, sull'albo dei legali e sull'accordo quadro di ingegneria.", // allow-italian: fixture data, shown as written
    viewers: 'tutti', source: 'bonificasarno.it', // allow-italian: fixture data, shown as written
  },
  {
    id: 'procedure', label: 'Procedure interne', // allow-italian: fixture data, shown as written
    description: "Come si lavora, passo per passo. Le scrive l'agente dalle card chiuse e dalle norme che citano; una persona le approva prima che entrino nei flussi.", // allow-italian: fixture data, shown as written
    viewers: 'tutti', source: 'scritte dagli agenti, approvate da una persona', // allow-italian: fixture data, shown as written
  },
];

/* ---------- laws and rules ---------- */

const LIBRO_PDF = 'https://www.bonificasarno.it/site/wp-content/uploads/2026/03/web_librodellanno-2025-consorziobonifica.pdf'; // allow-italian: official address of the source, not shown as text
const NORMATTIVA = 'normattiva.it';
const SITE = 'bonificasarno.it';
const RD_368_URL = 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:regio.decreto:1904-05-08;368'; // allow-italian: official address of the source, not shown as text
const RD_523_URL = 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:regio.decreto:1904-07-25;523'; // allow-italian: official address of the source, not shown as text
const DLGS_546_URL = 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:1992-12-31;546'; // allow-italian: official address of the source, not shown as text
const DLGS_33_URL = 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2013-03-14;33'; // allow-italian: official address of the source, not shown as text

const REGIONAL_LAW_7: KnowledgeDoc = {
  id: 'lr-7-2025', collection: 'norme', label: 'L.R. Campania 7/2025', // allow-italian: fixture data, shown as written
  title: 'Legge Regionale Campania 6 giugno 2025, n. 7', // allow-italian: fixture data, shown as written
  subtitle: 'Sostituisce e abroga la L.R. 4/2003, «Nuove norme in materia di Bonifica Integrale»', // allow-italian: fixture data, shown as written
  issuer: 'Regione Campania', textUrl: LIBRO_PDF, host: SITE, // allow-italian: fixture data, shown as written
  note: "Passi letti nel Libro dell'anno 2025; il testo del BURC non è ancora caricato", // allow-italian: fixture data, shown as written
  status: { text: 'In vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Data', value: '6 giugno 2025' }, // allow-italian: fixture data, shown as written
    { label: 'Sostituisce', value: 'L.R. 4/2003' }, // allow-italian: fixture data, shown as written
    { label: 'Parti usate', value: 'artt. 2, 4, 5, 6, 9, 10, 21' }, // allow-italian: fixture data, shown as written
    { label: 'Testo letto su', value: "Libro dell'anno 2025" }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'art-2', short: 'Art. 2', heading: 'Art. 2 · Comprensori', // allow-italian: fixture data, shown as written
      quote: 'il Consorzio opera ora nel comprensorio denominato “Sarno”, comprendente i bacini Sarno, Torrenti Vesuviani e Irno', // allow-italian: fixture data, shown as written
      summary: 'I comprensori della Regione sono riordinati in otto. Per il Consorzio vale il comprensorio «Sarno», con i bacini Sarno, Torrenti Vesuviani e Irno: dentro questo perimetro decide su concessioni, polizia idraulica e manutenzione.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'Il canale o il terreno della segnalazione sono nel comprensorio Sarno', flow: 'nocera-segnalazioni', step: 's3' }], // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-segnalazioni', at: 's3', why: 'Una segnalazione fuori dal comprensorio va girata all\'ente competente' }, { kind: 'card', id: 'SG-2420', why: 'Griglia ostruita sul Canale Torello: il canale è del comprensorio' }], // allow-italian: fixture data, shown as written
      keywords: 'comprensorio sarno otto comprensori riordino bacini irno torrenti vesuviani', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-4', short: 'Art. 4', heading: 'Art. 4 · Difesa del suolo', // allow-italian: fixture data, shown as written
      quote: 'la distinzione tra “attività di bonifica” e “attività di difesa del suolo” quale nuovo ambito delegabile dalla Regione (art.4)', // allow-italian: fixture data, shown as written
      summary: 'La difesa del suolo è un ambito diverso dalla bonifica e la Regione può delegarlo ai Consorzi. Una convenzione per sistemare versanti o valloni si scrive su questo articolo, con i fondi di chi affida e non con i tributi dei consorziati.', // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'contract', id: 'ct-convenzione-difesa-suolo', at: 'art-1', why: 'La convenzione con il Comune si fonda sulla difesa del suolo delegabile' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'CT-2398', why: 'Schema di convenzione di Siano, in lettura per la difesa del suolo' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'difesa del suolo delega regione convenzione versanti vallone', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-5', short: 'Art. 5', heading: 'Art. 5 · Piano comprensoriale di bonifica', // allow-italian: fixture data, shown as written
      quote: 'il nuovo Piano comprensoriale di bonifica e di tutela del territorio (art.5), strumento di pianificazione plurisettoriale sottoposto a Valutazione Ambientale Strategica, che sostituisce il previgente piano generale di bonifica', // allow-italian: fixture data, shown as written
      summary: 'Il Piano comprensoriale sostituisce il piano generale di bonifica ed è sottoposto a VAS. Gli interventi del Consorzio si programmano in conformità al Piano.', // allow-italian: fixture data, shown as written
      keywords: 'piano comprensoriale vas valutazione ambientale strategica programmazione', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-6-c2', short: 'Art. 6 c. 2', heading: 'Art. 6, comma 2 · Opere di difesa del suolo affidate dalla Regione', // allow-italian: fixture data, shown as written
      quote: "mediante l’affidamento in concessione da parte della Regione, disciplinato da apposita convenzione che assegna contestualmente le risorse finanziarie necessarie, delle opere di cui all’art.6, comma 2 della L.R. n.7/2025", // allow-italian: fixture data, shown as written
      summary: "Le opere di difesa del suolo (stabilizzazione dei versanti, laminazione delle piene, corsi d'acqua fuori dal reticolo di bonifica) si affidano al Consorzio con una convenzione che porta con sé le risorse: senza risorse assegnate non si parte.", // allow-italian: fixture data, shown as written
      checks: [{ label: 'La convenzione dice chi paga e quando', flow: 'nocera-contratti', step: 's5' }], // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'contract', id: 'ct-convenzione-difesa-suolo', at: 'art-1', why: 'Gli interventi dell\'elenco sono opere dell\'art. 6, comma 2' }], // allow-italian: fixture data, shown as written
      keywords: 'convenzione risorse finanziarie versanti laminazione piene concessione regione', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-9-c3', short: 'Art. 9 c. 3', heading: 'Art. 9, comma 3 · Natura dei Consorzi', // allow-italian: fixture data, shown as written
      quote: 'ridefinisce i Consorzi come enti pubblici economici a carattere associativo (art.9, comma 3)', // allow-italian: fixture data, shown as written
      summary: "Il Consorzio è un ente pubblico economico a carattere associativo: l'associazione dei proprietari degli immobili che beneficiano delle opere. Opera con criteri di efficienza, efficacia, trasparenza ed economicità.", // allow-italian: fixture data, shown as written
      keywords: 'ente pubblico economico associativo consorziati proprietari natura', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-10-c1', short: 'Art. 10 c. 1', heading: 'Art. 10, comma 1 · Autosufficienza energetica', // allow-italian: fixture data, shown as written
      quote: 'il perseguimento dell’autosufficienza energetica attraverso la produzione da fonti rinnovabili (art.10, comma 1 e art.6, comma 1, lett.f)', // allow-italian: fixture data, shown as written
      summary: 'Il Consorzio può produrre energia da fonti rinnovabili per i propri impianti. Per i pozzi irrigui vuol dire impianti fotovoltaici sugli impianti di sollevamento e meno energia da comprare: il contratto di fornitura lo deve prevedere.', // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'contract', id: 'ct-energia-pozzi', at: 'art-8', why: "La quantità di energia si riduce senza penale quando un impianto fotovoltaico entra in esercizio" }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'FT-2412', why: 'Fattura di ottobre dei 55 punti di prelievo dei pozzi' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'autosufficienza energetica fotovoltaico rinnovabili energia pozzi', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-10-c2-a', short: 'Art. 10 c. 2 a)', heading: 'Art. 10, comma 2, lettera a · Vigilanza', // allow-italian: fixture data, shown as written
      quote: 'alla vigilanza sulle opere di bonifica e di irrigazione nonché sui corsi d’acqua del reticolo idrografico regionale e sulle altre opere affidate alla loro gestione', // allow-italian: fixture data, shown as written
      summary: 'Il Consorzio, nel suo comprensorio, è Autorità di Polizia Idraulica: vigila sulle opere di bonifica e di irrigazione e sui corsi d\'acqua del reticolo regionale che gestisce.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's1', why: "Il verbale nasce da una vigilanza sul posto dell'ufficiale idraulico" }], // allow-italian: fixture data, shown as written
      keywords: 'autorità polizia idraulica vigilanza opere bonifica irrigazione reticolo', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-10-c2-b', short: 'Art. 10 c. 2 b)', heading: 'Art. 10, comma 2, lettera b · Accertamento e contestazione', // allow-italian: fixture data, shown as written
      quote: 'all’accertamento e alla contestazione delle violazioni previste dalle norme di Polizia Idraulica del regio decreto 8 maggio 1904, n. 368 e successive modificazioni, per le opere di bonifica, e del R.D. 25 luglio 1904, n. 523 e successive modificazioni, per i corsi d’acqua del reticolo idrografico regionale e le altre opere ad essi affidate', // allow-italian: fixture data, shown as written
      summary: "Il verbale lo fa il Consorzio, senza aspettare la Regione. La norma violata è il R.D. 368/1904 per le opere di bonifica, il R.D. 523/1904 per i corsi d'acqua del reticolo regionale: un tratto può cadere in tutti e due.", // allow-italian: fixture data, shown as written
      checks: [{ label: 'Norma violata indicata nel verbale: R.D. 368 o R.D. 523', flow: 'nocera-polizia', step: 's6' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-polizia', at: 's5', why: "L'ufficiale idraulico controlla la norma indicata" }, // allow-italian: fixture data, shown as written
        { kind: 'flow', id: 'nocera-polizia', at: 's6', why: 'Il Legale verifica norma e sanzione' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'VP-2395', why: 'Verbale sul Torrente Lavinaio' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'accertamento contestazione violazioni verbale norma violata rd 368 rd 523', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-10-c2-c', short: 'Art. 10 c. 2 c)', heading: 'Art. 10, comma 2, lettera c · Sanzioni', // allow-italian: fixture data, shown as written
      quote: 'all’intero procedimento per l’applicazione delle relative sanzioni amministrative e pecuniarie di cui alla L.R. Campania 10 gennaio 1983, n. 13', // allow-italian: fixture data, shown as written
      summary: "L'intero procedimento per la sanzione è del Consorzio, secondo la L.R. 13/1983. I proventi vanno alla gestione e alla manutenzione delle opere vigilate: la Ragioneria li registra a quel titolo.", // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-polizia', at: 's7', why: 'La direzione firma la notifica con la sanzione' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'VP-2395', why: 'Sanzione di un verbale notificato' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'sanzioni amministrative pecuniarie procedimento proventi polizia idraulica', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-21-c1', short: 'Art. 21 c. 1', heading: 'Art. 21, comma 1 · Uso dei tributi', // allow-italian: fixture data, shown as written
      quote: 'il Consorzio di Bonifica può utilizzare i fondi derivanti dai tributi imposti ai proprietari degli immobili solamente per la gestione e la semplice manutenzione ordinaria delle opere pubbliche di bonifica', // allow-italian: fixture data, shown as written
      summary: "I contributi dei consorziati pagano solo la gestione e la manutenzione ordinaria. La manutenzione straordinaria (art. 7, comma 1) si fa su concessione dello Stato o della Regione e con risorse pubbliche: un noleggio di mezzi per i canali è ordinaria, una convenzione per un vallone no.", // allow-italian: fixture data, shown as written
      checks: [{ label: 'Chi paga: tributi, solo per la manutenzione ordinaria', flow: 'nocera-contratti', step: 's3' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'contract', id: 'ct-noleggio-escavatori', at: 'art-1', why: 'Il noleggio è per la manutenzione ordinaria dei canali' }, // allow-italian: fixture data, shown as written
        { kind: 'contract', id: 'ct-convenzione-difesa-suolo', at: 'art-4', why: 'La convenzione non usa i tributi dei consorziati' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'CT-2390', why: 'Noleggio scaduto: novembre e dicembre si pagano con i tributi solo perché è manutenzione ordinaria' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'tributi contributo manutenzione ordinaria straordinaria fondi consorziati art 21 art 7', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-libro', label: "Passi del Libro dell'anno 2025", detail: 'Quello che usano gli agenti: le citazioni vengono da qui.', status: { text: 'In uso', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
    { id: 'v-burc', label: 'Testo ufficiale del BURC', detail: 'Da caricare: quando arriva sostituisce i passi del Libro e le citazioni si ricontrollano.', status: { text: 'Da caricare', tone: 'amber' } }, // allow-italian: fixture data, shown as written
    { id: 'v-2003', label: 'L.R. Campania 4/2003', detail: 'Abrogata dalla L.R. 7/2025: resta solo come storico.', status: { text: 'Abrogata', tone: 'neutral' } }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'legge regionale campania bonifica consorzi autorità polizia idraulica difesa del suolo', // allow-italian: fixture data, shown as written
};

const ROYAL_DECREE_368: KnowledgeDoc = {
  id: 'rd-368-1904', collection: 'norme', label: 'R.D. 368/1904', // allow-italian: fixture data, shown as written
  title: 'Regio Decreto 8 maggio 1904, n. 368', // allow-italian: fixture data, shown as written
  subtitle: 'Regolamento sulle bonifiche: opere di bonifica e loro polizia', // allow-italian: fixture data, shown as written
  issuer: 'Stato', url: RD_368_URL, host: NORMATTIVA, textUrl: LIBRO_PDF, // allow-italian: fixture data, shown as written
  note: 'Titolo VI, disposizioni di polizia: gli artt. 133 e 134 sono nel Capo I; testo ufficiale da caricare', // allow-italian: fixture data, shown as written
  status: { text: 'In vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Data', value: '8 maggio 1904' }, // allow-italian: fixture data, shown as written
    { label: 'Materia', value: 'opere di bonifica e loro polizia' }, // allow-italian: fixture data, shown as written
    { label: 'Vigilanza', value: 'Consorzio, L.R. 7/2025 art. 10' }, // allow-italian: fixture data, shown as written
    { label: 'Parti usate', value: 'art. 133, art. 134' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'polizia-bonifica', short: 'Polizia delle opere', heading: 'Polizia idraulica sulle opere di bonifica · come la richiama il Libro', // allow-italian: fixture data, shown as written
      quote: 'accertamento e contestazione delle violazioni di polizia idraulica di cui al R.D. n. 368/1904 per le opere di bonifica', // allow-italian: fixture data, shown as written
      summary: 'Sulle opere di bonifica le violazioni sono quelle del R.D. 368/1904. Le accerta e le contesta il Consorzio.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's2', why: 'Il tratto localizzato dice se è un canale di bonifica' }], // allow-italian: fixture data, shown as written
      keywords: 'polizia opere di bonifica violazioni accertamento', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-133', short: 'Art. 133', heading: 'Art. 133 · Lavori e atti vietati', // allow-italian: fixture data, shown as written
      summary: 'Elenca i lavori e gli atti vietati sulle opere di bonifica e sulle loro pertinenze. Un deposito di rifiuti in alveo o un manufatto sulla sponda si contestano qui.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'Articolo violato indicato nel verbale', flow: 'nocera-polizia', step: 's6' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-polizia', at: 's6', why: 'Il Legale verifica che la norma indicata sia quella violata' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'VP-2395', why: 'Verbale sul Torrente Lavinaio' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'lavori atti vietati opere di bonifica pertinenze rifiuti alveo sponda manufatto', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-134', short: 'Art. 134', heading: 'Art. 134 · Lavori e atti soggetti a permesso', // allow-italian: fixture data, shown as written
      summary: 'Elenca i lavori e gli atti che si possono eseguire solo con il permesso del Consorzio, come gli attraversamenti e gli scarichi nei canali: è la base della concessione.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'Permesso richiesto per attraversamento o scarico', flow: 'nocera-concessioni', step: 's6' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-concessioni', at: 's6', why: 'Il sopralluogo e il parere decidono se il permesso si può dare' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'CO-2386', why: 'Ponticello sul Canale Macchione' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'permesso concessione attraversamento scarico canale lavori soggetti a permesso', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-rd-368', label: 'R.D. 368/1904', detail: 'Testo vigente. Il testo ufficiale non è ancora caricato: le parti dicono di che cosa trattano gli articoli.', status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'bonifica canali scarico attraversamento polizia idraulica permesso concessione', // allow-italian: fixture data, shown as written
};

const ROYAL_DECREE_523: KnowledgeDoc = {
  id: 'rd-523-1904', collection: 'norme', label: 'R.D. 523/1904', // allow-italian: fixture data, shown as written
  title: 'Regio Decreto 25 luglio 1904, n. 523', // allow-italian: fixture data, shown as written
  subtitle: 'Testo unico sulle opere idrauliche: polizia delle acque pubbliche', // allow-italian: fixture data, shown as written
  issuer: 'Stato', url: RD_523_URL, host: NORMATTIVA, textUrl: LIBRO_PDF, // allow-italian: fixture data, shown as written
  note: 'Capo VII, polizia delle acque pubbliche: gli artt. 93 e 96 sono qui; testo ufficiale da caricare', // allow-italian: fixture data, shown as written
  status: { text: 'In vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Data', value: '25 luglio 1904' }, // allow-italian: fixture data, shown as written
    { label: 'Materia', value: 'reticolo idrografico regionale' }, // allow-italian: fixture data, shown as written
    { label: 'Vigilanza', value: 'Consorzio, L.R. 7/2025 art. 10' }, // allow-italian: fixture data, shown as written
    { label: 'Parti usate', value: 'art. 93, art. 96' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'polizia-reticolo', short: 'Polizia del reticolo', heading: 'Polizia idraulica sul reticolo regionale · come la richiama il Libro', // allow-italian: fixture data, shown as written
      quote: 'e al R.D. n. 523/1904 per i corsi d’acqua del reticolo idrografico regionale', // allow-italian: fixture data, shown as written
      summary: "Sui corsi d'acqua del reticolo regionale le violazioni sono quelle del R.D. 523/1904.", // allow-italian: fixture data, shown as written
      keywords: 'reticolo regionale corsi d acqua polizia idraulica', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-93', short: 'Art. 93', heading: 'Art. 93 · Opere nell\'alveo e sulle sponde', // allow-italian: fixture data, shown as written
      summary: "Le opere nell'alveo, sulle sponde e sulle difese dei corsi d'acqua si fanno solo con l'autorizzazione dell'autorità idraulica. Un tratto di canale che è anche reticolo regionale segue questo articolo oltre al R.D. 368/1904.", // allow-italian: fixture data, shown as written
      checks: [{ label: 'Il tratto è nel reticolo regionale: serve anche questa autorizzazione', flow: 'nocera-concessioni', step: 's6' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-concessioni', at: 's6', why: 'Il parere considera anche le opere in alveo' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'CO-2386', why: 'Ponticello sul Canale Macchione, tratto del reticolo regionale' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'opere in alveo sponde difese autorizzazione concessione corsi d acqua', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-96', short: 'Art. 96', heading: 'Art. 96 · Lavori e atti vietati', // allow-italian: fixture data, shown as written
      summary: "Elenca i lavori e gli atti vietati sulle acque pubbliche, sugli alvei, sulle sponde e sulle difese, comprese le distanze da rispettare per costruzioni, scavi e piantagioni.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's6', why: 'Il Legale verifica la norma quando il tratto è nel reticolo regionale' }], // allow-italian: fixture data, shown as written
      keywords: 'lavori vietati distanze sponde alvei scavi costruzioni fascia di rispetto', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-rd-523', label: 'R.D. 523/1904', detail: 'Testo vigente. Il testo ufficiale non è ancora caricato.', status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'opere idrauliche alveo sponde reticolo regionale polizia idraulica', // allow-italian: fixture data, shown as written
};

const REGIONAL_LAW_13: KnowledgeDoc = {
  id: 'lr-13-1983', collection: 'norme', label: 'L.R. Campania 13/1983', // allow-italian: fixture data, shown as written
  title: 'Legge Regionale Campania 10 gennaio 1983, n. 13', // allow-italian: fixture data, shown as written
  subtitle: 'Norme per l\'applicazione delle sanzioni amministrative e pecuniarie', // allow-italian: fixture data, shown as written
  issuer: 'Regione Campania', textUrl: LIBRO_PDF, host: SITE, // allow-italian: fixture data, shown as written
  note: "Titolo letto nel Libro dell'anno 2025; il testo del BURC è da caricare", // allow-italian: fixture data, shown as written
  status: { text: 'In vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Data', value: '10 gennaio 1983' }, // allow-italian: fixture data, shown as written
    { label: 'Materia', value: 'sanzioni di polizia idraulica' }, // allow-italian: fixture data, shown as written
    { label: 'Proventi', value: 'gestione e manutenzione delle opere vigilate' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'sanzioni', short: 'Sanzioni', heading: 'Sanzioni amministrative e pecuniarie', // allow-italian: fixture data, shown as written
      quote: 'Norme per l’applicazione delle sanzioni amministrative e pecuniarie di competenza della Regione o di Enti da essa delegati o subdelegati', // allow-italian: fixture data, shown as written
      summary: 'È la legge delle sanzioni che il Consorzio applica come Autorità di Polizia Idraulica. La sanzione di un verbale si calcola qui, non nel R.D. violato.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'Sanzione indicata secondo la L.R. 13/1983', flow: 'nocera-polizia', step: 's6' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-polizia', at: 's6', why: 'Il Legale verifica norma e sanzione' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'VP-2395', why: 'Sanzione del verbale sul Torrente Lavinaio' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'sanzioni amministrative pecuniarie verbale polizia idraulica importo', // allow-italian: fixture data, shown as written
    },
    {
      id: 'proventi', short: 'Proventi', heading: 'Destinazione dei proventi', // allow-italian: fixture data, shown as written
      quote: 'i proventi delle sanzioni amministrative pecuniarie sono destinati alla gestione e alla manutenzione delle opere vigilate', // allow-italian: fixture data, shown as written
      summary: 'Il denaro delle sanzioni non è un ricavo qualunque: serve alla gestione e alla manutenzione delle opere vigilate, e la Ragioneria lo registra con quel vincolo.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's8', why: 'Dopo la notifica la Ragioneria registra il provento con il vincolo' }], // allow-italian: fixture data, shown as written
      keywords: 'proventi sanzioni destinazione ragioneria manutenzione opere vigilate', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-lr-13', label: 'L.R. Campania 13/1983', detail: 'Testo vigente. Il testo del BURC non è ancora caricato.', status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'sanzioni amministrative pecuniarie regione campania verbale proventi', // allow-italian: fixture data, shown as written
};

const POLICE_REGULATION: KnowledgeDoc = {
  id: 'regolamento-polizia-idraulica', collection: 'norme', label: 'Regolamento di Polizia Idraulica', // allow-italian: fixture data, shown as written
  title: 'Regolamento per la gestione e la conservazione delle opere di bonifica', // allow-italian: fixture data, shown as written
  subtitle: 'Delibera del Consiglio dei Delegati 15/03/2023, n. 2', // allow-italian: fixture data, shown as written
  issuer: 'Consorzio di Bonifica Integrale Comprensorio Sarno', textUrl: LIBRO_PDF, host: SITE, // allow-italian: fixture data, shown as written
  note: "Citato nel Libro dell'anno 2025; il testo del Regolamento è da prendere dall'albo pretorio", // allow-italian: fixture data, shown as written
  status: { text: 'In vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Approvato con', value: 'Delibera del Consiglio dei Delegati 15/03/2023, n. 2' }, // allow-italian: fixture data, shown as written
    { label: 'Materia', value: 'polizia idraulica' }, // allow-italian: fixture data, shown as written
    { label: 'Testo ufficiale', value: 'da caricare' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'oggetto', short: 'Oggetto', heading: 'Oggetto · le norme di polizia idraulica sulle opere di bonifica', // allow-italian: fixture data, shown as written
      quote: 'contenute nel “Regolamento per la gestione e la conservazione delle opere di bonifica” (Delibera Consiglio dei Delegati 15.03.2023, n. 2)', // allow-italian: fixture data, shown as written
      summary: 'Il Regolamento contiene le norme di polizia idraulica che il Consorzio applica sulle opere di bonifica e di irrigazione, in aggiunta al R.D. 368/1904.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's3', why: 'Il verbale protocollato cita il Regolamento oltre al R.D.' }], // allow-italian: fixture data, shown as written
      keywords: 'regolamento gestione conservazione opere di bonifica delibera consiglio dei delegati', // allow-italian: fixture data, shown as written
    },
    {
      id: 'servizio', short: 'Chi svolge il servizio', heading: 'Chi svolge il servizio di polizia idraulica', // allow-italian: fixture data, shown as written
      quote: 'Il servizio di Polizia Idraulica è svolto dal personale impiegato individuato dal Consorzio, tra cui l’ufficiale idraulico e il sorvegliante', // allow-italian: fixture data, shown as written
      summary: "Il verbale lo accerta l'ufficiale idraulico o il sorvegliante. Nessun agente accerta o contesta: prepara la notifica e le persone la verificano.", // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-polizia', at: 's5', why: "L'ufficiale idraulico verifica il verbale" }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'VP-2395', why: 'Verbale accertato dall\'ufficiale idraulico' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'ufficiale idraulico sorvegliante personale servizio polizia idraulica', // allow-italian: fixture data, shown as written
    },
    {
      id: 'qualifica', short: 'Qualifica', heading: 'Qualifica di chi accerta', // allow-italian: fixture data, shown as written
      quote: 'rivestono la qualifica di ufficiale di Polizia Giudiziaria nei limiti del servizio cui sono destinati', // allow-italian: fixture data, shown as written
      summary: "L'ufficiale idraulico e il sorvegliante sono ufficiali di polizia giudiziaria nei limiti del servizio: il verbale che firmano ha il valore di un atto di polizia giudiziaria.", // allow-italian: fixture data, shown as written
      keywords: 'ufficiale polizia giudiziaria qualifica sorvegliante agente subalterno idraulico', // allow-italian: fixture data, shown as written
    },
    {
      id: 'iter', short: 'Dopo l\'accertamento', heading: "Dopo l'accertamento · segnalazione agli enti", // allow-italian: fixture data, shown as written
      quote: 'prevede anche la successiva segnalazione agli enti preposti, quali Comuni, Provincie, Regioni, ed eventuale Autorità Giudiziaria', // allow-italian: fixture data, shown as written
      summary: "Dopo il verbale il Consorzio segnala la violazione al Comune, alla Provincia o alla Regione e, se serve, all'Autorità Giudiziaria, anche per il ripristino dello stato dei luoghi.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's8', why: 'Con la notifica parte la segnalazione agli enti' }], // allow-italian: fixture data, shown as written
      keywords: 'segnalazione enti comuni province regione autorità giudiziaria ripristino stato dei luoghi', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-reg', label: 'Regolamento del 15/03/2023', detail: "Il testo ufficiale non è ancora caricato: le parti riportano quello che ne dice il Libro dell'anno 2025.", status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'regolamento polizia idraulica opere di bonifica delibera 2023', // allow-italian: fixture data, shown as written
};

const CLASSIFICATION_PLAN: KnowledgeDoc = {
  id: 'piano-classifica-1996', collection: 'norme', label: 'Piano di Classifica 1996', // allow-italian: fixture data, shown as written
  title: 'Piano di Classifica del Territorio, 1996', // allow-italian: fixture data, shown as written
  subtitle: 'Approvato con delibera di G.R. Campania n. 0403/AC del 18/03/1997', // allow-italian: fixture data, shown as written
  issuer: 'Regione Campania, Giunta Regionale', textUrl: LIBRO_PDF, host: SITE, // allow-italian: fixture data, shown as written
  note: "Citato nel Libro dell'anno 2025; il testo del Piano non è ancora caricato", // allow-italian: fixture data, shown as written
  status: { text: 'In vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Anno', value: '1996' }, // allow-italian: fixture data, shown as written
    { label: 'Approvazione', value: 'G.R. n. 0403/AC, 18/03/1997' }, // allow-italian: fixture data, shown as written
    { label: 'Testo ufficiale', value: 'da caricare' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'irrigazione', short: 'Irrigazione', heading: 'Irrigazione collettiva', // allow-italian: fixture data, shown as written
      quote: 'come stabilito dal vigente Piano di Classifica del Territorio 1996 approvato con delibera di G.R. Campania n° 0403/AC del 18/03/1997', // allow-italian: fixture data, shown as written
      summary: "Il Piano classifica l'area dell'irrigazione collettiva: 16.970 ettari, il 4% del territorio. Un'utenza è del servizio irriguo solo se è in uno dei sette bacini.", // allow-italian: fixture data, shown as written
      checks: [{ label: 'La particella è in uno dei sette bacini di irrigazione collettiva', flow: 'nocera-irrigazione', step: 's2' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-irrigazione', at: 's2', why: "L'agente verifica che bacino e particella siano nel Piano" }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'IR-2414', why: 'Turno irriguo per finocchio a San Valentino Torio' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'piano di classifica irrigazione collettiva bacini 16.970 ettari', // allow-italian: fixture data, shown as written
    },
    {
      id: 'riparto', short: 'Classifica e riparto', heading: 'Classifica degli immobili e riparto del contributo', // allow-italian: fixture data, shown as written
      quote: 'I costi che vengono distribuiti tra i proprietari dei terreni serviti riguardano principalmente la manutenzione e il funzionamento degli impianti irrigui, a cui si aggiungono le spese generali dell’Ente attribuibili al settore irriguo', // allow-italian: fixture data, shown as written
      summary: "Il contributo si ripartisce tra i proprietari in base alla classifica dei loro immobili. È la base degli avvisi di contributo: chi fa ricorso contesta la classifica o il riparto, e l'avviso si controlla sul Piano.", // allow-italian: fixture data, shown as written
      checks: [{ label: "Classifica e riparto dell'avviso uguali a quelli del Piano", flow: 'nocera-pec', step: 's3' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-pec', at: 's3', why: "Si trova l'avviso contestato nel catasto consortile" }, // allow-italian: fixture data, shown as written
        { kind: 'flow', id: 'nocera-contributi', at: 's4', why: 'Il conteggio dello sgravio parte dalla classifica' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'PEC-2418', why: 'Ricorso di un\'azienda agricola contro l\'avviso di contributo' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'RC-2416', why: 'Sgravio per un terreno venduto nel 2025' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'classifica riparto contributo avviso ricorso immobili beneficio', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-pdc', label: 'Piano di Classifica del 1996', detail: 'Il testo ufficiale non è ancora caricato: le parti riportano quello che ne dice il Libro dell\'anno 2025.', status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'piano di classifica contributo bonifica irrigazione bacini classifica immobili', // allow-italian: fixture data, shown as written
};

const TAX_PROCESS: KnowledgeDoc = {
  id: 'dlgs-546-1992', collection: 'norme', label: 'D.Lgs. 546/1992', // allow-italian: fixture data, shown as written
  title: 'Decreto legislativo 31 dicembre 1992, n. 546', // allow-italian: fixture data, shown as written
  subtitle: 'Disposizioni sul processo tributario', // allow-italian: fixture data, shown as written
  issuer: 'Stato', url: DLGS_546_URL, host: NORMATTIVA, // allow-italian: fixture data, shown as written
  note: 'Testo ufficiale da caricare: le parti riassumono i termini che il Consorzio usa', // allow-italian: fixture data, shown as written
  status: { text: 'In vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Data', value: '31 dicembre 1992' }, // allow-italian: fixture data, shown as written
    { label: 'Materia', value: 'processo tributario' }, // allow-italian: fixture data, shown as written
    { label: 'Parti usate', value: 'art. 23, art. 38' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'art-23', short: 'Art. 23', heading: 'Art. 23 · Costituzione in giudizio del resistente', // allow-italian: fixture data, shown as written
      summary: 'Il Consorzio, che è il resistente, si costituisce entro 60 giorni dalla notifica del ricorso depositando le controdeduzioni con prove ed eccezioni. Dopo la scadenza non si recupera: è il termine più stretto di un ricorso sul contributo.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'Termine di 60 giorni calcolato dalla consegna della PEC', flow: 'nocera-pec', step: 's4' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-pec', at: 's4', why: 'Il passo calcola i 60 giorni per costituirsi in giudizio' }, // allow-italian: fixture data, shown as written
        { kind: 'contract', id: 'ct-albo-legali', at: 'art-5', why: "L'Avvocato si costituisce nel termine di 60 giorni" }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'PEC-2418', why: 'Ricorso di un\'azienda agricola, termine di costituzione' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'costituzione in giudizio resistente sessanta giorni controdeduzioni ricorso tributario cgt', // allow-italian: fixture data, shown as written
    },
    {
      id: 'art-38', short: 'Art. 38', heading: 'Art. 38 · Termine per l\'appello', // allow-italian: fixture data, shown as written
      summary: "L'appello contro la sentenza di primo grado si propone entro 60 giorni dalla notifica della sentenza. Se la sentenza non è notificata, il termine è più lungo e corre dal deposito: il Consorzio conta sempre dalla notifica.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'contract', id: 'ct-albo-legali', at: 'art-5', why: "Per ogni atto con un termine il legale dà prova del deposito 5 giorni prima della scadenza" }], // allow-italian: fixture data, shown as written
      keywords: 'appello sentenza primo grado termine notifica corte di giustizia tributaria secondo grado', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-546', label: 'D.Lgs. 546/1992', detail: 'Testo vigente. Il testo ufficiale non è ancora caricato.', status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'processo tributario ricorso costituzione in giudizio appello corte di giustizia tributaria', // allow-italian: fixture data, shown as written
};

const TRANSPARENCY: KnowledgeDoc = {
  id: 'dlgs-33-2013', collection: 'norme', label: 'D.Lgs. 33/2013', // allow-italian: fixture data, shown as written
  title: 'Decreto legislativo 14 marzo 2013, n. 33', // allow-italian: fixture data, shown as written
  subtitle: 'Obblighi di trasparenza e accesso civico', // allow-italian: fixture data, shown as written
  issuer: 'Stato', url: DLGS_33_URL, host: NORMATTIVA, // allow-italian: fixture data, shown as written
  note: 'Testo ufficiale da caricare: la parte riassume il termine che il Consorzio usa', // allow-italian: fixture data, shown as written
  status: { text: 'In vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Data', value: '14 marzo 2013' }, // allow-italian: fixture data, shown as written
    { label: 'Materia', value: 'trasparenza e accesso civico' }, // allow-italian: fixture data, shown as written
    { label: 'Parti usate', value: 'art. 5, comma 6' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'art-5-c6', short: 'Art. 5 c. 6', heading: 'Art. 5, comma 6 · Termine di trenta giorni', // allow-italian: fixture data, shown as written
      summary: "Una richiesta di accesso civico si chiude con un provvedimento espresso e motivato entro 30 giorni dalla presentazione, anche quando l'accesso si nega.", // allow-italian: fixture data, shown as written
      checks: [{ label: 'Termine di 30 giorni calcolato dalla consegna della PEC', flow: 'nocera-pec', step: 's4' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-pec', at: 's4', why: 'Il passo calcola i 30 giorni per un accesso agli atti' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'PEC-2419', why: 'Accesso civico sulle concessioni di due canali' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'accesso civico trenta giorni provvedimento espresso motivato accesso agli atti', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-33', label: 'D.Lgs. 33/2013', detail: 'Testo vigente. Il testo ufficiale non è ancora caricato.', status: { text: 'In vigore', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'trasparenza accesso civico generalizzato semplice trenta giorni', // allow-italian: fixture data, shown as written
};

/* ---------- the Consorzio's own papers ---------- */

const YEARBOOK: KnowledgeDoc = {
  id: 'libro-anno-2025', collection: 'azienda', label: "Libro dell'anno 2025", // allow-italian: fixture data, shown as written
  title: "Libro dell'anno 2025", // allow-italian: fixture data, shown as written
  subtitle: 'Pubblicato dal Consorzio sul proprio sito a marzo 2026, 452 pagine', // allow-italian: fixture data, shown as written
  issuer: 'Consorzio di Bonifica Integrale Comprensorio Sarno', url: LIBRO_PDF, host: SITE, // allow-italian: fixture data, shown as written
  note: 'Pubblicato a marzo 2026; le citazioni sono passi copiati dal PDF', // allow-italian: fixture data, shown as written
  status: { text: 'Aggiornato', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Pagine', value: '452' }, // allow-italian: fixture data, shown as written
    { label: 'Pubblicato', value: 'marzo 2026' }, // allow-italian: fixture data, shown as written
    { label: 'Capitoli usati', value: 'rete, manutenzione, irrigazione, polizia idraulica' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'storia', short: 'Storia', heading: "Storia · dal Consorzio dell'Agro Sarnese Nocerino a oggi", // allow-italian: fixture data, shown as written
      quote: 'Il Consorzio di Bonifica dell’Agro Sarnese Nocerino, costituito con DPR del 1° dicembre 1952 quale Ente di Diritto Pubblico', // allow-italian: fixture data, shown as written
      summary: 'Il Consorzio nasce nel 1952 come Consorzio di Bonifica dell\'Agro Sarnese Nocerino e oggi si chiama Consorzio di Bonifica Integrale Comprensorio Sarno.', // allow-italian: fixture data, shown as written
      keywords: 'storia 1952 agro sarnese nocerino denominazione ente', // allow-italian: fixture data, shown as written
    },
    {
      id: 'comprensorio-rete', short: 'Comprensorio e rete', heading: 'Comprensorio e rete idraulica', // allow-italian: fixture data, shown as written
      quote: 'Nell’intero Comprensorio di competenza consortile sono presenti circa 680 km di rete idraulica, di cui circa 610 km sono canali di bonifica, circa 50 km sono ad uso promiscuo e circa 20 km sono ad uso irriguo', // allow-italian: fixture data, shown as written
      summary: 'Circa 680 km di rete: 610 di canali di bonifica, 50 promiscui, 20 irrigui; 560 km nel comprensorio di attuale operatività, che misura 43.054 ettari. Le aste principali sono il Fiume Sarno, il Torrente Solofrana, il Torrente Cavaiola e l\'Alveo Comune Nocerino.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'Il canale della segnalazione è in elenco', flow: 'nocera-segnalazioni', step: 's3' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-segnalazioni', at: 's3', why: 'Il canale si localizza sulla rete del Consorzio' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'SG-2420', why: 'Griglia ostruita sul Canale Torello' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'rete idraulica km canali di bonifica promiscui irrigui comprensorio 43.054 ettari aste principali', // allow-italian: fixture data, shown as written
    },
    {
      id: 'manutenzione', short: 'Manutenzione', heading: 'Manutenzione ordinaria dei canali nel 2025', // allow-italian: fixture data, shown as written
      quote: 'tagli di vegetazione su circa 2.500.000 m2 (dovuti anche allo sfalcio eseguito su tutta la superficie delle vasche)', // allow-italian: fixture data, shown as written
      summary: "Nel 2025 il Consorzio ha tagliato la vegetazione su circa 2.500.000 m² e rimosso circa 155.000 m³ di sedimenti, con operai dipendenti e mezzi propri. Il noleggio di mezzi integra questa manutenzione quando i mezzi propri non bastano.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'contract', id: 'ct-noleggio-escavatori', at: 'art-1', why: 'Espurghi e tagli di vegetazione dei canali, con mezzi a noleggio in più' }], // allow-italian: fixture data, shown as written
      keywords: 'manutenzione espurghi sedimenti tagli vegetazione mezzi operai canali 2025', // allow-italian: fixture data, shown as written
    },
    {
      id: 'irrigazione', short: 'Irrigazione', heading: 'Il servizio irriguo · i sette bacini', // allow-italian: fixture data, shown as written
      quote: 'Il servizio irriguo comprende 7 bacini di irrigazione collettiva per un totale di 1.697,00 ettari di superficie irrigata e 10.131,00 ettari di superficie irrigabile', // allow-italian: fixture data, shown as written
      summary: 'Sette bacini di irrigazione collettiva: 1.697 ettari irrigati su 10.131 irrigabili. Una richiesta di turno è valida se la particella è in uno di questi bacini.', // allow-italian: fixture data, shown as written
      checks: [{ label: 'Bacino e particella della richiesta', flow: 'nocera-irrigazione', step: 's2' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-irrigazione', at: 's2', why: 'Si verifica bacino e particella' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'IR-2414', why: 'Turno irriguo per finocchio a San Valentino Torio' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'irrigazione bacini 1.697 ettari irrigati 10.131 irrigabili turno irriguo', // allow-italian: fixture data, shown as written
    },
    {
      id: 'pozzi', short: 'Pozzi e vasche', heading: 'Pozzi e vasche di accumulo', // allow-italian: fixture data, shown as written
      quote: 'La rete irrigua è alimentata da 55 pozzi di falda profonda, con una portata complessiva di 2.503 litri/secondo. Sono inoltre presenti 5 vasche di accumulo per garantire la continuità dell’approvvigionamento', // allow-italian: fixture data, shown as written
      summary: "55 pozzi con 2.503 l/s e 5 vasche di accumulo. Prima di promettere un turno si guarda quanti pozzi e quanta acqua in vasca ci sono; sono anche i punti di prelievo del contratto dell'energia.", // allow-italian: fixture data, shown as written
      checks: [{ label: 'Livello delle vasche e pozzi disponibili prima di proporre il turno', flow: 'nocera-irrigazione', step: 's3' }], // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-irrigazione', at: 's3', why: 'Prima del turno si guardano i pozzi e le vasche' }, // allow-italian: fixture data, shown as written
        { kind: 'contract', id: 'ct-energia-pozzi', at: 'art-1', why: 'I punti di prelievo sono i 55 pozzi' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'pozzi 55 vasche di accumulo 2.503 litri secondo falda profonda portata', // allow-italian: fixture data, shown as written
    },
    {
      id: 'bacino-paludi', short: 'Bacino Paludi', heading: 'Il bacino di Paludi · gruppi di consegna automatizzati', // allow-italian: fixture data, shown as written
      quote: 'la completa automatizzazione dei gruppi di consegna (card elettroniche prepagate)', // allow-italian: fixture data, shown as written
      summary: 'Il bacino di Paludi ha gruppi di consegna automatizzati e un telecontrollo sviluppato dal Consorzio. Un turno in questo bacino si programma sul telecontrollo, in un canale a scorrimento si assegna a mano al personale di zona.', // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-irrigazione', at: 's4', why: 'Il giorno e l\'ora dipendono dal tipo di distribuzione del bacino' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'IR-2414', why: 'Turno comunicato al richiedente' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'paludi gruppi di consegna automatizzati card prepagate telecontrollo scorrimento', // allow-italian: fixture data, shown as written
    },
    {
      id: 'fotovoltaico', short: 'Fotovoltaico', heading: 'Tre impianti fotovoltaici sugli impianti di sollevamento', // allow-italian: fixture data, shown as written
      quote: 'tre impianti fotovoltaici a servizio delle stazioni di sollevamento delle acque, destinati a garantire una significativa riduzione dei costi energetici attraverso l’utilizzo di fonti rinnovabili', // allow-italian: fixture data, shown as written
      summary: "Il Consorzio progetta tre impianti fotovoltaici per le stazioni di sollevamento. Quando entrano in esercizio il contratto dell'energia deve poter scendere di quantità senza penale.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'contract', id: 'ct-energia-pozzi', at: 'art-8', why: 'La riduzione senza penale per gli impianti fotovoltaici' }], // allow-italian: fixture data, shown as written
      keywords: 'fotovoltaico impianti sollevamento energia risparmio rinnovabili', // allow-italian: fixture data, shown as written
    },
    {
      id: 'polizia-idraulica', short: 'Polizia idraulica', heading: 'Polizia idraulica · compiti del Consorzio', // allow-italian: fixture data, shown as written
      quote: 'Il Consorzio di Bonifica Integrale Comprensorio Sarno, quale Autorità di Polizia Idraulica, assolve a compiti di vigilanza e provvede all’accertamento e alla contestazione delle violazioni previste dalle norme di Polizia Idraulica', // allow-italian: fixture data, shown as written
      summary: 'Il Consorzio vigila e contesta le violazioni sulle opere di bonifica e di irrigazione e sui corsi d\'acqua del reticolo regionale che gestisce.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's1', why: 'Il verbale è un atto di polizia idraulica del Consorzio' }], // allow-italian: fixture data, shown as written
      keywords: 'polizia idraulica vigilanza accertamento contestazione compiti', // allow-italian: fixture data, shown as written
    },
    {
      id: 'interventi-affidati', short: 'Interventi affidati', heading: 'Interventi affidati da Regione ed enti locali', // allow-italian: fixture data, shown as written
      quote: 'la progettazione e l’esecuzione di interventi, ad esso affidati dalla Regione, dagli enti da essa dipendenti e dagli enti locali territoriali, anche al di fuori dei comprensori di bonifica', // allow-italian: fixture data, shown as written
      summary: "Il Consorzio può progettare ed eseguire interventi che gli affidano la Regione e gli enti locali, anche fuori dal comprensorio. Il provvedimento di affidamento dice anche chi gestirà le opere dopo.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'contract', id: 'ct-convenzione-difesa-suolo', at: 'art-1', why: 'Un Comune affida al Consorzio interventi di difesa del suolo' }], // allow-italian: fixture data, shown as written
      keywords: 'interventi affidati enti locali comuni regione convenzione fuori comprensorio', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-libro', label: "Libro dell'anno 2025", detail: 'Letto e diviso per capitoli: rete, manutenzione, irrigazione, opere pubbliche, polizia idraulica.', status: { text: 'Aggiornato', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: "libro dell'anno consorzio rete canali irrigazione manutenzione polizia idraulica", // allow-italian: fixture data, shown as written
};

const SEND_NEWS: KnowledgeDoc = {
  id: 'send-2026', collection: 'azienda', label: 'Adozione di SEND', // allow-italian: fixture data, shown as written
  title: 'Il Consorzio adotta SEND per le notifiche a valore legale', // allow-italian: fixture data, shown as written
  subtitle: 'Notizia del sito, maggio 2026: gli avvisi di notifica passano dalla piattaforma di PagoPA', // allow-italian: fixture data, shown as written
  issuer: 'Consorzio di Bonifica Integrale Comprensorio Sarno', url: 'https://www.bonificasarno.it/2026/05/il-consorzio-adotta-send-per-le-notifiche-a-valore-legale/', host: SITE, // allow-italian: fixture data, shown as written
  note: "Pubblicata a maggio 2026; i costi sono quelli dell'avviso 2025, il 2026 non era ancora emesso", // allow-italian: fixture data, shown as written
  status: { text: 'Aggiornato', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Piattaforma', value: 'SEND, Servizio Notifiche Digitali di PagoPA' }, // allow-italian: fixture data, shown as written
    { label: 'Dal', value: '2026' }, // allow-italian: fixture data, shown as written
    { label: 'Atti notificati', value: 'avvisi di notifica (AVN)' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'send', short: 'SEND', heading: 'Gli avvisi di notifica passano da SEND', // allow-italian: fixture data, shown as written
      quote: 'Da quest’anno gli avvisi di notifica (AVN) del Consorzio di Bonifica Integrale Comprensorio Sarno vengono inviati attraverso la piattaforma nazionale SEND', // allow-italian: fixture data, shown as written
      summary: "Dal 2026 gli avvisi con valore di notifica si spediscono da SEND. L'ente deposita l'atto sulla piattaforma, che sceglie il canale; la ricevuta di avvenuta consegna arriva da lì.", // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'flow', id: 'nocera-contributi', at: 's7', why: 'Lo sgravio, il rimborso o il diniego si notificano via SEND' }, // allow-italian: fixture data, shown as written
        { kind: 'flow', id: 'nocera-polizia', at: 's8', why: 'La notifica del verbale parte da SEND' }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'RC-2404', why: 'Rimborso notificato con SEND, contributo pagato due volte' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'send notifiche digitali pagopa avviso di notifica avn valore legale', // allow-italian: fixture data, shown as written
    },
    {
      id: 'ruolo', short: 'Ruolo di contribuenza', heading: 'Il ruolo di contribuenza', // allow-italian: fixture data, shown as written
      quote: 'un elenco di tutti i proprietari di immobili che rientrano nel comprensorio, ciascuno con l’importo dovuto in base alla superficie e alla destinazione del proprio terreno o fabbricato', // allow-italian: fixture data, shown as written
      summary: "Ogni anno si approva il ruolo: chi deve il contributo e quanto, secondo superficie e destinazione. Un'istanza di sgravio parte da qui, dall'immobile e dall'avviso che lo riguarda.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-contributi', at: 's2', why: 'Si trovano contribuente, immobili e avvisi' }, { kind: 'card', id: 'RC-2416', why: 'Sgravio per un terreno venduto nel 2025' }], // allow-italian: fixture data, shown as written
      keywords: 'ruolo contribuenza proprietari immobili superficie destinazione importo dovuto', // allow-italian: fixture data, shown as written
    },
    {
      id: 'avp', short: 'AVP', heading: "L'avviso di pagamento (AVP)", // allow-italian: fixture data, shown as written
      quote: 'Costo totale per l’AVP 2025 emesso: € 2,73', // allow-italian: fixture data, shown as written
      summary: "Il primo avviso è un invito bonario, per posta o per PEC. Costa 2,73 euro tra gestione, elaborazione, stampa e spedizione: se il contribuente paga qui, non si arriva alla notifica.", // allow-italian: fixture data, shown as written
      keywords: 'avp avviso di pagamento bonario costo 2,73', // allow-italian: fixture data, shown as written
    },
    {
      id: 'avn', short: 'AVN', heading: "L'avviso di notifica (AVN)", // allow-italian: fixture data, shown as written
      quote: '€ 8,22 in totale, comprensivi del recupero dei costi dell’AVP (€ 2,73) già sostenuti dal Consorzio', // allow-italian: fixture data, shown as written
      summary: "Se l'AVP non è pagato parte l'avviso con valore di notifica: 8,22 euro di gestione, più la spedizione SEND, che varia con il canale (digitale o cartaceo) e il peso.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'card', id: 'RC-2404', why: 'Il contribuente aveva pagato l\'avviso due volte' }], // allow-italian: fixture data, shown as written
      keywords: 'avn avviso di notifica 8,22 spedizione send costo', // allow-italian: fixture data, shown as written
    },
    {
      id: 'ingiunzione', short: 'Ingiunzione', heading: 'Ingiunzione di pagamento', // allow-italian: fixture data, shown as written
      quote: 'Costo complessivo: circa € 30,00 (comprensivi di tutte le spese pregresse)', // allow-italian: fixture data, shown as written
      summary: "Se nemmeno l'avviso di notifica è pagato, il Consorzio emette l'ingiunzione fiscale, un atto esecutivo che porta il costo a circa 30 euro con tutte le spese precedenti.", // allow-italian: fixture data, shown as written
      keywords: 'ingiunzione fiscale atto esecutivo costo 30 euro mancato pagamento', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v1', label: 'Notizia di maggio 2026', detail: "Costi dell'avviso 2025; l'avviso 2026 non era ancora emesso.", status: { text: 'Aggiornato', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'send notifiche contributo bonifica riscossione avp avn ingiunzione', // allow-italian: fixture data, shown as written
};

const LAWYERS_ROLL: KnowledgeDoc = {
  id: 'albo-legali-2026', collection: 'azienda', label: 'Albo dei legali', // allow-italian: fixture data, shown as written
  title: "Albo per l'affidamento di incarichi di assistenza e patrocinio legale", // allow-italian: fixture data, shown as written
  subtitle: 'Notizia del sito, maggio 2026', // allow-italian: fixture data, shown as written
  issuer: 'Consorzio di Bonifica Integrale Comprensorio Sarno', url: 'https://www.bonificasarno.it/2026/05/costituzione-di-un-albo-per-laffidamento-incarichi-di-assistenza-e-patrocinio-legale/', host: SITE, // allow-italian: fixture data, shown as written
  note: 'Pubblicata a maggio 2026; la documentazione dell\'albo è scaricabile dalla notizia', // allow-italian: fixture data, shown as written
  status: { text: 'Aggiornato', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Deliberazione', value: 'Deputazione Amministrativa n. 16 del 28.01.2026' }, // allow-italian: fixture data, shown as written
    { label: 'Aperto a', value: 'professionisti, singoli o associati' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'albo', short: 'Albo', heading: "L'albo aperto ai professionisti", // allow-italian: fixture data, shown as written
      quote: 'in esecuzione della Deliberazione di Deputazione Amministrativa n. 16 del 28.01.2026, ha inteso aggiornare l’Albo aperto ai professionisti, singoli o associati, per l’affidamento degli incarichi di assistenza e patrocinio legale dinanzi alle Autorità Giudiziarie e per l’attività stragiudiziale', // allow-italian: fixture data, shown as written
      summary: "Gli incarichi legali (difesa in giudizio e attività stragiudiziale) si affidano a professionisti iscritti all'albo. Per un ricorso sul contributo l'avvocato interno propone il nome dall'albo e la direzione approva l'incarico.", // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'contract', id: 'ct-albo-legali', at: 'art-1', why: "L'Avvocato è iscritto all'albo" }, // allow-italian: fixture data, shown as written
        { kind: 'flow', id: 'nocera-pec', at: 's7', why: "La direzione approva l'incarico al legale" }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'CT-2404', why: "Incarico a un legale dell'albo, scelto dall'elenco" }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'albo legali avvocati incarichi assistenza patrocinio legale stragiudiziale deputazione amministrativa', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v1', label: 'Albo aggiornato con la Deliberazione n. 16 del 28.01.2026', detail: "L'elenco dei professionisti iscritti non è nel sito: è nella documentazione dell'albo.", status: { text: 'Aggiornato', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'albo avvocati incarichi legali patrocinio contenzioso', // allow-italian: fixture data, shown as written
};

const ENGINEERING_FRAMEWORK: KnowledgeDoc = {
  id: 'accordo-quadro-ingegneria-2026', collection: 'azienda', label: 'Accordo quadro di ingegneria', // allow-italian: fixture data, shown as written
  title: "Accordo quadro, in 2 lotti, per i servizi di ingegneria della Programmazione triennale 2026-2028", // allow-italian: fixture data, shown as written
  subtitle: 'Notizia del sito, settembre 2026: procedura di gara della CUC del Lago di Occhito', // allow-italian: fixture data, shown as written
  issuer: 'Consorzio di Bonifica Integrale Comprensorio Sarno', url: 'https://www.bonificasarno.it/2026/09/affidamento-di-un-accordo-quadro-suddiviso-in-2-lotti-per-laffidamento-dei-servizi-di-ingegneria-relativi-alle-opere-inserite-nella-programmazione-triennale-2026-2028/', host: SITE, // allow-italian: fixture data, shown as written
  note: "Avviso di proroga del 25/09/2026; l'esito della gara non è sul sito, aggiudicatari, importi e date dei due contratti sono esempi", // allow-italian: fixture data, shown as written
  status: { text: 'Gara chiusa, accordi in vigore (esempio)', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [
    { label: 'Lotti', value: '2' }, // allow-italian: fixture data, shown as written
    { label: 'Gara', value: 'CUC del Lago di Occhito' }, // allow-italian: fixture data, shown as written
    { label: 'Scadenza del bando', value: '12.10.2026, ore 12:00' }, // allow-italian: fixture data, shown as written
  ],
  parts: [
    {
      id: 'lotto-1', short: 'Lotto 1', heading: 'Lotto 1 · progettazione e direzione dei lavori', // allow-italian: fixture data, shown as written
      quote: 'servizi di ingegneria relativi alla progettazione, la direzione dei lavori, il coordinamento della sicurezza e le prestazioni accessorie relative agli interventi del Piano Triennale OO.PP. 2026/2028', // allow-italian: fixture data, shown as written
      summary: 'Il lotto 1 copre progettazione, direzione dei lavori, sicurezza e prestazioni accessorie degli interventi del Piano triennale. Il contratto con chi vince è un accordo quadro: ogni incarico parte con un ordinativo del RUP.', // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'contract', id: 'ct-ingegneria-lotto1', at: 'art-1', why: "L'oggetto dell'accordo quadro è quello del lotto 1" }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'CT-2403', why: 'Primo incarico del lotto 1, sul Canale Lauro' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'lotto 1 progettazione direzione dei lavori coordinamento sicurezza piano triennale opere pubbliche', // allow-italian: fixture data, shown as written
    },
    {
      id: 'lotto-2', short: 'Lotto 2', heading: 'Lotto 2 · verifica della progettazione e BIM', // allow-italian: fixture data, shown as written
      quote: 'servizi di ingegneria relativi alla verifica della progettazione nonché la verifica del processo di gestione informativa e degli attinenti modelli BIM', // allow-italian: fixture data, shown as written
      summary: "Il lotto 2 copre la verifica dei progetti e dei modelli BIM. Chi lo vince non può verificare i progetti del lotto 1: il contratto lo scrive e l'agente lo controlla a ogni ordinativo.", // allow-italian: fixture data, shown as written
      citedBy: [
        { kind: 'contract', id: 'ct-ingegneria-lotto2', at: 'art-1', why: "L'oggetto dell'accordo quadro è quello del lotto 2" }, // allow-italian: fixture data, shown as written
        { kind: 'card', id: 'CT-2400', why: 'Primo incarico del lotto 2, rilievi del Torrente Calvagnola' }, // allow-italian: fixture data, shown as written
      ],
      keywords: 'lotto 2 verifica progettazione bim gestione informativa modelli', // allow-italian: fixture data, shown as written
    },
    {
      id: 'termini', short: 'Termini di gara', heading: 'Termini di gara modificati', // allow-italian: fixture data, shown as written
      quote: 'con atto gestionale del Responsabile della CUC del Lago di Occhito n.217 del 25.09.2026 i termini di gara sono stati modificati', // allow-italian: fixture data, shown as written
      summary: "I chiarimenti si chiedevano fino al 05.10.2026 e le offerte fino al 12.10.2026, ore 12:00. L'esito della gara non è sul sito del Consorzio: aggiudicatari, importi e date di firma dei due contratti sono esempi.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-contratti', at: 's1', why: 'Il bando e il disciplinare sono il primo documento che l\'agente legge' }], // allow-italian: fixture data, shown as written
      keywords: 'termini di gara proroga chiarimenti scadenza bando cuc lago di occhito commissione giudicatrice', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v-proroga', label: 'Avviso di proroga del 25/09/2026', detail: "Termini modificati dalla CUC: chiarimenti entro il 05.10.2026, bando entro il 12.10.2026.", status: { text: 'Pubblicato', tone: 'neutral' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'accordo quadro ingegneria servizi lotti programmazione triennale 2026 2028', // allow-italian: fixture data, shown as written
};

/* ---------- procedures ---------- */

const PROC_PEC: KnowledgeDoc = {
  id: 'proc-pec', collection: 'procedure', label: 'Come si protocolla una PEC', // allow-italian: fixture data, shown as written
  title: 'Come si protocolla una PEC', // allow-italian: fixture data, shown as written
  subtitle: 'Dalla casella protocollo al fascicolo assegnato al team', // allow-italian: fixture data, shown as written
  issuer: 'Consorzio, Protocollo e segreteria', // allow-italian: fixture data, shown as written
  note: 'Approvata dal Protocollo il 12/10', // allow-italian: fixture data, shown as written
  status: { text: 'Approvata', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [],
  procedure: {
    writtenBy: 'ag-pec', writtenAt: '2026-10-05', state: 'approved', approver: 'cn-protocollo', approvedAt: '2026-10-12', area: 'protocollo',
    flows: ['nocera-pec'], programs: ['PEC Aruba', 'Prunes', 'Halley'], // allow-italian: fixture data, shown as written
    time: 'circa 4 minuti a PEC', // allow-italian: fixture data, shown as written
    basedOn: 'le PEC protocollate nelle prime due settimane di ottobre', // allow-italian: fixture data, shown as written
    mistakes: 'Contare i 60 giorni da una data diversa dalla consegna della PEC; protocollare senza la ricevuta di consegna; assegnare un ricorso al team sbagliato; trattare come nuova una PEC già protocollata.', // allow-italian: fixture data, shown as written
  },
  parts: [
    {
      id: 's1', short: 'Passo 1', heading: 'Passo 1 · Leggere la PEC e gli allegati', // allow-italian: fixture data, shown as written
      summary: "Dalla casella protocollo l'agente legge mittente, oggetto, firme e ricevuta di consegna, e il testo degli allegati. Se un allegato non si apre o la firma non è valida, lo segna e non lo interpreta.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-pec', at: 's1', why: 'Il passo del flusso che lo applica' }, { kind: 'card', id: 'PEC-2421', why: 'Comunicazione della Regione sulla L.R. 7/2025' }], // allow-italian: fixture data, shown as written
      keywords: 'leggere pec allegati mittente firme ricevuta di consegna', // allow-italian: fixture data, shown as written
    },
    {
      id: 's2', short: 'Passo 2', heading: 'Passo 2 · Riconoscere il tipo e proporre il team', // allow-italian: fixture data, shown as written
      summary: "L'agente riconosce il tipo (ricorso, accesso agli atti, istanza di sgravio, comunicazione della Regione, fattura) e propone il team e la voce del titolario, con la sicurezza che ha. Sotto soglia lo dice e aspetta il Protocollo.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-pec', at: 's2', why: 'Tipo, team e voce del titolario' }], // allow-italian: fixture data, shown as written
      keywords: 'tipo di pec team titolario smistamento', // allow-italian: fixture data, shown as written
    },
    {
      id: 's3', short: 'Passo 3', heading: "Passo 3 · Trovare il contribuente e l'avviso", // allow-italian: fixture data, shown as written
      summary: "Per un ricorso o un'istanza il contribuente e l'avviso contestato si cercano nel catasto consortile (Prunes). La classifica dell'avviso si confronta con il Piano di Classifica.", // allow-italian: fixture data, shown as written
      rests: ['piano-classifica-1996/riparto'],
      citedBy: [{ kind: 'flow', id: 'nocera-pec', at: 's3', why: 'Ricerca in Prunes' }, { kind: 'card', id: 'PEC-2418', why: "Ricorso di un'azienda agricola" }], // allow-italian: fixture data, shown as written
      keywords: 'contribuente avviso prunes catasto consortile classifica', // allow-italian: fixture data, shown as written
    },
    {
      id: 's4', short: 'Passo 4', heading: 'Passo 4 · Calcolare le scadenze', // allow-italian: fixture data, shown as written
      summary: "Il termine corre dalla consegna della PEC: 60 giorni per costituirsi in giudizio, 30 per rispondere a un accesso agli atti. Se l'ultimo giorno è un sabato, una domenica o un festivo, il termine passa al primo giorno lavorativo.", // allow-italian: fixture data, shown as written
      rests: ['dlgs-546-1992/art-23', 'dlgs-33-2013/art-5-c6'],
      citedBy: [{ kind: 'flow', id: 'nocera-pec', at: 's4', why: 'Il passo che calcola le scadenze' }, { kind: 'card', id: 'PEC-2419', why: 'Accesso civico: 30 giorni' }], // allow-italian: fixture data, shown as written
      keywords: 'scadenze sessanta trenta giorni consegna pec costituzione accesso', // allow-italian: fixture data, shown as written
    },
    {
      id: 's5', short: 'Passo 5', heading: 'Passo 5 · La verifica del Protocollo', // allow-italian: fixture data, shown as written
      summary: 'Il responsabile del protocollo conferma tipo, team e scadenza. Niente passa al team senza la sua conferma.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-pec', at: 's5', why: 'Verifica del Protocollo' }], // allow-italian: fixture data, shown as written
      keywords: 'verifica protocollo conferma responsabile', // allow-italian: fixture data, shown as written
    },
    {
      id: 's6', short: 'Passo 6', heading: "Passo 6 · Ricorsi e atti giudiziari: l'avvocato interno", // allow-italian: fixture data, shown as written
      summary: "Un ricorso o un atto giudiziario lo verifica l'avvocato interno: parti, corte, termini. Solo dopo la sua verifica il ricorso va alla direzione.", // allow-italian: fixture data, shown as written
      rests: ['dlgs-546-1992/art-23'],
      citedBy: [{ kind: 'flow', id: 'nocera-pec', at: 's6', why: "Verifica dell'avvocato interno" }], // allow-italian: fixture data, shown as written
      keywords: 'avvocato interno ricorso atti giudiziari parti corte termini', // allow-italian: fixture data, shown as written
    },
    {
      id: 's7', short: 'Passo 7', heading: 'Passo 7 · Approvazione e protocollo in Halley', // allow-italian: fixture data, shown as written
      summary: "La direzione approva l'incarico al legale o la risposta; poi l'atto si protocolla in Halley, si apre il fascicolo e lo si assegna al team.", // allow-italian: fixture data, shown as written
      rests: ['albo-legali-2026/albo', 'contract:ct-albo-legali/art-1'],
      citedBy: [{ kind: 'flow', id: 'nocera-pec', at: 's7', why: 'Approvazione della direzione' }, { kind: 'flow', id: 'nocera-pec', at: 's8', why: 'Protocollo in Halley' }], // allow-italian: fixture data, shown as written
      keywords: 'approvazione direzione protocollo halley fascicolo incarico al legale', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v1', label: 'Versione 1', detail: "Scritta dall'agente PEC e protocollo il 05/10, approvata dal Protocollo il 12/10.", status: { text: 'Approvata', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'procedura pec protocollo smistamento scadenze titolario', // allow-italian: fixture data, shown as written
};

const PROC_CROSSING: KnowledgeDoc = {
  id: 'proc-concessione', collection: 'procedure', label: 'Come si concede un attraversamento', // allow-italian: fixture data, shown as written
  title: 'Come si concede un attraversamento di un canale', // allow-italian: fixture data, shown as written
  subtitle: "Dalla richiesta alla concessione firmata e inviata", // allow-italian: fixture data, shown as written
  issuer: 'Consorzio, Tecnico e manutenzione', // allow-italian: fixture data, shown as written
  note: "Scritta dall'agente concessioni il 04/11 dalle richieste di attraversamento e di scarico dell'anno", // allow-italian: fixture data, shown as written
  status: { text: "scritta dall'agente, da approvare", tone: 'amber' }, // allow-italian: fixture data, shown as written
  facts: [],
  procedure: {
    writtenBy: 'ag-concessioni', writtenAt: '2026-11-04', state: 'draft', approver: 'cn-dg', area: 'tecnica',
    flows: ['nocera-concessioni'], programs: ['Prunes', 'QGIS', 'AutoCAD', 'PEC Aruba', 'Halley'], // allow-italian: fixture data, shown as written
    time: "entro 30 giorni dall'istanza (esempio)", // allow-italian: fixture data, shown as written
    basedOn: "le richieste di attraversamento e di scarico dell'anno", // allow-italian: fixture data, shown as written
    mistakes: "Rispondere senza il parere del Tecnico; dimenticare che un tratto nel reticolo regionale segue anche il R.D. 523/1904; non collegare la concessione alla particella, così la prossima richiesta sullo stesso canale non la trova.", // allow-italian: fixture data, shown as written
  },
  parts: [
    {
      id: 's1', short: 'Passo 1', heading: 'Passo 1 · Leggere la richiesta', // allow-italian: fixture data, shown as written
      summary: "L'agente legge chi chiede, per che opera (attraversamento o scarico), su quale canale e particella, e che allegati ci sono. Quello che manca lo segna da chiedere.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-concessioni', at: 's1', why: 'Il passo del flusso che lo applica' }, { kind: 'card', id: 'CO-2386', why: 'Richiesta di un ponticello sul Canale Macchione' }], // allow-italian: fixture data, shown as written
      keywords: 'richiesta concessione attraversamento scarico canale particella', // allow-italian: fixture data, shown as written
    },
    {
      id: 's2', short: 'Passo 2', heading: 'Passo 2 · Proprietà e particella in Prunes', // allow-italian: fixture data, shown as written
      summary: 'La particella e il proprietario si verificano nel catasto consortile. Chi non è il proprietario deve portare il titolo.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-concessioni', at: 's2', why: 'Verifica in Prunes' }], // allow-italian: fixture data, shown as written
      keywords: 'proprietà particella prunes catasto consortile titolo', // allow-italian: fixture data, shown as written
    },
    {
      id: 's3', short: 'Passo 3', heading: 'Passo 3 · Il tracciato sulla mappa', // allow-italian: fixture data, shown as written
      summary: "Il tracciato si porta su QGIS: canale, tratto, distanze dalle sponde. Se il tratto è anche nel reticolo regionale lo segna, perché cambia la norma.", // allow-italian: fixture data, shown as written
      rests: ['rd-368-1904/art-134', 'rd-523-1904/art-93'],
      citedBy: [{ kind: 'flow', id: 'nocera-concessioni', at: 's3', why: 'Tracciato in QGIS' }], // allow-italian: fixture data, shown as written
      keywords: 'tracciato mappa qgis canale tratto reticolo regionale', // allow-italian: fixture data, shown as written
    },
    {
      id: 's4', short: 'Passo 4', heading: 'Passo 4 · Le tavole e le integrazioni', // allow-italian: fixture data, shown as written
      summary: "L'agente legge le tavole DWG: sezione del canale, quote, tipo di attraversamento. Se mancano elaborati o dati catastali chiede l'integrazione e il termine si ferma finché non arriva.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-concessioni', at: 's4', why: 'Lettura delle tavole in AutoCAD' }], // allow-italian: fixture data, shown as written
      keywords: 'tavole dwg autocad elaborato grafico integrazione sezione quote', // allow-italian: fixture data, shown as written
    },
    {
      id: 's5', short: 'Passo 5', heading: 'Passo 5 · Disciplinare e canone', // allow-italian: fixture data, shown as written
      summary: "L'agente prepara il disciplinare con le prescrizioni e propone il canone, che il Tecnico ricontrolla.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-concessioni', at: 's5', why: 'Bozza di disciplinare e canone' }], // allow-italian: fixture data, shown as written
      keywords: 'disciplinare canone prescrizioni concessione bozza', // allow-italian: fixture data, shown as written
    },
    {
      id: 's6', short: 'Passo 6', heading: 'Passo 6 · Sopralluogo e parere del Tecnico', // allow-italian: fixture data, shown as written
      summary: "Il Tecnico va sul posto e dà il parere: distanze dalle sponde, sezione idraulica, tipo di attraversamento. Senza parere non si risponde.", // allow-italian: fixture data, shown as written
      rests: ['rd-368-1904/art-134', 'rd-523-1904/art-93'],
      citedBy: [{ kind: 'flow', id: 'nocera-concessioni', at: 's6', why: 'Sopralluogo e parere' }, { kind: 'card', id: 'CO-2386', why: 'Parere del Tecnico sul ponticello' }], // allow-italian: fixture data, shown as written
      keywords: 'sopralluogo parere tecnico distanze sponde sezione idraulica', // allow-italian: fixture data, shown as written
    },
    {
      id: 's7', short: 'Passo 7', heading: 'Passo 7 · La direzione firma', // allow-italian: fixture data, shown as written
      summary: 'La concessione la firma la direzione, con le prescrizioni del parere. Un agente non firma.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-concessioni', at: 's7', why: 'Firma della direzione' }], // allow-italian: fixture data, shown as written
      keywords: 'firma direzione concessione prescrizioni parere', // allow-italian: fixture data, shown as written
    },
    {
      id: 's8', short: 'Passo 8', heading: 'Passo 8 · Invio e protocollo', // allow-italian: fixture data, shown as written
      summary: "La concessione parte via PEC e si protocolla in Halley, legata alla particella: la prossima richiesta sullo stesso canale la trova.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-concessioni', at: 's8', why: 'Invio via PEC e protocollo' }], // allow-italian: fixture data, shown as written
      keywords: 'invio pec protocollo halley concessione particella', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v1', label: 'Versione 1', detail: "Scritta dall'agente concessioni idrauliche il 04/11 alle 16:40.", status: { text: 'Da approvare', tone: 'amber' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'procedura concessione attraversamento scarico canale consortile permesso', // allow-italian: fixture data, shown as written
};

const PROC_REPORT: KnowledgeDoc = {
  id: 'proc-verbale', collection: 'procedure', label: 'Come si scrive un verbale', // allow-italian: fixture data, shown as written
  title: 'Come si scrive un verbale di polizia idraulica', // allow-italian: fixture data, shown as written
  subtitle: "Dall'accertamento sul posto alla notifica", // allow-italian: fixture data, shown as written
  issuer: 'Consorzio, Polizia idraulica', // allow-italian: fixture data, shown as written
  note: "Approvata dall'ufficiale idraulico il 18/09", // allow-italian: fixture data, shown as written
  status: { text: 'Approvata', tone: 'green' }, // allow-italian: fixture data, shown as written
  facts: [],
  procedure: {
    writtenBy: 'ag-polizia', writtenAt: '2026-09-10', state: 'approved', approver: 'cn-polizia', approvedAt: '2026-09-18', area: 'polizia',
    flows: ['nocera-polizia'], programs: ['QGIS', 'Halley', 'SEND'], // allow-italian: fixture data, shown as written
    time: 'subito dopo il sopralluogo (esempio)', // allow-italian: fixture data, shown as written
    basedOn: 'i verbali notificati dell\'estate', // allow-italian: fixture data, shown as written
    mistakes: 'Citare una sola norma quando il tratto è nel reticolo regionale; mandare il verbale alla Regione invece di contestarlo; dimenticare la segnalazione agli enti dopo la notifica.', // allow-italian: fixture data, shown as written
  },
  parts: [
    {
      id: 's1', short: 'Passo 1', heading: 'Passo 1 · Il verbale accertato sul posto', // allow-italian: fixture data, shown as written
      summary: "L'ufficiale idraulico o il sorvegliante accerta la violazione sul posto. L'agente legge il verbale e ne ricava chi, dove, che cosa e quando; un dato che manca lo segna.", // allow-italian: fixture data, shown as written
      rests: ['regolamento-polizia-idraulica/servizio', 'libro-anno-2025/polizia-idraulica'],
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's1', why: 'Lettura del verbale' }, { kind: 'card', id: 'VP-2395', why: 'Verbale sul Torrente Lavinaio' }], // allow-italian: fixture data, shown as written
      keywords: 'accertamento ufficiale idraulico sorvegliante verbale violazione', // allow-italian: fixture data, shown as written
    },
    {
      id: 's2', short: 'Passo 2', heading: 'Passo 2 · Localizzare il tratto', // allow-italian: fixture data, shown as written
      summary: 'Il tratto si localizza su QGIS: se è un canale di bonifica o un corso d\'acqua del reticolo regionale, e in quale comune.', // allow-italian: fixture data, shown as written
      rests: ['rd-368-1904/polizia-bonifica', 'rd-523-1904/polizia-reticolo'],
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's2', why: 'Localizzazione in QGIS' }], // allow-italian: fixture data, shown as written
      keywords: 'localizzare tratto qgis canale bonifica reticolo regionale comune', // allow-italian: fixture data, shown as written
    },
    {
      id: 's3', short: 'Passo 3', heading: 'Passo 3 · Indicare la norma violata', // allow-italian: fixture data, shown as written
      summary: "Si cita il R.D. 368/1904 per le opere di bonifica, il R.D. 523/1904 per il reticolo regionale, il Regolamento del Consorzio: tutte le norme che valgono sul tratto, non una sola.", // allow-italian: fixture data, shown as written
      rests: ['lr-7-2025/art-10-c2-b', 'rd-368-1904/art-133', 'rd-523-1904/art-96', 'regolamento-polizia-idraulica/oggetto'],
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's3', why: 'Protocollo del verbale in Halley' }], // allow-italian: fixture data, shown as written
      keywords: 'norma violata articolo rd 368 rd 523 regolamento', // allow-italian: fixture data, shown as written
    },
    {
      id: 's4', short: 'Passo 4', heading: 'Passo 4 · Notifica e scritti difensivi', // allow-italian: fixture data, shown as written
      summary: "L'agente prepara la notifica e segna i 30 giorni entro cui chi riceve il verbale può presentare scritti difensivi.", // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's4', why: 'Notifica e 30 giorni per gli scritti difensivi' }], // allow-italian: fixture data, shown as written
      keywords: 'notifica scritti difensivi trenta giorni verbale', // allow-italian: fixture data, shown as written
    },
    {
      id: 's5', short: 'Passo 5', heading: "Passo 5 · La verifica dell'ufficiale idraulico", // allow-italian: fixture data, shown as written
      summary: "L'ufficiale idraulico controlla che il verbale dica quello che ha accertato. Il Consorzio contesta da solo, senza aspettare la Regione.", // allow-italian: fixture data, shown as written
      rests: ['lr-7-2025/art-10-c2-b'],
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's5', why: "Verifica dell'ufficiale idraulico" }], // allow-italian: fixture data, shown as written
      keywords: 'verifica ufficiale idraulico contestazione consorzio da solo', // allow-italian: fixture data, shown as written
    },
    {
      id: 's6', short: 'Passo 6', heading: 'Passo 6 · La sanzione e la verifica del Legale', // allow-italian: fixture data, shown as written
      summary: 'Il Legale verifica la norma e la sanzione secondo la L.R. 13/1983. La sanzione non si inventa e non si copia da un altro verbale.', // allow-italian: fixture data, shown as written
      rests: ['lr-13-1983/sanzioni', 'lr-7-2025/art-10-c2-c'],
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's6', why: 'Verifica del Legale' }], // allow-italian: fixture data, shown as written
      keywords: 'sanzione legale verifica lr 13 1983 importo', // allow-italian: fixture data, shown as written
    },
    {
      id: 's7', short: 'Passo 7', heading: 'Passo 7 · La direzione firma la notifica', // allow-italian: fixture data, shown as written
      summary: 'La notifica la firma la direzione. Senza la sua firma niente parte.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's7', why: 'Firma della direzione' }], // allow-italian: fixture data, shown as written
      keywords: 'firma direzione notifica verbale', // allow-italian: fixture data, shown as written
    },
    {
      id: 's8', short: 'Passo 8', heading: 'Passo 8 · Notifica via SEND e segnalazione agli enti', // allow-italian: fixture data, shown as written
      summary: 'La notifica parte da SEND. Poi si segnala la violazione al Comune, alla Provincia o alla Regione e, se serve, all\'Autorità Giudiziaria; il provento della sanzione va alla Ragioneria con il vincolo della manutenzione delle opere vigilate.', // allow-italian: fixture data, shown as written
      rests: ['send-2026/send', 'regolamento-polizia-idraulica/iter', 'lr-13-1983/proventi'],
      citedBy: [{ kind: 'flow', id: 'nocera-polizia', at: 's8', why: 'Notifica via SEND' }, { kind: 'card', id: 'VP-2399', why: 'Fascia di rispetto occupata, notificata con SEND' }], // allow-italian: fixture data, shown as written
      keywords: 'notifica send segnalazione enti proventi ragioneria ripristino stato dei luoghi', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v1', label: 'Versione 1', detail: "Scritta dall'agente polizia idraulica il 10/09, approvata dall'ufficiale idraulico il 18/09.", status: { text: 'Approvata', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'procedura verbale polizia idraulica sanzione notifica send', // allow-italian: fixture data, shown as written
};

const PROC_IRRIGATION: KnowledgeDoc = {
  id: 'proc-turno', collection: 'procedure', label: 'Come si assegna un turno irriguo', // allow-italian: fixture data, shown as written
  title: 'Come si assegna un turno irriguo', // allow-italian: fixture data, shown as written
  subtitle: 'Dalla richiesta del consorziato al calendario aggiornato', // allow-italian: fixture data, shown as written
  issuer: 'Consorzio, Irrigazione', // allow-italian: fixture data, shown as written
  note: "Scritta dall'agente turni irrigui il 05/11 dalle richieste di turno dell'estate", // allow-italian: fixture data, shown as written
  status: { text: "scritta dall'agente, da approvare", tone: 'amber' }, // allow-italian: fixture data, shown as written
  facts: [],
  procedure: {
    writtenBy: 'ag-irrigazione', writtenAt: '2026-11-05', state: 'draft', approver: 'cn-dg', area: 'irrigazione',
    flows: ['nocera-irrigazione'], programs: ['Prunes'], // allow-italian: fixture data, shown as written
    time: 'circa 6 minuti a richiesta', // allow-italian: fixture data, shown as written
    basedOn: "le richieste di turno dell'estate", // allow-italian: fixture data, shown as written
    mistakes: 'Assegnare un turno senza guardare le vasche; confermare al richiedente prima di avvisare il personale di zona; sovrapporre due turni sullo stesso canale a scorrimento.', // allow-italian: fixture data, shown as written
  },
  parts: [
    {
      id: 's1', short: 'Passo 1', heading: 'Passo 1 · Leggere la richiesta', // allow-italian: fixture data, shown as written
      summary: 'Dal modulo del sito l\'agente legge chi chiede, il bacino, la particella, gli ettari e la coltura. Un dato che manca lo chiede, non lo suppone.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-irrigazione', at: 's1', why: 'Il passo del flusso che lo applica' }, { kind: 'card', id: 'IR-2414', why: 'Turno per finocchio a San Valentino Torio' }], // allow-italian: fixture data, shown as written
      keywords: 'richiesta turno bacino particella coltura ettari modulo', // allow-italian: fixture data, shown as written
    },
    {
      id: 's2', short: 'Passo 2', heading: 'Passo 2 · Bacino e particella', // allow-italian: fixture data, shown as written
      summary: "La particella deve essere in uno dei sette bacini di irrigazione collettiva e il richiedente deve essere in regola con il contributo. Si controlla in Prunes e sul Piano di Classifica.", // allow-italian: fixture data, shown as written
      rests: ['piano-classifica-1996/irrigazione', 'libro-anno-2025/irrigazione'],
      citedBy: [{ kind: 'flow', id: 'nocera-irrigazione', at: 's2', why: 'Verifica di bacino e particella' }], // allow-italian: fixture data, shown as written
      keywords: 'bacino particella sette bacini prunes piano di classifica', // allow-italian: fixture data, shown as written
    },
    {
      id: 's3', short: 'Passo 3', heading: 'Passo 3 · Turni già assegnati e acqua disponibile', // allow-italian: fixture data, shown as written
      summary: "Si guardano i turni già assegnati sullo stesso canale o gruppo di consegna e quanta acqua c'è: pozzi disponibili e livello delle vasche di accumulo.", // allow-italian: fixture data, shown as written
      rests: ['libro-anno-2025/pozzi'],
      citedBy: [{ kind: 'flow', id: 'nocera-irrigazione', at: 's3', why: 'Ricerca dei turni già assegnati' }], // allow-italian: fixture data, shown as written
      keywords: 'turni assegnati pozzi vasche acqua disponibile livello', // allow-italian: fixture data, shown as written
    },
    {
      id: 's4', short: 'Passo 4', heading: 'Passo 4 · Proporre giorno e ora', // allow-italian: fixture data, shown as written
      summary: "L'agente propone il primo giorno e la prima ora liberi. Nel bacino di Paludi i gruppi di consegna sono automatizzati e il turno si programma sul telecontrollo; nei canali a scorrimento lo esegue il personale di zona.", // allow-italian: fixture data, shown as written
      rests: ['libro-anno-2025/bacino-paludi'],
      citedBy: [{ kind: 'flow', id: 'nocera-irrigazione', at: 's4', why: 'Proposta di giorno e ora' }], // allow-italian: fixture data, shown as written
      keywords: 'proposta giorno ora turno paludi telecontrollo scorrimento', // allow-italian: fixture data, shown as written
    },
    {
      id: 's5', short: 'Passo 5', heading: 'Passo 5 · La verifica del tecnico del bacino', // allow-italian: fixture data, shown as written
      summary: 'Il responsabile irrigazione verifica la proposta con quello che sa del bacino. Quando conferma, il personale di zona è avvisato prima del richiedente.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-irrigazione', at: 's5', why: 'Verifica del tecnico del bacino' }], // allow-italian: fixture data, shown as written
      keywords: 'verifica tecnico bacino personale di zona avviso', // allow-italian: fixture data, shown as written
    },
    {
      id: 's6', short: 'Passo 6', heading: 'Passo 6 · Turni fuori calendario', // allow-italian: fixture data, shown as written
      summary: 'Un turno fuori dal calendario ordinario lo approva la direzione. Gli altri non passano da lei.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-irrigazione', at: 's6', why: 'Approvazione dei turni fuori calendario' }], // allow-italian: fixture data, shown as written
      keywords: 'turno fuori calendario emergenza approvazione direzione', // allow-italian: fixture data, shown as written
    },
    {
      id: 's7', short: 'Passo 7', heading: 'Passo 7 · Calendario e avviso', // allow-italian: fixture data, shown as written
      summary: 'Il calendario si aggiorna e il richiedente riceve giorno e ora. A fine turno si registra la durata, per la contabilità dell\'acqua.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-irrigazione', at: 's7', why: 'Aggiornamento del calendario e avviso' }, { kind: 'card', id: 'IR-2414', why: 'Turno comunicato' }], // allow-italian: fixture data, shown as written
      keywords: 'calendario avviso durata turno contabilità acqua', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v1', label: 'Versione 1', detail: "Scritta dall'agente turni irrigui il 05/11 alle 18:05.", status: { text: 'Da approvare', tone: 'amber' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'procedura turno irriguo bacino irrigazione pozzi vasche richiesta', // allow-italian: fixture data, shown as written
};

const PROC_APPEAL: KnowledgeDoc = {
  id: 'proc-ricorso', collection: 'procedure', label: 'Come si tratta un ricorso sul contributo', // allow-italian: fixture data, shown as written
  title: 'Come si tratta un ricorso contro un avviso di contributo', // allow-italian: fixture data, shown as written
  subtitle: "Dalla PEC con il ricorso al deposito delle controdeduzioni e all'eventuale appello", // allow-italian: fixture data, shown as written
  issuer: 'Consorzio, Legale e gare', // allow-italian: fixture data, shown as written
  note: "Scritta dall'agente PEC e protocollo il 03/11 dai ricorsi già depositati", // allow-italian: fixture data, shown as written
  status: { text: "scritta dall'agente, da approvare", tone: 'amber' }, // allow-italian: fixture data, shown as written
  facts: [],
  procedure: {
    writtenBy: 'ag-pec', writtenAt: '2026-11-03', state: 'draft', approver: 'cn-dg', area: 'legale',
    flows: ['nocera-pec'], programs: ['PEC Aruba', 'Prunes', 'PA Legal', 'Halley'], // allow-italian: fixture data, shown as written
    time: 'termine di 60 giorni dalla notifica del ricorso', // allow-italian: fixture data, shown as written
    basedOn: 'le controdeduzioni dei ricorsi già depositati', // allow-italian: fixture data, shown as written
    mistakes: 'Contare i 60 giorni da una data diversa dalla consegna della PEC; depositare dopo la scadenza; dimenticare di prendere posizione su uno dei motivi del ricorso; lasciare passare il termine dell\'appello.', // allow-italian: fixture data, shown as written
  },
  parts: [
    {
      id: 's1', short: 'Passo 1', heading: 'Passo 1 · Registrare il ricorso e calcolare il termine', // allow-italian: fixture data, shown as written
      summary: "Si registra il ricorso e si calcolano i 60 giorni dalla consegna della PEC, spostati al primo giorno lavorativo se l'ultimo cade di sabato, domenica o festivo.", // allow-italian: fixture data, shown as written
      rests: ['dlgs-546-1992/art-23'],
      citedBy: [{ kind: 'flow', id: 'nocera-pec', at: 's4', why: 'Calcolo delle scadenze' }, { kind: 'card', id: 'PEC-2418', why: 'Ricorso di un\'azienda agricola' }], // allow-italian: fixture data, shown as written
      keywords: 'registrare ricorso termine sessanta giorni consegna pec', // allow-italian: fixture data, shown as written
    },
    {
      id: 's2', short: 'Passo 2', heading: "Passo 2 · L'avviso e la prova della notifica", // allow-italian: fixture data, shown as written
      summary: "Si chiede a Catasto e ruoli l'avviso di contributo contestato e la prova della sua notifica: l'avviso notificato da SEND ha la ricevuta di avvenuta consegna.", // allow-italian: fixture data, shown as written
      rests: ['send-2026/avn'],
      citedBy: [{ kind: 'flow', id: 'nocera-pec', at: 's3', why: 'Ricerca in Prunes' }], // allow-italian: fixture data, shown as written
      keywords: 'avviso contributo prova notifica ricevuta consegna catasto ruoli', // allow-italian: fixture data, shown as written
    },
    {
      id: 's3', short: 'Passo 3', heading: 'Passo 3 · Classifica e riparto', // allow-italian: fixture data, shown as written
      summary: "Si controlla che la classifica dell'immobile e il riparto dell'avviso siano quelli del Piano di Classifica.", // allow-italian: fixture data, shown as written
      rests: ['piano-classifica-1996/riparto'],
      citedBy: [{ kind: 'card', id: 'PEC-2418', why: 'Il ricorso contesta la classifica' }], // allow-italian: fixture data, shown as written
      keywords: 'classifica riparto piano di classifica avviso controllo', // allow-italian: fixture data, shown as written
    },
    {
      id: 's4', short: 'Passo 4', heading: 'Passo 4 · Le controdeduzioni', // allow-italian: fixture data, shown as written
      summary: "L'agente prepara le controdeduzioni: posizione su ogni motivo, prove, eccezioni e conclusioni. L'avvocato interno le verifica.", // allow-italian: fixture data, shown as written
      rests: ['dlgs-546-1992/art-23'],
      citedBy: [{ kind: 'flow', id: 'nocera-pec', at: 's6', why: "Verifica dell'avvocato interno" }], // allow-italian: fixture data, shown as written
      keywords: 'controdeduzioni motivi prove eccezioni conclusioni avvocato interno', // allow-italian: fixture data, shown as written
    },
    {
      id: 's5', short: 'Passo 5', heading: "Passo 5 · L'incarico al legale", // allow-italian: fixture data, shown as written
      summary: "La direzione approva l'incarico a un legale dall'albo o la costituzione con l'avvocato interno. L'incarico ha il suo contratto, con compenso e informazione dopo ogni udienza.", // allow-italian: fixture data, shown as written
      rests: ['albo-legali-2026/albo', 'contract:ct-albo-legali/art-4'],
      citedBy: [{ kind: 'flow', id: 'nocera-pec', at: 's7', why: "Approvazione dell'incarico" }, { kind: 'card', id: 'PEC-2418', why: "Ricorso di un'azienda agricola: costituzione con un legale dell'albo" }], // allow-italian: fixture data, shown as written
      keywords: 'incarico legale albo costituzione compenso udienza direzione', // allow-italian: fixture data, shown as written
    },
    {
      id: 's6', short: 'Passo 6', heading: 'Passo 6 · Deposito e scadenze', // allow-italian: fixture data, shown as written
      summary: 'Le controdeduzioni si depositano per via telematica e si conserva la ricevuta. Scadenza e deposito si annotano in PA Legal.', // allow-italian: fixture data, shown as written
      citedBy: [{ kind: 'flow', id: 'nocera-pec', at: 's8', why: 'Fascicolo aperto e protocollato' }], // allow-italian: fixture data, shown as written
      keywords: 'deposito telematico ricevuta pa legal scadenza controdeduzioni', // allow-italian: fixture data, shown as written
    },
    {
      id: 's7', short: 'Passo 7', heading: "Passo 7 · Dopo la sentenza: l'appello", // allow-italian: fixture data, shown as written
      summary: "Se la sentenza è sfavorevole in tutto o in parte, la direzione decide se appellare. Il termine corre dalla notifica della sentenza: 60 giorni.", // allow-italian: fixture data, shown as written
      rests: ['dlgs-546-1992/art-38'],
      citedBy: [{ kind: 'contract', id: 'ct-albo-legali', at: 'art-5', why: "Il legale dà prova del deposito dell'appello 5 giorni prima della scadenza" }], // allow-italian: fixture data, shown as written
      keywords: 'appello sentenza termine notifica direzione decide estensione incarico', // allow-italian: fixture data, shown as written
    },
  ],
  versions: [
    { id: 'v1', label: 'Versione 1', detail: "Scritta dall'agente PEC e protocollo il 03/11 alle 17:30.", status: { text: 'Da approvare', tone: 'amber' }, current: true }, // allow-italian: fixture data, shown as written
  ],
  keywords: 'procedura ricorso contributo avviso costituzione in giudizio controdeduzioni appello', // allow-italian: fixture data, shown as written
};

export const NOCERA_KNOWLEDGE_DOCS: KnowledgeDoc[] = [
  REGIONAL_LAW_7, ROYAL_DECREE_368, ROYAL_DECREE_523, REGIONAL_LAW_13, POLICE_REGULATION, CLASSIFICATION_PLAN, TAX_PROCESS, TRANSPARENCY,
  YEARBOOK, SEND_NEWS, LAWYERS_ROLL, ENGINEERING_FRAMEWORK,
  PROC_PEC, PROC_CROSSING, PROC_REPORT, PROC_IRRIGATION, PROC_APPEAL,
];

/* ---------- questions people ask ---------- */

export const NOCERA_KNOWLEDGE_QUESTIONS: KnowledgeQuestion[] = [
  {
    question: 'Chi può contestare uno scarico abusivo in un canale consortile, e dove vanno i soldi della sanzione?', // allow-italian: fixture data, shown as written
    answer: [
      { text: "Il Consorzio stesso: è Autorità di Polizia Idraulica e accerta e contesta le violazioni del R.D. 368/1904 sulle opere di bonifica e del R.D. 523/1904 sul reticolo regionale.", source: 'lr-7-2025/art-10-c2-b' }, // allow-italian: fixture data, shown as written
      { text: "L'intero procedimento per la sanzione, secondo la L.R. 13/1983, è suo; i proventi vanno alla gestione e alla manutenzione delle opere vigilate.", source: 'lr-13-1983/proventi' }, // allow-italian: fixture data, shown as written
      { text: "Il servizio lo svolgono l'ufficiale idraulico e il sorvegliante.", source: 'regolamento-polizia-idraulica/servizio' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    question: 'In quanti giorni ci si costituisce in giudizio contro un ricorso sul contributo?', // allow-italian: fixture data, shown as written
    answer: [
      { text: 'Entro 60 giorni dalla notifica del ricorso, depositando le controdeduzioni.', source: 'dlgs-546-1992/art-23' }, // allow-italian: fixture data, shown as written
      { text: "Nella procedura del Consorzio l'agente conta i 60 giorni dalla consegna della PEC e porta il termine alla verifica dell'avvocato interno.", source: 'proc-pec/s4' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    question: 'Entro quanti giorni va risposto a una richiesta di accesso civico?', // allow-italian: fixture data, shown as written
    answer: [
      { text: 'Entro 30 giorni dalla presentazione, con un provvedimento espresso e motivato, anche quando si nega l\'accesso.', source: 'dlgs-33-2013/art-5-c6' }, // allow-italian: fixture data, shown as written
      { text: 'Il termine corre dalla consegna della PEC e si sposta al primo giorno lavorativo se cade di sabato, domenica o festivo.', source: 'proc-pec/s4' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    question: 'Quanti pozzi e quante vasche ha la rete irrigua?', // allow-italian: fixture data, shown as written
    answer: [
      { text: 'La rete è alimentata da 55 pozzi di falda profonda, per una portata di 2.503 litri al secondo, e ha 5 vasche di accumulo.', source: 'libro-anno-2025/pozzi' }, // allow-italian: fixture data, shown as written
      { text: 'Serve 7 bacini di irrigazione collettiva: 1.697 ettari irrigati su 10.131 irrigabili.', source: 'libro-anno-2025/irrigazione' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    question: 'I contributi dei consorziati possono pagare la manutenzione straordinaria dei canali?', // allow-italian: fixture data, shown as written
    answer: [
      { text: 'No: i tributi dei proprietari servono solo alla gestione e alla manutenzione ordinaria delle opere di bonifica.', source: 'lr-7-2025/art-21-c1' }, // allow-italian: fixture data, shown as written
      { text: 'Le opere di difesa del suolo si affidano con una convenzione che assegna le risorse finanziarie necessarie, senza ricorrere ai tributi dei consorziati.', source: 'lr-7-2025/art-6-c2' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    question: 'Come arriva a un contribuente un avviso di notifica, e quanto costa?', // allow-italian: fixture data, shown as written
    answer: [
      { text: 'Dal 2026 gli avvisi di notifica partono dalla piattaforma SEND di PagoPA.', source: 'send-2026/send' }, // allow-italian: fixture data, shown as written
      { text: "Costa 8,22 euro di gestione, comprensivi dei 2,73 euro dell'avviso di pagamento, più la spedizione, che varia con il canale e il peso.", source: 'send-2026/avn' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    question: "Un Comune può affidare al Consorzio interventi di difesa del suolo?", // allow-italian: fixture data, shown as written
    answer: [
      { text: 'Sì: il Consorzio può progettare ed eseguire interventi che gli affidano la Regione e gli enti locali, anche fuori dal comprensorio.', source: 'libro-anno-2025/interventi-affidati' }, // allow-italian: fixture data, shown as written
      { text: 'La difesa del suolo è un ambito delegabile dalla Regione, e le opere dell\'art. 6, comma 2 si affidano con una convenzione che assegna le risorse.', source: 'lr-7-2025/art-4' }, // allow-italian: fixture data, shown as written
    ],
  },
];
