/**
 * The questions the Consorzio's people ask the knowledge base most (the ones
 * the question box suggests), and the one answer that is composed by hand
 * because it joins three passages in one sentence. Every other answer is
 * built by the search from the documents themselves: nothing here is a
 * second source of facts, each claim points at the passage it rests on.
 */

export const SUGGESTIONS: string[] = [
  'Chi può contestare uno scarico abusivo in un canale consortile, e dove vanno i soldi della sanzione?', // allow-italian: fixture data, shown as written
  "Entro quanti giorni il Consorzio deve rispondere a una richiesta di accesso civico?", // allow-italian: fixture data, shown as written
  'In quanti giorni ci si costituisce in giudizio contro un ricorso tributario?', // allow-italian: fixture data, shown as written
  'Quanti km di rete idraulica ha il Consorzio?', // allow-italian: fixture data, shown as written
];

/** The passages the composed answer rests on, by the id the search uses: `k:<item>/<article>`. */
export const CURATED_SOURCES = ['k:lr-7-2025/a10c2', 'k:libro-anno-2025/p444', 'k:libro-anno-2025/p447'];

/**
 * The words of the first suggestion that must all be in a question for the
 * composed answer to apply, as stems (see `stem` in the engine), and the
 * sentence itself: `{ n: i }` is the i-th source of `CURATED_SOURCES`.
 */
export const CURATED_ANSWER: { stems: string[]; parts: Array<string | { n: number }> } = {
  stems: ['conte', 'sanzi', 'canal'],
  parts: [
    'Il Consorzio stesso: dalla L.R. 7/2025 è Autorità di Polizia Idraulica e accerta e contesta le violazioni del R.D. 368/1904 sulle opere di bonifica ', // allow-italian: fixture data, shown as written
    { n: 0 },
    { n: 1 },
    '. Il servizio lo svolgono l\'ufficiale idraulico e il sorvegliante, ufficiali di polizia giudiziaria nei limiti del servizio ', // allow-italian: fixture data, shown as written
    { n: 2 },
    '. Le sanzioni seguono la L.R. 13/1983 e i proventi vanno alla gestione e alla manutenzione delle opere vigilate ', // allow-italian: fixture data, shown as written
    { n: 0 },
    '.',
  ],
};
