# Change: native-runtime-tools

## Why

Togliendo la CLI, il runtime nativo si è tenuto i mestieri di macchina
(`read_file`, `write_file`, `edit_file`, `bash`, `grep`, `glob`, `skill`) e ha
perso tutto il resto. Due assenze si pagano a ogni turno, e non sono simmetriche
alle altre:

**Il piano non esiste.** `TodoWrite` è l'unico modo che un umano ha di vedere
cosa l'agente ha capito PRIMA che finisca. Il client lo sa già mostrare in due
posti — la card nel trascritto e la striscia appiccicata sopra il compositore
(CHAT-TODO-01, `selectLatestTodo.ts`) — e per il runtime nativo restano tutti e
due vuoti per sempre: nessun tool produce quella chiamata. Su una card
dispacciata che lavora venti minuti, l'unica cosa leggibile è la prosa che
scorre. `deriveToolDetail` riconosce già `todo_write` (`tool-detail.ts:179`):
mancava solo chi lo chiama.

**Il web è fuori portata.** L'agente non può leggere una pagina di
documentazione, le note di rilascio di una dipendenza, la risposta di un'API.
Con `bash` può fare `curl`, e questo è precisamente il problema: si riporta in
contesto 300 kB di markup minificato in cui la risposta c'è ma costa una
fortuna, oppure `curl | sed` improvvisati che tagliano la parte utile. Un
estrattore vero è la differenza fra una pagina letta e una pagina pagata.

Le altre due assenze della lista (ricerca web e sub-agente) NON si chiudono qui,
e la sezione «Cosa non cambia» dice perché: aggiungerle oggi significherebbe
dichiarare al modello due strumenti che a runtime falliscono.

## What changes

1. **`todo_write`** — la lista di cose da fare del turno, nella forma esatta che
   il client già disegna (`{ todos: [{ content, status, activeForm }] }`, nome
   `todo_write`). Non tocca il disco e non esegue niente: il risultato È la
   chiamata nel trascritto. Il tool valida la forma (una lista vuota o uno stato
   inventato renderebbero una card vuota o muta) e risponde con il conteggio per
   stato, così il modello ha di che ricontrollarsi. Più di un passo `in_progress`
   si SEGNALA, non si rifiuta: costa un giro per correggere una lista che è già
   a schermo e già leggibile.

2. **`web_fetch`** — un URL diventa markdown leggibile. HTML convertito
   mantenendo titoli, elenchi, link (assoluti, così sono seguibili) e blocchi di
   codice; JSON indentato; testo semplice così com'è. Ciò che non è testo torna
   NOMINATO (`image/png, 240 kB`) invece di riversarsi addosso al modello, e un
   errore HTTP porta con sé lo stato E la spiegazione del server, che è la parte
   utile. Il corpo si legge con un tetto MENTRE arriva, come già fa `bash` con
   l'output di un comando: un URL è ciò che il modello ha scritto, e può essere
   un dump da mezzo giga.

3. **`server/lib/html-to-markdown.ts`** — l'estrattore, separato perché è la
   parte che ha una sua verità da provare (cosa sopravvive e cosa no) ed è
   riusabile. Non è un browser e non finge di esserlo: una pagina che si dipinge
   in JavaScript torna vuota, e il tool lo DICE invece di restituire il silenzio,
   così il modello non ripete la stessa fetch.

4. **Permessi** — `todo_write` e `web_fetch` entrano fra i tool concessi anche in
   `ask`. `ask` è il plan mode: scrivere il piano è la cosa che quella modalità
   chiede, e leggere una pagina è come leggere un file. Nessuno dei due scrive
   niente, e gli schemi che uscirebbero dal perimetro (`file:`, `data:`) sono
   rifiutati in `tools.ts` PRIMA della rete.

## Cosa NON cambia, e perché

