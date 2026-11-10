/**
 * The collections other than the norms: regulations and plans, the council's
 * resolutions, and the yearbook of 2025. Every fact is from DATI-VERI.md.
 * The yearbook's police-hydraulics page (p. 444) is quoted as the Consorzio
 * printed it; the other sections are summaries of numbers it publishes.
 */
import type { ItemSeed } from './knowledge-more';

const SITE_PDF = 'https://www.bonificasarno.it/site/wp-content/uploads/2026/03/web_librodellanno-2025-consorziobonifica.pdf';

export const DOCS: ItemSeed[] = [
  {
    id: 'regolamento-opere-bonifica',
    collection: 'regolamenti',
    label: 'Regolamento opere di bonifica',
    title: 'Regolamento per la gestione e la conservazione delle opere di bonifica', // allow-italian: fixture data, shown as written
    subtitle: 'Delibera del Consiglio dei Delegati 15/03/2023, n. 2', // allow-italian: fixture data, shown as written
    status: { text: 'in vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: "Albo pretorio e sito del Consorzio di Bonifica Integrale Comprensorio Sarno", // allow-italian: fixture data, shown as written
    chips: [{ id: 'all', label: 'Intero testo', articleId: 'all' }], // allow-italian: fixture data, shown as written
    articles: [
      {
        id: 'all',
        group: 'all',
        heading: 'Intero testo', // allow-italian: fixture data, shown as written
        subject: "Le norme di polizia idraulica sulle opere di bonifica del comprensorio, di cui al R.D. 368/1904: la violazione è accertata e contestata dal Consorzio come Autorità di Polizia Idraulica.", // allow-italian: fixture data, shown as written
      },
    ],
    facts: [
      { label: 'Approvato con', value: 'Delibera del Consiglio dei Delegati 15/03/2023, n. 2' }, // allow-italian: fixture data, shown as written
      { label: 'Materia', value: 'polizia idraulica' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [{ label: 'Verbale di polizia idraulica', value: 'norma del regolamento', flow: 'verbale-polizia-idraulica' }], // allow-italian: fixture data, shown as written
    versions: [{ id: 'v-reg', label: 'Regolamento del 15/03/2023', detail: 'Il testo ufficiale non è ancora caricato: la scheda dice di che cosa tratta.', status: { text: 'in vigore', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'CONSORZIO DI BONIFICA INTEGRALE COMPRENSORIO SARNO', // allow-italian: fixture data, shown as written
      publication: [
        { label: 'Atto', value: 'Delibera Consiglio dei Delegati 15/03/2023, n. 2' }, // allow-italian: fixture data, shown as written
        { label: 'Pubblicato su', value: "Albo pretorio del Consorzio" }, // allow-italian: fixture data, shown as written
      ],
      notLoaded: "Il testo firmato non è ancora caricato: va preso dall'albo pretorio.", // allow-italian: fixture data, shown as written
    },
    refs: [
      { label: 'R.D. 368/1904', item: 'rd-368' },
      { label: 'Delibera del 15/03/2023, n. 2', item: 'delibera-cdd-2-2023' }, // allow-italian: fixture data, shown as written
    ],
    flowRefs: [],
    keywords: 'polizia idraulica opere di bonifica regolamento violazioni ufficiale idraulico',
  },
  {
    id: 'piano-classifica-1996',
    collection: 'regolamenti',
    label: 'Piano di Classifica 1996', // allow-italian: fixture data, shown as written
    title: 'Piano di Classifica del Territorio, 1996', // allow-italian: fixture data, shown as written
    subtitle: 'approvato con delibera G.R. Campania n. 0403/AC del 18/03/1997', // allow-italian: fixture data, shown as written
    status: { text: 'in vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: 'Delibera di Giunta Regionale della Campania n. 0403/AC del 18/03/1997', // allow-italian: fixture data, shown as written
    chips: [{ id: 'riparto', label: 'Classifica e riparto', articleId: 'riparto' }], // allow-italian: fixture data, shown as written
    articles: [
      {
        id: 'riparto',
        group: 'riparto',
        heading: 'Classifica degli immobili e riparto del contributo', // allow-italian: fixture data, shown as written
        subject: 'Come gli immobili del comprensorio sono classificati per beneficio e come si ripartisce il contributo di bonifica: è la base degli avvisi che i contribuenti contestano.', // allow-italian: fixture data, shown as written
      },
      {
        id: 'irrigazione',
        group: 'irrigazione',
        heading: 'Irrigazione collettiva', // allow-italian: fixture data, shown as written
        source: "riassunto dal Libro dell'anno 2025", // allow-italian: fixture data, shown as written
        text: [
          'Sette bacini di irrigazione collettiva: 1.697 ettari irrigati su 10.131 ettari irrigabili, con una rete alimentata da 55 pozzi (2.503 l/s) e 5 vasche di accumulo.', // allow-italian: fixture data, shown as written
        ],
      },
    ],
    facts: [
      { label: 'Anno', value: '1996' }, // allow-italian: fixture data, shown as written
      { label: 'Approvazione', value: 'G.R. n. 0403/AC, 18/03/1997' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [
      { label: 'Contestazione di un avviso di contributo', value: 'si controlla la classifica', flow: 'pec' }, // allow-italian: fixture data, shown as written
      { label: 'Turno irriguo', value: 'utenza nei bacini', flow: 'irrigua' }, // allow-italian: fixture data, shown as written
    ],
    versions: [{ id: 'v-pdc', label: 'Piano di Classifica del 1996', detail: 'Il testo ufficiale non è ancora caricato: la scheda dice di che cosa tratta.', status: { text: 'in vigore', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'REGIONE CAMPANIA, GIUNTA REGIONALE', // allow-italian: fixture data, shown as written
      publication: [
        { label: 'Atto', value: 'Piano di Classifica del Territorio, 1996' }, // allow-italian: fixture data, shown as written
        { label: 'Approvato con', value: 'Delibera G.R. Campania n. 0403/AC, 18/03/1997' }, // allow-italian: fixture data, shown as written
      ],
      notLoaded: 'Il testo del Piano non è ancora caricato dalla fonte ufficiale.', // allow-italian: fixture data, shown as written
    },
    refs: [],
    flowRefs: [{ flow: 'pec', step: 'avviso', detail: 'classifica' }], // allow-italian: fixture data, shown as written
    keywords: 'piano di classifica contributo bonifica irrigazione bacini pozzi vasche', // allow-italian: fixture data, shown as written
  },
  {
    id: 'delibera-cdd-2-2023',
    collection: 'delibere',
    label: 'Delibera del Consiglio dei Delegati 15/03/2023, n. 2', // allow-italian: fixture data, shown as written
    title: 'Delibera del Consiglio dei Delegati 15 marzo 2023, n. 2', // allow-italian: fixture data, shown as written
    subtitle: 'regolamento per la gestione e la conservazione delle opere di bonifica', // allow-italian: fixture data, shown as written
    status: { text: 'in vigore', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: 'Albo pretorio del Consorzio', // allow-italian: fixture data, shown as written
    chips: [{ id: 'all', label: 'Intero testo', articleId: 'all' }], // allow-italian: fixture data, shown as written
    articles: [
      {
        id: 'all',
        group: 'all',
        heading: 'Oggetto', // allow-italian: fixture data, shown as written
        subject: 'Approva il «Regolamento per la gestione e la conservazione delle opere di bonifica», citato dal Libro dell\'anno 2025 a p. 444.', // allow-italian: fixture data, shown as written
      },
    ],
    facts: [
      { label: 'Organo', value: 'Consiglio dei Delegati' }, // allow-italian: fixture data, shown as written
      { label: 'Data', value: '15 marzo 2023' }, // allow-italian: fixture data, shown as written
      { label: 'Numero', value: '2' }, // allow-italian: fixture data, shown as written
      { label: 'Testo ufficiale', value: 'da caricare', pending: true }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [],
    versions: [{ id: 'v-del', label: 'Delibera n. 2 del 15/03/2023', detail: "Il testo firmato va preso dall'albo pretorio.", status: { text: 'in vigore', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'ALBO PRETORIO',
      publication: [
        { label: 'Atto', value: 'Delibera Consiglio dei Delegati 15/03/2023, n. 2' }, // allow-italian: fixture data, shown as written
        { label: 'Pubblicato su', value: "Albo pretorio del Consorzio" }, // allow-italian: fixture data, shown as written
      ],
      notLoaded: "Il testo firmato non è ancora caricato: la sincronizzazione notturna lo prende dall'albo pretorio.", // allow-italian: fixture data, shown as written
    },
    refs: [{ label: 'Regolamento per la gestione e la conservazione delle opere di bonifica', item: 'regolamento-opere-bonifica' }], // allow-italian: fixture data, shown as written
    flowRefs: [],
    keywords: 'albo pretorio delibera consiglio dei delegati', // allow-italian: fixture data, shown as written
  },
  {
    id: 'libro-anno-2025',
    collection: 'pubblicazioni',
    label: "Libro dell'anno 2025", // allow-italian: fixture data, shown as written
    title: "Libro dell'anno 2025", // allow-italian: fixture data, shown as written
    subtitle: 'pubblicato dal Consorzio sul proprio sito a marzo 2026, 452 pagine', // allow-italian: fixture data, shown as written
    status: { text: 'aggiornata', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: 'bonificasarno.it',
    chips: [
      { id: 'polizia', label: 'Polizia idraulica', articleId: 'p444' }, // allow-italian: fixture data, shown as written
      { id: 'rete', label: 'Comprensorio e rete', articleId: 'rete' }, // allow-italian: fixture data, shown as written
      { id: 'manutenzione', label: 'Manutenzione', articleId: 'manutenzione' }, // allow-italian: fixture data, shown as written
      { id: 'irrigazione', label: 'Irrigazione', articleId: 'irrigazione' }, // allow-italian: fixture data, shown as written
    ],
    articles: [
      {
        id: 'p444',
        group: 'polizia',
        heading: 'Polizia idraulica · lettere a, b, c', // allow-italian: fixture data, shown as written
        source: 'testo del Libro, p. 444', // allow-italian: fixture data, shown as written
        page: 444,
        text: [
          'Il Consorzio di Bonifica Integrale Comprensorio Sarno, quale Autorità di Polizia Idraulica, assolve a compiti di vigilanza e provvede ', // allow-italian: fixture data, shown as written
          { mark: "all'accertamento e alla contestazione delle violazioni" }, // allow-italian: fixture data, shown as written
          ' previste dalle norme di Polizia Idraulica, di cui al R.D. 08.05.1904, n. 368 e ss.mm.ii., contenute nel «Regolamento per la gestione e la conservazione delle opere di bonifica» (Delibera Consiglio dei Delegati 15.03.2023, n. 2). La L.R. Campania 6 giugno 2025, n. 7 all\'art. n.10, comma 2, individua i Consorzi di Bonifica, nei rispettivi comprensori, quali Autorità di Polizia Idraulica addetta: a) alla vigilanza sulle opere di bonifica e di irrigazione; b) all\'accertamento e alla contestazione delle violazioni previste dalle norme di Polizia Idraulica del regio decreto 8 maggio 1904, n. 368; c) ', // allow-italian: fixture data, shown as written
          { mark: "all'intero procedimento per l'applicazione delle relative sanzioni amministrative e pecuniarie di cui alla L.R. Campania 10 gennaio 1983, n. 13; i proventi delle sanzioni amministrative pecuniarie sono destinati alla gestione e alla manutenzione delle opere vigilate" }, // allow-italian: fixture data, shown as written
          ' di cui alla lettera a).', // allow-italian: fixture data, shown as written
        ],
        rules: ['verbale anche senza la Regione', 'sanzione secondo L.R. 13/1983'], // allow-italian: fixture data, shown as written
      },
      {
        id: 'p447',
        group: 'polizia',
        heading: 'Polizia idraulica · chi svolge il servizio', // allow-italian: fixture data, shown as written
        source: 'sintesi, Libro p. 447', // allow-italian: fixture data, shown as written
        page: 447,
        text: ["Il servizio di polizia idraulica lo svolgono l'ufficiale idraulico e il sorvegliante, ufficiali di polizia giudiziaria nei limiti del servizio."], // allow-italian: fixture data, shown as written
      },
      {
        id: 'rete',
        group: 'rete',
        heading: 'Comprensorio e rete', // allow-italian: fixture data, shown as written
        source: 'sintesi dei dati del Libro', // allow-italian: fixture data, shown as written
        text: [
          'Il comprensorio «Sarno» comprende i bacini Sarno, Torrenti Vesuviani e Irno, con 43.054 ettari di attuale operatività. La rete idraulica è di circa 680 km (610 km di canali di bonifica, 50 km promiscui, 20 km irrigui; 560 km nel comprensorio di attuale operatività) con 24 vasche assorbenti laminanti. Le aste principali sono il Fiume Sarno, il Torrente Solofrana, il Torrente Cavaiola e l\'Alveo Comune Nocerino.', // allow-italian: fixture data, shown as written
        ],
      },
      {
        id: 'manutenzione',
        group: 'manutenzione',
        heading: 'Manutenzione 2025', // allow-italian: fixture data, shown as written
        source: 'sintesi dei dati del Libro', // allow-italian: fixture data, shown as written
        text: [
          'Nel 2025 i tagli di vegetazione hanno interessato circa 2.500.000 m², con operai dipendenti e mezzi propri. Canali citati nei lavori: Canale dei Mulini, Canale Lauro, Canale Macchione (Castel San Giorgio), Torrente Lavinaio (Bracigliano).', // allow-italian: fixture data, shown as written
        ],
      },
      {
        id: 'irrigazione',
        group: 'irrigazione',
        heading: 'Irrigazione', // allow-italian: fixture data, shown as written
        source: 'sintesi dei dati del Libro', // allow-italian: fixture data, shown as written
        text: [
          'Sette bacini di irrigazione collettiva: 1.697 ettari irrigati su 10.131 ettari irrigabili. La rete è alimentata da 55 pozzi (2.503 l/s) e da 5 vasche di accumulo, con un telecontrollo sviluppato internamente.', // allow-italian: fixture data, shown as written
        ],
      },
    ],
    facts: [
      { label: 'Pagine', value: '452' }, // allow-italian: fixture data, shown as written
      { label: 'Pubblicato', value: 'marzo 2026' }, // allow-italian: fixture data, shown as written
      { label: 'File', value: 'web_librodellanno-2025…pdf' }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [{ label: 'Verbale di polizia idraulica', value: 'lettera c', flow: 'verbale-polizia-idraulica' }], // allow-italian: fixture data, shown as written
    versions: [{ id: 'v-libro', label: "Libro dell'anno 2025", detail: 'Letto e diviso per capitoli: manutenzione, irrigazione, opere pubbliche, polizia idraulica.', status: { text: 'aggiornata', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'POLIZIA IDRAULICA', // allow-italian: fixture data, shown as written
      page: 444,
      publication: [
        { label: 'Fonte', value: 'bonificasarno.it' },
        { label: 'File', value: 'web_librodellanno-2025…pdf', mono: true }, // allow-italian: fixture data, shown as written
        { label: 'Pagine', value: '452' }, // allow-italian: fixture data, shown as written
      ],
      paragraphs: [
        { text: "Il Consorzio di Bonifica Integrale Comprensorio Sarno, quale Autorità di Polizia Idraulica, assolve a compiti di vigilanza e provvede all'accertamento e alla contestazione delle violazioni previste dalle norme di Polizia Idraulica, di cui al R.D. 08.05.1904, n. 368 e ss.mm.ii., contenute nel «Regolamento per la gestione e la conservazione delle opere di bonifica» (Delibera Consiglio dei Delegati 15.03.2023, n. 2) …" }, // allow-italian: fixture data, shown as written
        { text: "La L.R. Campania 6 giugno 2025, n. 7 all'art. n.10, comma 2, individua i Consorzi di Bonifica, nei rispettivi comprensori, quali Autorità di Polizia Idraulica addetta:" }, // allow-italian: fixture data, shown as written
        { text: "a) alla vigilanza sulle opere di bonifica e di irrigazione nonché sui corsi d'acqua del reticolo idrografico regionale e sulle altre opere affidate alla loro gestione;" }, // allow-italian: fixture data, shown as written
        { text: "b) all'accertamento e alla contestazione delle violazioni previste dalle norme di Polizia Idraulica del regio decreto 8 maggio 1904, n. 368 …" }, // allow-italian: fixture data, shown as written
        { text: "c) all'intero procedimento per l'applicazione delle relative sanzioni amministrative e pecuniarie di cui alla L.R. Campania 10 gennaio 1983, n. 13 […]; i proventi delle sanzioni amministrative pecuniarie sono destinati alla gestione e alla manutenzione delle opere vigilate", mark: true }, // allow-italian: fixture data, shown as written
        { text: 'di cui alla lettera a).' }, // allow-italian: fixture data, shown as written
      ],
      site: { label: 'bonificasarno.it', url: SITE_PDF },
      siteCheck: 'Uguale all\'originale sul sito', // allow-italian: fixture data, shown as written
    },
    refs: [
      { label: 'L.R. Campania 7/2025, art. 10', item: 'lr-7-2025', article: 'a10c2' },
      { label: 'Regolamento opere di bonifica, delibera del Consiglio dei Delegati 2/2023', item: 'regolamento-opere-bonifica', pending: true }, // allow-italian: fixture data, shown as written
      { label: 'L.R. Campania 13/1983', item: 'lr-13-1983' },
    ],
    flowRefs: [],
    keywords: "libro dell'anno consorzio polizia idraulica rete canali irrigazione manutenzione km ettari pozzi", // allow-italian: fixture data, shown as written
  },
];
