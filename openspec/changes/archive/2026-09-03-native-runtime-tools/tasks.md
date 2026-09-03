# Tasks: native-runtime-tools

## 1. Il piano del turno

- [x] 1.1 Verificare quale forma il client disegna già, invece di inventarne una:
  `deriveToolDetail` accetta `todowrite` / `todo_write` con `todos[]`
  (`server/providers/claude/tool-detail.ts:179`), e `selectLatestTodo.ts` legge
  lo stesso nome per la striscia sopra il compositore.
- [x] 1.2 `ToolSpec` `todo_write`: descrizione scritta PER IL MODELLO (quando
  usarla, che la lista si manda intera, un solo passo in corso), schema con
  `content` / `status` / `activeForm`.
- [x] 1.3 Case in `executeTool`: valida e risponde con il conteggio per stato.
  Lista vuota e stato sconosciuto sono errori che NOMINANO il valore ricevuto;
  più di un `in_progress` è una nota, non un rifiuto.
- [x] 1.4 Permesso anche in `ask`: è la modalità che il piano lo chiede.

## 2. Un URL diventa testo

- [x] 2.1 Cercare un estrattore già scritto: c'è `htmlToText` in
  `scripts/mcp-cap-bench/fetch-pages.ts`, lasciato dov'è (il suo corpus è
  cachato e hashato in un manifest, cambiarne l'estrazione invaliderebbe in
  silenzio gli input di un banco). Il nuovo vive in `server/lib/`.
- [x] 2.2 `lib/html-to-markdown.ts`: via script/style/commenti, titoli con il
  loro livello, elenchi una riga per voce, link con l'indirizzo risolto sulla
  pagina, `<pre>` parcheggiato PRIMA della normalizzazione degli spazi, entità
  decodificate (le sconosciute restano com'erano).
- [x] 2.3 `ToolSpec` `web_fetch` + `fetchAsText`: solo http/https, timeout 30s,
  corpo letto con un tetto mentre arriva, `content-type` che decide (HTML →
  markdown, JSON → indentato, testo → intatto, altro → nominato), errore HTTP con
  la spiegazione del server, redirect dichiarato, `signal` del turno collegato.
- [x] 2.4 Permesso anche in `ask` (GET, nessun corpo, nessuna scrittura).

## 3. Cosa non si è aggiunto

- [x] 3.1 `web_search`: cercata una credenziale di ricerca in tutto l'albero
  (`EXA|BRAVE|PERPLEXITY|TAVILY|SERPAPI|BING|GOOGLE_SEARCH`), zero occorrenze.
  Non scritto, e il perché sta in proposal.md + CHAT-NTOOL-03. Chi ha un server
  di ricerca configurato lo riceve già dalla flotta MCP.
- [x] 3.2 `task`: nessun meccanismo di turno annidato sicuro nel nativo
  (profondità, budget, canale UI, annullamento). Non scritto; le quattro cose che
  servirebbero sono elencate in proposal.md e fissate in CHAT-NTOOL-03.

## 4. Prova

- [x] 4.1 `bun test server/lib/html-to-markdown.test.ts` — 10 pass.
- [x] 4.2 `bun test server/providers/native/web-tools.test.ts` — 21 pass, contro
  un server vero sul loopback (uno stub proverebbe lo stub).
- [x] 4.3 Il confine dello stream, che è la misura di CHAT-NTOOL-01: la forma
  dichiarata dai due `ToolSpec` passata a `deriveToolDetail` deve tornare
  `type: 'todo'` e `type: 'fetch'`. È l'unico anello che nessun altro test
  guardava, ed è quello che rompendosi rimette JSON grezzo a schermo lasciando
  verdi tutti e due i lati.
- [x] 4.4 `bun test server/providers/native/permissions.test.ts` — 13 pass.
- [x] 4.5 `npx tsc --noEmit -p tsconfig.server.json` — pulito (exit 0).
- [x] 4.6 `bun test server` — 6121 pass / 29 skip / 5 fail. I 5 sono tutti in
  `services/turn-checkpoints.test.ts` e dicono `git … timed out`: quel file passa
  14/14 da solo. Sono i rossi noti di git in un worktree sotto carico, non di
  questa change.
- [x] 4.7 `bun run check:emdash` verde — e prima non lo era: il trattino lungo
  nella descrizione di `skill` rendeva rosso il cancello già a HEAD (verificato
  su una copia di HEAD), la frase è stata spezzata in due.
- [x] 4.8 `check:comment-language` e `check:identifier-language` restano rossi
  ESATTAMENTE come a HEAD, riga per riga (confronto su una copia di HEAD): il
  debito è dei due commit precedenti del ramo (`native-parity.ts`,
  `context/adapt.ts`), e questa change non ne aggiunge una sola. `href` e
  `entities` entrano in `PROJECT_WORDS` perché sono i nomi che l'HTML si dà.
