# Tetto assoluto alla compattazione degli agenti

## Perché
Il 27/11 Attilio: Jarvis su Discord «è proprio scemo». Il modello era già Opus; una delle cause è il contesto gonfio. Sul motore nativo la compattazione scatta a 0,85 della finestra e torna a 0,40: con Opus 5.5 (1M) vuol dire 850k e 400k. Misurato sul log del server incrociato col DB in sola lettura (25/11 22:03 → 27/11 20:30, 10.046 chiamate in 206 chat degli agenti `main` e `gtm`): **183k token per chiamata in media, p90 349k, max 636k, zero compattazioni**. Le istruzioni degli ultimi turni sono una fetta sottile di ogni richiesta (Branding: 49 feedback su 182 persi per strada), e ogni chiamata rilegge tutto dalla cache.

## Cosa cambia
- `compactionThresholds()` in `compaction.ts` (puro): con un tetto in token sotto la soglia della finestra, la soglia diventa il tetto e l'obiettivo ne tiene il rapporto di oggi (0,40/0,85 ≈ 47%). Solo verso il basso: un tetto sopra la soglia della finestra non cambia niente, perché quella soglia tiene la richiesta sotto il limite dell'API.
- Il tetto si dichiara per agente in `agent-engine.json` (cartella dati dell'app): `{ "agents": { "<id>": { "compactAtTokens": N } } }`. Senza file, o senza voce, il comportamento è quello di oggi. Letto a ogni turno; la chat appartiene all'agente la cui cartella è il workspace della topic (`resolveAgentIdForWorkspace`, la stessa regola del filtro MCP).
- Il tetto viaggia nel `TurnSpec` fino al `turn-host`, dove in produzione girano tutti i turni nativi. La riga «contesto compattato» porta `cap=N` quando la compattazione la causa il tetto.
- Configurazione: `main` e `gtm` a 200.000.

## Barra
`specs/acceptance.md`. Resta verde ciò che era verde: il cancello locale della CI (`topics-gates-ci`) e la CI della PR.

## Fuori
jarvis-channels (il blocco `<chat-recente>` è curato nel ramo `fix/jarvis-discord-qualita` del repo jarvis); la compattazione con riassunto del modello; `/compact` manuale; il ricarico dopo un riavvio (`REHYDRATE_WINDOW_TOKENS`); l'anello del contesto nella UI.

## Deciso da me
- **200k**: la finestra standard dei modelli Claude, dove la CLI compatta da sé. Il prompt fisso delle chat di Jarvis pesa ~44k (p10 del minimo per chat), quindi dopo una compattazione restano ~50k di storia vera e ~106k di margine prima della successiva.
- File a parte e non una chiave di `agent-tools.json`: quel file lo riscrive intero la pagina dei tool, e una chiave che il suo writer non conosce sparirebbe alla prima modifica di un filtro.
- Un numero solo (la soglia); l'obiettivo si ricava. Niente tetto globale per tutte le chat: nessuno l'ha chiesto, e gli agenti della board lavorano su altro.

## Non ancora specificato
- Se il taglio dei turni vecchi a ~94k fa perdere a Jarvis riferimenti che gli servono: si vede dalle risposte nei giorni dopo, non da un test.
