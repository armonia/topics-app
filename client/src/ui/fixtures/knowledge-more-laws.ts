/**
 * The «Norme e leggi» collection. A law is split by article and comma. The (allow-italian: quotes the Italian interface)
 * wording is written only where it is known exactly (L. 241/1990 art. 2,
 * D.Lgs. 33/2013 art. 5, D.Lgs. 546/1992 art. 23 c.2, D.Lgs. 231/2002 art. 4
 * c.2 a, and art. 10 c.2 of the L.R. 7/2025 as the Consorzio printed it in its
 * 2025 yearbook); every other article says what it is about and that its text
 * is still to be loaded from the official source.
 */
import type { ItemSeed } from './knowledge-more';

const BURC = 'Bollettino Ufficiale della Regione Campania (BURC)'; // allow-italian: fixture data, shown as written
const NORMATTIVA = 'Normattiva, il portale della legislazione italiana'; // allow-italian: fixture data, shown as written

export const LAWS: ItemSeed[] = [
  {
    id: 'lr-7-2025',
    collection: 'norme',
    label: 'L.R. Campania 7/2025',
    title: 'Legge Regionale Campania 6 giugno 2025, n. 7', // allow-italian: fixture data, shown as written
    subtitle: 'abroga la L.R. 4/2003', // allow-italian: fixture data, shown as written
    status: { text: 'in vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: BURC,
    chips: [
      { id: 'a2', label: 'Art. 2 Comprensori', articleId: 'a2' },
      { id: 'a4', label: 'Art. 4 Difesa del suolo', articleId: 'a4' }, // allow-italian: fixture data, shown as written
      { id: 'a5', label: 'Art. 5 Piano', articleId: 'a5' }, // allow-italian: fixture data, shown as written
      { id: 'a9', label: 'Art. 9 Consorzi', articleId: 'a9c3' },
      { id: 'a10', label: 'Art. 10 Funzioni', articleId: 'a10c2' }, // allow-italian: fixture data, shown as written
    ],
    articles: [
      {
        id: 'a10c2',
        group: 'a10',
        heading: 'Art. 10, comma 2 · Autorità di Polizia Idraulica', // allow-italian: fixture data, shown as written
        source: "testo dal Libro dell'anno 2025, p. 444", // allow-italian: fixture data, shown as written
        page: 444,
        text: [
          'I Consorzi di Bonifica, nei rispettivi comprensori, sono Autorità di Polizia Idraulica addetta: a) alla vigilanza sulle opere di bonifica e di irrigazione …; b) ', // allow-italian: fixture data, shown as written
          { mark: "all'accertamento e alla contestazione delle violazioni" }, // allow-italian: fixture data, shown as written
          ' previste dal R.D. 368/1904 e dal R.D. 523/1904; c) all\'intero procedimento per ', // allow-italian: fixture data, shown as written
          { mark: 'le sanzioni di cui alla L.R. 13/1983' }, // allow-italian: fixture data, shown as written
          ', con i proventi destinati alla manutenzione delle opere vigilate.', // allow-italian: fixture data, shown as written
        ],
        rules: ['verbale anche senza la Regione', 'norma violata: R.D. 368 o 523', 'sanzione secondo L.R. 13/1983'], // allow-italian: fixture data, shown as written
      },
      {
        id: 'a10c1',
        group: 'a10',
        heading: 'Art. 10, comma 1 · Autosufficienza energetica', // allow-italian: fixture data, shown as written
        source: "riassunto dal Libro dell'anno 2025", // allow-italian: fixture data, shown as written
        text: ['I Consorzi possono perseguire l\'autosufficienza energetica con impianti da fonti rinnovabili.'], // allow-italian: fixture data, shown as written
      },
      {
        id: 'a9c3',
        group: 'a9',
        heading: 'Art. 9, comma 3',
        text: ['I Consorzi sono enti pubblici economici a carattere associativo.'], // allow-italian: fixture data, shown as written
      },
      {
        id: 'a5',
        group: 'a5',
        heading: 'Art. 5 · Piano comprensoriale di bonifica', // allow-italian: fixture data, shown as written
        source: "riassunto dal Libro dell'anno 2025", // allow-italian: fixture data, shown as written
        text: ['Sostituisce il piano generale di bonifica; strumento plurisettoriale sottoposto a VAS.'], // allow-italian: fixture data, shown as written
      },
      {
        id: 'a4',
        group: 'a4',
        heading: 'Art. 4 · Difesa del suolo', // allow-italian: fixture data, shown as written
        subject: 'Le funzioni di difesa del suolo, che i Consorzi possono svolgere per delega.', // allow-italian: fixture data, shown as written
      },
      {
        id: 'a2',
        group: 'a2',
        heading: 'Art. 2 · Comprensori', // allow-italian: fixture data, shown as written
        subject: 'Il riordino del territorio regionale in otto comprensori di bonifica.', // allow-italian: fixture data, shown as written
      },
    ],
    facts: [
      { label: 'Data', value: '6 giugno 2025' }, // allow-italian: fixture data, shown as written
      { label: 'Sostituisce', value: 'L.R. 4/2003', item: 'lr-4-2003' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale BURC', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [
      { label: 'Verbale di polizia idraulica', value: 'flusso suggerito', flow: 'verbale-polizia-idraulica' }, // allow-italian: fixture data, shown as written
      { label: 'Destinazione dei proventi', value: 'Ragioneria' }, // allow-italian: fixture data, shown as written
    ],
    versions: [
      { id: 'v-lr-4-2003', label: 'L.R. Campania 4/2003', detail: 'Norme in materia di bonifica integrale, abrogata dalla L.R. 7/2025. Resta solo come storico.', status: { text: 'abrogata', tone: 'red' }, item: 'lr-4-2003' }, // allow-italian: fixture data, shown as written
      { id: 'v-lr-7-riassunto', label: "L.R. Campania 7/2025, riassunto del Libro dell'anno 2025", detail: 'È il testo che l\'AI usa oggi: gli articoli 5, 9 e 10 come li ha pubblicati il Consorzio.', status: { text: 'in uso', tone: 'green' }, current: true }, // allow-italian: fixture data, shown as written
      { id: 'v-lr-7-burc', label: 'Testo ufficiale del BURC', detail: 'Da caricare: quando arriva sostituisce il riassunto e le regole ricavate si ricontrollano.', status: { text: 'da caricare', tone: 'amber' }, pending: true }, // allow-italian: fixture data, shown as written
    ],
    original: {
      heading: 'BOLLETTINO UFFICIALE DELLA REGIONE CAMPANIA', // allow-italian: fixture data, shown as written
      publication: [
        { label: 'Atto', value: 'Legge Regionale 6 giugno 2025, n. 7' }, // allow-italian: fixture data, shown as written
        { label: 'Pubblicato su', value: 'BURC, Regione Campania' }, // allow-italian: fixture data, shown as written
        { label: 'Abroga', value: 'L.R. Campania 4/2003' }, // allow-italian: fixture data, shown as written
        { label: 'Numero e data del BURC', value: 'da caricare con il testo' }, // allow-italian: fixture data, shown as written
      ],
      notLoaded: 'Il testo firmato del BURC non è ancora caricato. Finché manca, la scheda usa il riassunto pubblicato dal Consorzio.', // allow-italian: fixture data, shown as written
      page: 444,
    },
    refs: [
      { label: 'R.D. 368/1904', item: 'rd-368' },
      { label: 'R.D. 523/1904', item: 'rd-523' },
      { label: 'L.R. Campania 13/1983', item: 'lr-13-1983' },
      { label: 'L.R. Campania 4/2003, abrogata', item: 'lr-4-2003' }, // allow-italian: fixture data, shown as written
    ],
    flowRefs: [],
    keywords: 'bonifica comprensori consorzio regione campania polizia idraulica',
  },
  {
    id: 'lr-4-2003',
    collection: 'norme',
    label: 'L.R. Campania 4/2003',
    title: 'Legge Regionale Campania 25 febbraio 2003, n. 4', // allow-italian: fixture data, shown as written
    subtitle: 'abrogata dalla L.R. 7/2025', // allow-italian: fixture data, shown as written
    status: { text: 'abrogata', tone: 'red' }, // allow-italian: fixture data, shown as written
    officialSource: BURC,
    chips: [{ id: 'all', label: 'Intero testo', articleId: 'all' }], // allow-italian: fixture data, shown as written
    articles: [
      {
        id: 'all',
        group: 'all',
        heading: 'Intero testo', // allow-italian: fixture data, shown as written
        subject: 'Norme in materia di bonifica integrale. Abrogata dalla L.R. 7/2025: serve solo come storico delle pratiche aperte prima.', // allow-italian: fixture data, shown as written
      },
    ],
    facts: [
      { label: 'Data', value: '25 febbraio 2003' }, // allow-italian: fixture data, shown as written
      { label: 'Abrogata da', value: 'L.R. 7/2025', item: 'lr-7-2025' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale BURC', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [{ label: 'Uso nelle risposte', value: 'solo come storico' }], // allow-italian: fixture data, shown as written
    versions: [
      { id: 'v-lr-4-2003', label: 'L.R. Campania 4/2003', detail: 'Il testo che valeva prima del 6 giugno 2025.', status: { text: 'abrogata', tone: 'red' }, current: true }, // allow-italian: fixture data, shown as written
      { id: 'v-lr-7-2025', label: 'L.R. Campania 7/2025', detail: 'La legge che la sostituisce.', status: { text: 'in vigore', tone: 'green' }, item: 'lr-7-2025' }, // allow-italian: fixture data, shown as written
    ],
    original: {
      heading: 'BOLLETTINO UFFICIALE DELLA REGIONE CAMPANIA', // allow-italian: fixture data, shown as written
      publication: [
        { label: 'Atto', value: 'Legge Regionale 25 febbraio 2003, n. 4' }, // allow-italian: fixture data, shown as written
        { label: 'Pubblicato su', value: 'BURC, Regione Campania' }, // allow-italian: fixture data, shown as written
        { label: 'Abrogata da', value: 'L.R. Campania 7/2025' }, // allow-italian: fixture data, shown as written
      ],
      notLoaded: 'Il testo firmato non è caricato: la legge è abrogata e si tiene solo come storico.', // allow-italian: fixture data, shown as written
    },
    refs: [{ label: 'L.R. Campania 7/2025, che la abroga', item: 'lr-7-2025' }], // allow-italian: fixture data, shown as written
    flowRefs: [],
  },
  {
    id: 'rd-368',
    collection: 'norme',
    label: 'R.D. 368/1904',
    title: 'Regio Decreto 8 maggio 1904, n. 368', // allow-italian: fixture data, shown as written
    subtitle: 'regolamento sulle bonifiche: opere di bonifica e loro polizia', // allow-italian: fixture data, shown as written
    status: { text: 'in vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: NORMATTIVA,
    chips: [
      { id: 'a133', label: 'Art. 133 Lavori vietati', articleId: 'a133' }, // allow-italian: fixture data, shown as written
      { id: 'a134', label: 'Art. 134 Permesso', articleId: 'a134' }, // allow-italian: fixture data, shown as written
    ],
    articles: [
      {
        id: 'a133',
        group: 'a133',
        heading: 'Art. 133 · Lavori e atti vietati', // allow-italian: fixture data, shown as written
        subject: 'I lavori e gli atti vietati sulle opere di bonifica e sulle loro pertinenze.', // allow-italian: fixture data, shown as written
        rules: ['norma violata: R.D. 368 o 523'], // allow-italian: fixture data, shown as written
      },
      {
        id: 'a134',
        group: 'a134',
        heading: 'Art. 134 · Lavori e atti soggetti a permesso', // allow-italian: fixture data, shown as written
        subject: 'I lavori e gli atti che si possono eseguire solo con il permesso del Consorzio, come gli attraversamenti e gli scarichi nei canali.', // allow-italian: fixture data, shown as written
      },
    ],
    facts: [
      { label: 'Data', value: '8 maggio 1904' }, // allow-italian: fixture data, shown as written
      { label: 'Materia', value: 'opere di bonifica' }, // allow-italian: fixture data, shown as written
      { label: 'Vigilanza', value: 'Consorzio, L.R. 7/2025 art. 10' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [{ label: 'Verbale di polizia idraulica', value: 'norma violata', flow: 'verbale-polizia-idraulica' }], // allow-italian: fixture data, shown as written
    versions: [{ id: 'v-rd-368', label: 'R.D. 368/1904', detail: 'Testo vigente. Il testo ufficiale non è ancora caricato: la scheda dice di che cosa trattano gli articoli.', status: { text: 'in vigore', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'GAZZETTA UFFICIALE',
      publication: [
        { label: 'Atto', value: 'Regio Decreto 8 maggio 1904, n. 368' }, // allow-italian: fixture data, shown as written
        { label: 'Pubblicato su', value: 'Gazzetta Ufficiale del Regno' }, // allow-italian: fixture data, shown as written
        { label: 'Fonte', value: 'Normattiva' },
      ],
      notLoaded: "Il testo dell'originale non è ancora caricato dalla fonte ufficiale.", // allow-italian: fixture data, shown as written
    },
    refs: [{ label: 'L.R. Campania 7/2025, art. 10', item: 'lr-7-2025', article: 'a10c2' }],
    flowRefs: [],
    keywords: 'bonifica canali scarico attraversamento polizia idraulica permesso concessione', // allow-italian: fixture data, shown as written
  },
  {
    id: 'rd-523',
    collection: 'norme',
    label: 'R.D. 523/1904',
    title: 'Regio Decreto 25 luglio 1904, n. 523', // allow-italian: fixture data, shown as written
    subtitle: 'testo unico sulle opere idrauliche, reticolo regionale', // allow-italian: fixture data, shown as written
    status: { text: 'in vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: NORMATTIVA,
    chips: [
      { id: 'a93', label: 'Art. 93 Opere in alveo', articleId: 'a93' }, // allow-italian: fixture data, shown as written
      { id: 'a96', label: 'Art. 96 Lavori vietati', articleId: 'a96' }, // allow-italian: fixture data, shown as written
    ],
    articles: [
      {
        id: 'a93',
        group: 'a93',
        heading: 'Art. 93 · Opere in alveo', // allow-italian: fixture data, shown as written
        subject: "Le opere nell'alveo e sulle sponde dei corsi d'acqua: servono l'autorizzazione e la concessione dell'autorità.", // allow-italian: fixture data, shown as written
      },
      {
        id: 'a96',
        group: 'a96',
        heading: 'Art. 96 · Lavori e atti vietati', // allow-italian: fixture data, shown as written
        subject: "I lavori e gli atti vietati sulle acque pubbliche, sugli alvei, sulle sponde e sulle difese, comprese le distanze da rispettare.", // allow-italian: fixture data, shown as written
        rules: ['norma violata: R.D. 368 o 523'], // allow-italian: fixture data, shown as written
      },
    ],
    facts: [
      { label: 'Data', value: '25 luglio 1904' }, // allow-italian: fixture data, shown as written
      { label: 'Materia', value: 'reticolo regionale' }, // allow-italian: fixture data, shown as written
      { label: 'Vigilanza', value: 'Consorzio, L.R. 7/2025 art. 10' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [{ label: 'Verbale di polizia idraulica', value: 'norma violata', flow: 'verbale-polizia-idraulica' }], // allow-italian: fixture data, shown as written
    versions: [{ id: 'v-rd-523', label: 'R.D. 523/1904', detail: 'Testo vigente. Il testo ufficiale non è ancora caricato.', status: { text: 'in vigore', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'GAZZETTA UFFICIALE',
      publication: [
        { label: 'Atto', value: 'Regio Decreto 25 luglio 1904, n. 523' }, // allow-italian: fixture data, shown as written
        { label: 'Pubblicato su', value: 'Gazzetta Ufficiale del Regno' }, // allow-italian: fixture data, shown as written
        { label: 'Fonte', value: 'Normattiva' },
      ],
      notLoaded: "Il testo dell'originale non è ancora caricato dalla fonte ufficiale.", // allow-italian: fixture data, shown as written
    },
    refs: [{ label: 'L.R. Campania 7/2025, art. 10', item: 'lr-7-2025', article: 'a10c2' }],
    flowRefs: [],
    keywords: 'opere idrauliche alveo sponde reticolo regionale polizia idraulica',
  },
  {
    id: 'lr-13-1983',
    collection: 'norme',
    label: 'L.R. Campania 13/1983',
    title: 'Legge Regionale Campania 10 gennaio 1983, n. 13', // allow-italian: fixture data, shown as written
    subtitle: 'sanzioni amministrative pecuniarie', // allow-italian: fixture data, shown as written
    status: { text: 'in vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: BURC,
    chips: [{ id: 'sanzioni', label: 'Sanzioni', articleId: 'sanzioni' }], // allow-italian: fixture data, shown as written
    articles: [
      {
        id: 'sanzioni',
        group: 'sanzioni',
        heading: 'Sanzioni amministrative pecuniarie', // allow-italian: fixture data, shown as written
        subject: 'Le sanzioni amministrative pecuniarie che il Consorzio applica come Autorità di Polizia Idraulica; i proventi vanno alla gestione e alla manutenzione delle opere vigilate (L.R. 7/2025, art. 10, comma 2).', // allow-italian: fixture data, shown as written
        rules: ['sanzione secondo L.R. 13/1983'], // allow-italian: fixture data, shown as written
      },
    ],
    facts: [
      { label: 'Data', value: '10 gennaio 1983' }, // allow-italian: fixture data, shown as written
      { label: 'Materia', value: 'sanzioni di polizia idraulica' }, // allow-italian: fixture data, shown as written
      { label: 'Proventi', value: 'opere vigilate' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale BURC', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [
      { label: 'Verbale di polizia idraulica', value: 'sanzione', flow: 'verbale-polizia-idraulica' }, // allow-italian: fixture data, shown as written
      { label: 'Destinazione dei proventi', value: 'Ragioneria' }, // allow-italian: fixture data, shown as written
    ],
    versions: [{ id: 'v-lr-13-1983', label: 'L.R. Campania 13/1983', detail: 'Testo vigente. Il testo ufficiale non è ancora caricato.', status: { text: 'in vigore', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'BOLLETTINO UFFICIALE DELLA REGIONE CAMPANIA', // allow-italian: fixture data, shown as written
      publication: [
        { label: 'Atto', value: 'Legge Regionale 10 gennaio 1983, n. 13' }, // allow-italian: fixture data, shown as written
        { label: 'Pubblicato su', value: 'BURC, Regione Campania' }, // allow-italian: fixture data, shown as written
      ],
      notLoaded: "Il testo dell'originale non è ancora caricato dalla fonte ufficiale.", // allow-italian: fixture data, shown as written
    },
    refs: [{ label: 'L.R. Campania 7/2025, art. 10', item: 'lr-7-2025', article: 'a10c2' }],
    flowRefs: [],
    keywords: 'sanzioni verbale polizia idraulica proventi',
  },
  {
    id: 'dlgs-546-1992',
    collection: 'norme',
    label: 'D.Lgs. 546/1992',
    title: 'Decreto legislativo 31 dicembre 1992, n. 546', // allow-italian: fixture data, shown as written
    subtitle: 'disposizioni sul processo tributario', // allow-italian: fixture data, shown as written
    status: { text: 'in vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: NORMATTIVA,
    chips: [
      { id: 'a23', label: 'Art. 23 Costituzione in giudizio', articleId: 'a23c2' }, // allow-italian: fixture data, shown as written
      { id: 'a47', label: 'Art. 47 Sospensione', articleId: 'a47' }, // allow-italian: fixture data, shown as written
    ],
    articles: [
      {
        id: 'a23c1',
        group: 'a23',
        heading: 'Art. 23, comma 1 · Termine per costituirsi', // allow-italian: fixture data, shown as written
        subject: 'Il termine di sessanta giorni dalla notifica del ricorso entro cui il resistente deposita le controdeduzioni.', // allow-italian: fixture data, shown as written
        rules: ['termine 60 giorni dalla consegna della PEC'], // allow-italian: fixture data, shown as written
      },
      {
        id: 'a23c2',
        group: 'a23',
        heading: 'Art. 23, comma 2 · Contenuto delle controdeduzioni', // allow-italian: fixture data, shown as written
        source: 'testo di legge, da ricontrollare su Normattiva', // allow-italian: fixture data, shown as written
        text: [
          'Nelle controdeduzioni il resistente deve esporre le difese prendendo posizione sui motivi dedotti dal ricorrente e indicare le prove di cui intende valersi, proporre le eccezioni processuali e di merito che non sono rilevabili d\'ufficio, nonché formulare le conclusioni.', // allow-italian: fixture data, shown as written
        ],
      },
      {
        id: 'a47',
        group: 'a47',
        heading: "Art. 47 · Sospensione dell'atto impugnato", // allow-italian: fixture data, shown as written
        subject: "La domanda di sospensione dell'esecuzione dell'atto impugnato, che il ricorrente può chiedere alla Corte di giustizia tributaria.", // allow-italian: fixture data, shown as written
      },
    ],
    facts: [
      { label: 'Data', value: '31 dicembre 1992' }, // allow-italian: fixture data, shown as written
      { label: 'Materia', value: 'processo tributario' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [{ label: 'Costituzione in giudizio', value: 'termine di 60 giorni', flow: 'pec' }], // allow-italian: fixture data, shown as written
    versions: [{ id: 'v-dlgs-546', label: 'D.Lgs. 546/1992', detail: "Testo vigente. Il comma 2 dell'art. 23 è scritto per intero; il resto va caricato da Normattiva.", status: { text: 'in vigore', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'GAZZETTA UFFICIALE',
      publication: [
        { label: 'Atto', value: 'Decreto legislativo 31 dicembre 1992, n. 546' }, // allow-italian: fixture data, shown as written
        { label: 'Pubblicato su', value: 'Gazzetta Ufficiale della Repubblica Italiana' }, // allow-italian: fixture data, shown as written
        { label: 'Fonte', value: 'Normattiva' },
      ],
      notLoaded: "Il testo dell'originale non è ancora caricato dalla fonte ufficiale.", // allow-italian: fixture data, shown as written
    },
    refs: [],
    flowRefs: [{ flow: 'pec', step: 'controdeduzioni', detail: 'art. 23' }], // allow-italian: fixture data, shown as written
    keywords: 'ricorso tributario commissione giustizia tributaria controdeduzioni resistente costituzione giudizio sessanta giorni', // allow-italian: fixture data, shown as written
  },
  {
    id: 'l-241-1990',
    collection: 'norme',
    label: 'L. 241/1990',
    title: 'Legge 7 agosto 1990, n. 241', // allow-italian: fixture data, shown as written
    subtitle: 'procedimento amministrativo e diritto di accesso', // allow-italian: fixture data, shown as written
    status: { text: 'in vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: NORMATTIVA,
    chips: [{ id: 'a2', label: 'Art. 2 Conclusione del procedimento', articleId: 'a2c1' }], // allow-italian: fixture data, shown as written
    articles: [
      {
        id: 'a2c1',
        group: 'a2',
        heading: 'Art. 2, comma 1 · Provvedimento espresso', // allow-italian: fixture data, shown as written
        source: 'testo di legge, da ricontrollare su Normattiva', // allow-italian: fixture data, shown as written
        text: [
          "Ove il procedimento consegua obbligatoriamente ad un'istanza, ovvero debba essere iniziato d'ufficio, le pubbliche amministrazioni hanno il dovere di concluderlo mediante l'adozione di un provvedimento espresso.", // allow-italian: fixture data, shown as written
        ],
      },
      {
        id: 'a2c2',
        group: 'a2',
        heading: 'Art. 2, comma 2 · Termine di trenta giorni', // allow-italian: fixture data, shown as written
        source: 'testo di legge, da ricontrollare su Normattiva', // allow-italian: fixture data, shown as written
        text: [
          'Nei casi in cui disposizioni di legge ovvero i provvedimenti di cui ai commi 3 e 4 non prevedano un termine diverso, i procedimenti amministrativi di competenza delle amministrazioni statali e degli enti pubblici nazionali devono concludersi entro il termine di trenta giorni.', // allow-italian: fixture data, shown as written
        ],
      },
    ],
    facts: [
      { label: 'Data', value: '7 agosto 1990' }, // allow-italian: fixture data, shown as written
      { label: 'Materia', value: 'procedimento amministrativo' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [{ label: 'Risposta a un\'istanza', value: 'provvedimento espresso' }], // allow-italian: fixture data, shown as written
    versions: [{ id: 'v-l-241', label: 'L. 241/1990', detail: "Testo vigente. L'art. 2, commi 1 e 2, è scritto per intero; il resto va caricato da Normattiva.", status: { text: 'in vigore', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'GAZZETTA UFFICIALE',
      publication: [
        { label: 'Atto', value: 'Legge 7 agosto 1990, n. 241' }, // allow-italian: fixture data, shown as written
        { label: 'Pubblicato su', value: 'Gazzetta Ufficiale della Repubblica Italiana' }, // allow-italian: fixture data, shown as written
        { label: 'Fonte', value: 'Normattiva' },
      ],
      notLoaded: "Il testo dell'originale non è ancora caricato dalla fonte ufficiale.", // allow-italian: fixture data, shown as written
    },
    refs: [],
    flowRefs: [],
    keywords: 'procedimento amministrativo istanza termine conclusione provvedimento espresso istanza accesso',
  },
  {
    id: 'dlgs-33-2013',
    collection: 'norme',
    label: 'D.Lgs. 33/2013',
    title: 'Decreto legislativo 14 marzo 2013, n. 33', // allow-italian: fixture data, shown as written
    subtitle: 'trasparenza e accesso civico', // allow-italian: fixture data, shown as written
    status: { text: 'in vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: NORMATTIVA,
    chips: [{ id: 'a5', label: 'Art. 5 Accesso civico', articleId: 'a5c1' }, { id: 'a5bis', label: 'Art. 5-bis Esclusioni e limiti', articleId: 'a5bisc1' }], // allow-italian: fixture data, shown as written
    articles: [
      {
        id: 'a5c1',
        group: 'a5',
        heading: 'Art. 5, comma 1 · Accesso civico semplice', // allow-italian: fixture data, shown as written
        source: 'testo di legge, da ricontrollare su Normattiva', // allow-italian: fixture data, shown as written
        text: [
          "L'obbligo previsto dalla normativa vigente in capo alle pubbliche amministrazioni di pubblicare documenti, informazioni o dati comporta il diritto di chiunque di richiedere i medesimi, nei casi in cui sia stata omessa la loro pubblicazione.", // allow-italian: fixture data, shown as written
        ],
      },
      {
        id: 'a5c2',
        group: 'a5',
        heading: 'Art. 5, comma 2 · Accesso civico generalizzato', // allow-italian: fixture data, shown as written
        source: 'testo di legge, da ricontrollare su Normattiva', // allow-italian: fixture data, shown as written
        text: [
          "Allo scopo di favorire forme diffuse di controllo sul perseguimento delle funzioni istituzionali e sull'utilizzo delle risorse pubbliche e di promuovere la partecipazione al dibattito pubblico, chiunque ha diritto di accedere ai dati e ai documenti detenuti dalle pubbliche amministrazioni, ulteriori rispetto a quelli oggetto di pubblicazione ai sensi del presente decreto, nel rispetto dei limiti relativi alla tutela di interessi giuridicamente rilevanti secondo quanto previsto dall'articolo 5-bis.", // allow-italian: fixture data, shown as written
        ],
      },
      {
        id: 'a5c6',
        group: 'a5',
        heading: 'Art. 5, comma 6 · Termine di trenta giorni', // allow-italian: fixture data, shown as written
        source: 'testo di legge, da ricontrollare su Normattiva', // allow-italian: fixture data, shown as written
        text: [
          'Il procedimento di accesso civico deve concludersi con provvedimento espresso e motivato nel termine di trenta giorni dalla presentazione dell\'istanza con la comunicazione al richiedente e agli eventuali controinteressati.', // allow-italian: fixture data, shown as written
        ],
        rules: ['risposta entro 30 giorni'], // allow-italian: fixture data, shown as written
      },
      {
        id: 'a5bisc1',
        group: 'a5bis',
        heading: 'Art. 5-bis, comma 1 · Limiti per interessi pubblici', // allow-italian: fixture data, shown as written
        subject: "L'accesso generalizzato si rifiuta se serve a evitare un danno concreto a interessi pubblici elencati dalla norma; fra questi, alla lettera g, il regolare svolgimento delle attività ispettive.", // allow-italian: fixture data, shown as written
      },
      {
        id: 'a5bisc2',
        group: 'a5bis',
        heading: 'Art. 5-bis, comma 2 · Limiti per interessi privati', // allow-italian: fixture data, shown as written
        subject: 'Si rifiuta anche per evitare un danno concreto a interessi privati: alla lettera a, la protezione dei dati personali; poi la segretezza della corrispondenza e gli interessi economici e commerciali.', // allow-italian: fixture data, shown as written
      },
      {
        id: 'a5bisc5',
        group: 'a5bis',
        heading: 'Art. 5-bis, comma 5 · Il differimento prima del diniego', // allow-italian: fixture data, shown as written
        subject: "I limiti valgono solo finché la protezione è giustificata; l'accesso non si può negare quando basta differirlo.", // allow-italian: fixture data, shown as written
        rules: ['differire invece di negare, se basta'], // allow-italian: fixture data, shown as written
      },
    ],
    facts: [
      { label: 'Data', value: '14 marzo 2013' }, // allow-italian: fixture data, shown as written
      { label: 'Materia', value: 'trasparenza, accesso civico' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [{ label: 'Accesso agli atti', value: 'termine di 30 giorni', flow: 'accesso' }], // allow-italian: fixture data, shown as written
    versions: [{ id: 'v-dlgs-33', label: 'D.Lgs. 33/2013', detail: "Testo vigente. L'art. 5, commi 1, 2 e 6, è scritto per intero, l'art. 5-bis in sintesi; il resto va caricato da Normattiva.", status: { text: 'in vigore', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'GAZZETTA UFFICIALE',
      publication: [
        { label: 'Atto', value: 'Decreto legislativo 14 marzo 2013, n. 33' }, // allow-italian: fixture data, shown as written
        { label: 'Pubblicato su', value: 'Gazzetta Ufficiale della Repubblica Italiana' }, // allow-italian: fixture data, shown as written
        { label: 'Fonte', value: 'Normattiva' },
      ],
      notLoaded: "Il testo dell'originale non è ancora caricato dalla fonte ufficiale.", // allow-italian: fixture data, shown as written
    },
    refs: [{ label: 'L. 241/1990', item: 'l-241-1990' }],
    flowRefs: [{ flow: 'accesso', step: 'scadenza', detail: 'art. 5' }], // allow-italian: fixture data, shown as written
    keywords: 'accesso civico accesso agli atti trasparenza istanza trenta giorni pubblicazione', // allow-italian: fixture data, shown as written
  },
  {
    id: 'dlgs-231-2002',
    collection: 'norme',
    label: 'D.Lgs. 231/2002',
    title: 'Decreto legislativo 9 ottobre 2002, n. 231', // allow-italian: fixture data, shown as written
    subtitle: 'ritardi di pagamento nelle transazioni commerciali', // allow-italian: fixture data, shown as written
    status: { text: 'in vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: NORMATTIVA,
    chips: [{ id: 'a4', label: 'Art. 4 Termini di pagamento', articleId: 'a4c2' }], // allow-italian: fixture data, shown as written
    articles: [
      {
        id: 'a4c2',
        group: 'a4',
        heading: 'Art. 4, comma 2, lettera a · Trenta giorni dalla fattura', // allow-italian: fixture data, shown as written
        source: 'testo di legge, da ricontrollare su Normattiva', // allow-italian: fixture data, shown as written
        text: [
          'Il periodo di pagamento non può superare i termini seguenti: a) trenta giorni dalla data di ricevimento da parte del debitore della fattura o di una richiesta di pagamento di contenuto equivalente;', // allow-italian: fixture data, shown as written
        ],
        rules: ['pagamento entro 30 giorni dalla fattura'], // allow-italian: fixture data, shown as written
      },
      {
        id: 'a4c4',
        group: 'a4',
        heading: 'Art. 4, comma 4 · Pubbliche amministrazioni', // allow-italian: fixture data, shown as written
        subject: 'Le pubbliche amministrazioni debitrici possono pattuire un termine più lungo solo in modo espresso e per la natura del contratto, senza superare i sessanta giorni.', // allow-italian: fixture data, shown as written
      },
    ],
    facts: [
      { label: 'Data', value: '9 ottobre 2002' }, // allow-italian: fixture data, shown as written
      { label: 'Materia', value: 'termini di pagamento' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [{ label: 'Fattura passiva', value: 'pagamento entro 30 giorni', flow: 'fatture' }], // allow-italian: fixture data, shown as written
    versions: [{ id: 'v-dlgs-231', label: 'D.Lgs. 231/2002', detail: "Testo vigente. L'art. 4, comma 2, lettera a, è scritto per intero; il resto va caricato da Normattiva.", status: { text: 'in vigore', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'GAZZETTA UFFICIALE',
      publication: [
        { label: 'Atto', value: 'Decreto legislativo 9 ottobre 2002, n. 231' }, // allow-italian: fixture data, shown as written
        { label: 'Pubblicato su', value: 'Gazzetta Ufficiale della Repubblica Italiana' }, // allow-italian: fixture data, shown as written
        { label: 'Fonte', value: 'Normattiva' },
      ],
      notLoaded: "Il testo dell'originale non è ancora caricato dalla fonte ufficiale.", // allow-italian: fixture data, shown as written
    },
    refs: [],
    flowRefs: [{ flow: 'fatture', step: 'scadenza', detail: 'art. 4' }], // allow-italian: fixture data, shown as written
    keywords: 'fattura pagamento termini trenta giorni ritardo fornitore', // allow-italian: fixture data, shown as written
  },
  {
    id: 'dpr-633-1972',
    collection: 'norme',
    label: 'DPR 633/1972',
    title: 'Decreto del Presidente della Repubblica 26 ottobre 1972, n. 633', // allow-italian: fixture data, shown as written
    subtitle: "istituzione e disciplina dell'imposta sul valore aggiunto", // allow-italian: fixture data, shown as written
    status: { text: 'in vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: NORMATTIVA,
    chips: [{ id: 'a17ter', label: 'Art. 17-ter Scissione dei pagamenti', articleId: 'a17terc1' }], // allow-italian: fixture data, shown as written
    articles: [
      {
        id: 'a17terc1',
        group: 'a17ter',
        heading: 'Art. 17-ter, comma 1 · Scissione dei pagamenti', // allow-italian: fixture data, shown as written
        subject: "Per le forniture alle pubbliche amministrazioni elencate dalla norma, l'IVA scritta in fattura non si paga al fornitore: la versa l'ente direttamente all'Erario.", // allow-italian: fixture data, shown as written
        rules: ["al fornitore solo l'imponibile, l'IVA all'Erario"], // allow-italian: fixture data, shown as written
      },
    ],
    facts: [
      { label: 'Data', value: '26 ottobre 1972' }, // allow-italian: fixture data, shown as written
      { label: 'Materia', value: 'IVA, scissione dei pagamenti' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [{ label: 'Fattura passiva', value: 'IVA in scissione dei pagamenti', flow: 'fatture' }], // allow-italian: fixture data, shown as written
    versions: [{ id: 'v-dpr-633', label: 'DPR 633/1972', detail: "Testo vigente. L'art. 17-ter è in sintesi; il testo va caricato da Normattiva.", status: { text: 'in vigore', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'GAZZETTA UFFICIALE',
      publication: [
        { label: 'Atto', value: 'Decreto del Presidente della Repubblica 26 ottobre 1972, n. 633' }, // allow-italian: fixture data, shown as written
        { label: 'Pubblicato su', value: 'Gazzetta Ufficiale della Repubblica Italiana' }, // allow-italian: fixture data, shown as written
        { label: 'Fonte', value: 'Normattiva' },
      ],
      notLoaded: "Il testo dell'originale non è ancora caricato dalla fonte ufficiale.", // allow-italian: fixture data, shown as written
    },
    refs: [{ label: 'D.Lgs. 231/2002', item: 'dlgs-231-2002' }],
    flowRefs: [{ flow: 'fatture', step: 'pagamento', detail: 'art. 17-ter' }], // allow-italian: fixture data, shown as written
    keywords: 'iva split payment scissione pagamenti fattura erario imponibile', // allow-italian: fixture data, shown as written
  },
  {
    id: 'l-136-2010',
    collection: 'norme',
    label: 'L. 136/2010',
    title: 'Legge 13 agosto 2010, n. 136', // allow-italian: fixture data, shown as written
    subtitle: 'tracciabilità dei flussi finanziari', // allow-italian: fixture data, shown as written
    status: { text: 'in vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: NORMATTIVA,
    chips: [{ id: 'a3', label: 'Art. 3 Tracciabilità dei flussi finanziari', articleId: 'a3c1' }], // allow-italian: fixture data, shown as written
    articles: [
      {
        id: 'a3c1',
        group: 'a3',
        heading: 'Art. 3 · Conti dedicati e codice di gara nel bonifico', // allow-italian: fixture data, shown as written
        subject: "Chi lavora o fornisce per la pubblica amministrazione usa conti correnti dedicati; ogni pagamento si fa con bonifico e riporta il codice identificativo di gara (CIG) e, se c'è, il CUP.", // allow-italian: fixture data, shown as written
        rules: ['CIG nella causale del bonifico'], // allow-italian: fixture data, shown as written
      },
    ],
    facts: [
      { label: 'Data', value: '13 agosto 2010' }, // allow-italian: fixture data, shown as written
      { label: 'Materia', value: 'tracciabilità dei pagamenti' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [{ label: 'Pagamento a un fornitore', value: 'CIG nella causale', flow: 'fatture' }], // allow-italian: fixture data, shown as written
    versions: [{ id: 'v-l-136', label: 'L. 136/2010', detail: "Testo vigente. L'art. 3 è in sintesi; il testo va caricato da Normattiva.", status: { text: 'in vigore', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'GAZZETTA UFFICIALE',
      publication: [
        { label: 'Atto', value: 'Legge 13 agosto 2010, n. 136' }, // allow-italian: fixture data, shown as written
        { label: 'Pubblicato su', value: 'Gazzetta Ufficiale della Repubblica Italiana' }, // allow-italian: fixture data, shown as written
        { label: 'Fonte', value: 'Normattiva' },
      ],
      notLoaded: "Il testo dell'originale non è ancora caricato dalla fonte ufficiale.", // allow-italian: fixture data, shown as written
    },
    refs: [],
    flowRefs: [{ flow: 'fatture', step: 'pagamento', detail: 'art. 3' }], // allow-italian: fixture data, shown as written
    keywords: 'tracciabilita flussi finanziari cig cup conto dedicato bonifico fornitore', // allow-italian: fixture data, shown as written
  },
];