**`web_search` non si aggiunge.** Non esiste in questo repository una credenziale
di ricerca: nessun `EXA_API_KEY`, `BRAVE_API_KEY`, `PERPLEXITY`, `TAVILY`,
`SERPAPI` in `.env.example`, in `server/`, in `shared/` o nel client (verificato
con una ricerca sull'intero albero). Scrivere il tool significherebbe dichiarare
al modello uno strumento che a runtime risponde 401: un agente che ci prova due
volte prima di arrendersi paga due giri e il turno peggiora rispetto a non averlo
mai avuto. E c'è già la strada giusta per chi la ricerca ce l'ha: la flotta MCP
nativa monta i server configurati dall'utente (`mcp-fleet.ts`), quindi un exa o
un brave configurati in `~/.claude.json` arrivano al modello come
`mcp__<server>__<tool>` senza che questo repository conosca nessuna chiave. Il
giorno in cui Topics avrà un provider di ricerca proprio (chiave in Impostazioni,
come per Moondream), il tool si scrive in venti righe riusando `fetchAsText`.

**`task` (sub-agente) non si aggiunge.** Il runtime nativo NON ha oggi un modo
sicuro di eseguire un turno annidato. `runAgentTurn` è riusabile in linea di
principio, ma quello che manca non è codice di collegamento:

- **nessun contatore di profondità**: un sub-agente che riceve a sua volta `task`
  ricorre senza fondo, e il tetto che esiste (`MAX_ITERATIONS`, 300 giri) conta i
  giri di UN turno, non gli annidamenti;
- **nessun budget**: il costo di un figlio non torna al padre, quindi un turno
  potrebbe spendere un multiplo arbitrario di sé stesso senza che il registro
  d'uso (`onRoundUsage`) lo veda;
- **nessun canale verso la UI**: `SubAgentCard` è alimentata da
  `SidechainTracker`, che parsa lo stream della CLI. Un figlio nativo
  scriverebbe in un `StreamHandler` che nessuno ascolta, e in chat resterebbe
  una riga ferma su «starting…» per tutta la durata;
- **nessuna propagazione dell'annullamento** provata: il segnale del padre deve
  arrivare al ciclo del figlio e ai suoi tool, ed è esattamente la classe di
  guasto (uscita muta, turno che non finalizza) che RT-01 esiste per impedire.

Serve una change sua, con quei quattro pezzi specificati e provati. Aggiungerlo
qui vorrebbe dire spedire la ricorsione e scoprire il resto in produzione.

## Risks

- **Un tool in più costa contesto a OGNI giro.** Gli schemi viaggiano nella
  richiesta di ogni round: due tool sono ~250 token di prefisso, cachati dal
  breakpoint che già c'è (`applyPromptCache`). Accettato: la todo li ripaga al
  primo turno che l'utente non deve interrompere per chiedere «a che punto sei».
- **L'estrattore è a espressioni regolari, non un parser.** Un HTML patologico
  (tag non chiusi, `<pre>` annidati) può perdere pezzi. È il compromesso
  dichiarato: nessuna dipendenza nuova su un cammino centrale, e il caso peggiore
  è testo mancante, non un'eccezione.
- **`web_fetch` è una GET verso qualunque host, concessa anche in `ask`.** Non è
  una sandbox e non pretende di esserlo (vale la stessa premessa di
  `permissions.ts`): `bash` può già fare `curl` nei livelli superiori. Ciò che il
  controllo sullo schema chiude è il caso in cui `web_fetch` diventerebbe una
  lettura di disco arbitraria (`file:///etc/passwd`) proprio nel livello in cui
  `read_file` è murato dentro la workspace.

## Impact

- **Specs (delta)**: `chat/` — ADDED CHAT-NTOOL-01 (todo), CHAT-NTOOL-02 (fetch),
  CHAT-NTOOL-03 (i due tool che NON si aggiungono e a quale condizione si
  aggiungerebbero). Nota per chi rivede: le tre requirement descrivono il
  runtime nativo, quindi la casa alternativa è `agent-runtime` (RT-12+); stanno
  in `chat/` perché ciò che provano è quello che compare nella chat.
- **Server**: `providers/native/tools.ts` (due `ToolSpec`, due case, `fetchAsText`
  + lettura con tetto), `providers/native/permissions.ts` (i due tool in
  `READ_ONLY`), nuovo `lib/html-to-markdown.ts`.
- **Client**: nessuna modifica. Le due forme sono già riconosciute
  (`toolDetail.ts`: `TODO_TOOL_NAMES`, `FETCH_NAMES`) e già disegnate
  (`TodoCard`, `TodoStrip`, la card `fetch`).
- **Tests**: `server/lib/html-to-markdown.test.ts` (10),
  `server/providers/native/web-tools.test.ts` (21, con un server vero sul
  loopback e il confine dello stream), due casi in
  `providers/native/permissions.test.ts`.
