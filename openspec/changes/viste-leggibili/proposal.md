# Viste leggibili al posto del JSON grezzo

## Perché
Un risultato JSON di un tool in chat è testo colorato che nessuno legge. Le forme note diventano una vista impaginata (card, scheda, tabella, elenco), le forme mai viste le sceglie un modello economico da un catalogo chiuso nominando solo percorsi, mai valori. Stato dell'arte guardato: json-render (vercel-labs), A2UI, MCP Apps, generative UI dell'AI SDK: tutti fanno UI da JSON vincolata a un catalogo; qui il catalogo è piccolo e i valori li legge sempre il renderer dal JSON originale.

## Cosa cambia
- Funzioni pure forma → vista (`shared/readable-view.ts`); un valore con campi annidati non è deterministico e va al ripiego.
- Interruttore Leggibile / Originale sulla card, scelta ricordata; l'originale resta identico.
- Ripiego sul modello (Haiku di default, modello e interruttore nelle impostazioni, letti lato server): una chiamata per forma nuova, cache per firma (chiavi e tipi); un errore del provider non va in cache.
- La vista si compone in streaming mentre la specifica arriva (NDJSON); finché non c'è niente si vede l'originale.
- Frasi e tipologie dei tool: mappa deterministica, e per un tool MCP sconosciuto una chiamata al modello per nome, in cache.

## Barra
`bun test` di `shared/readable-view`, `shared/tool-phrase`, `server/services/readable-view-fallback`, `server/routes/readable-view`, `client/src/components/Chat/ReadableResult`; `bun run check:spec-coverage` esce 0; `tests/e2e/readable-view.spec.ts` (interruttore e streaming) in CI o sul PC; foto prima/dopo a 375, 768, 1440, 3440.

## Fuori
Nessun tool di terzi cablato; niente HTML né codice dal modello.
