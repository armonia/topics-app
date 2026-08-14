# La mappa delle prestazioni: cosa ha un numero e cosa no

Aggiornata il **2026-08-14**. Serve a una cosa sola: sapere DOVE una regressione
di prestazioni verrebbe vista e dove passerebbe muta. Non è un elenco di
buoni propositi — ogni riga dice il comando che esce non-zero, o dice che non
c'è.

La regola che governa tutto il resto: **un aggettivo non può fallire.** «Fluido»,
«veloce», «leggero» non finiscono mai, perché non c'è niente che possa dire di
no. Un numero con una soglia sì. Per questo qui si contano i cancelli, non le
intenzioni.

## Cosa è misurato, e da chi

| Superficie | Cosa misura | Comando | In CI |
|---|---|---|---|
| Scorrimento del trascritto | frame persi, buco peggiore, long task | `bun run check:fluido` | sì (`\|\| test $? -eq 2`) |
| Latenza di 4 rotte calde | mediana ms su corpus fisso, ratchet | `bun run check:rotte` | sì (`\|\| test $? -eq 2`) |
| Peso del bundle | byte entry/critical path/asset totali | `bun run check:bundle` | sì |
| Click → inchiostro | ms dal gesto al primo frame dipinto | `bun run check:ink` | sì (dal 2026-08-14) |
| Peso del payload di una chat | invariante anti-duplicato + byte/messaggio | `bun test tests/integration/history-payload-weight.test.ts` | sì (`bun test:unit`) |
| Frame a riposo | quanti frame si chiedono quando non succede niente | `tests/e2e/idle-frame-budget.spec.ts` | sì (shard E2E) |
| Spostamento al refresh (CLS) | layout shift dopo un ⌘R | `tests/e2e/refresh-cls.spec.ts` | sì (shard E2E) |
| Tetto di residenza delle pane | quante pane restano montate | `tests/e2e/pane-residency-cap.spec.ts` | sì (shard E2E) |
| Sfratto dei trascritti | quante chat restano idratate | `tests/e2e/chat-transcript-residency.spec.ts` | sì (shard E2E) |
| Streaming della pane browser | fps, latenza input p95, banda, primo frame | `tests/e2e/browser-ws-streaming.spec.ts` + `perf-baseline.json` | sì (shard E2E) |

## Cosa NON è misurato

Terra scoperta al 2026-08-14. Nessuna di queste righe ha un comando che esce
non-zero quando peggiora.

1. **Avvio a freddo.** Quanti millisecondi passano fra il lancio e la prima
   schermata usabile. Nessuna sonda, nessuna soglia.
2. **Memoria.** Né il server né il guscio hanno un tetto di RSS. Il server
   misurato oggi stava a ~200 MB; è un numero, non un budget, perché nessuno lo
   confronta con niente.
3. **Il bootstrap del WebSocket.** 176,7 KB alla connessione, misurati oggi:
   `ui-state:init` 84,5 KB (di cui `pane-store-v2` da solo 65,8 KB) e
   `unread:init` 79,8 KB su 843 topic, 517 dei quali per dire «zero non letti».
   Arriva prima che l'app possa fare qualunque cosa, non lo guarda nessuno, e
   sul WebSocket la compressione HTTP non arriva (vedi sotto).
4. **I terminali.** Nessuna misura di quanto costa una riga che arriva dal PTY,
   né di quanto redraw brucia una pane ferma.
5. **Ricerca e dashboard.** Nessuna latenza dichiarata.
6. **Il peso del database.** 651 MB oggi, di cui 634 nella tabella `messages`:
   `blocks` 353 MB e `tool_calls` 220 MB contro 13 MB di testo dei messaggi.
   Nessun cancello guarda quanto cresce, né quanto costa leggerne una riga.
7. **Il numero di riletture per evento.** Il feed della board è stato corretto
   il 2026-08-14 (vedi sotto), ma niente impedisce alla prossima superficie di
   rileggere N volte per N eventi: la regola vive in un modulo, non in un
   cancello.

## Le misure di oggi (2026-08-14)

Prese sul server di produzione di questa macchina, DB reale, loopback TLS.
Servono da riferimento: un numero senza data e senza banco non è una misura.

### Aprire una chat — topic 6b99e9cf, 118 messaggi, 1.167 tool call

| | byte sul filo | |
|---|---|---|
| prima | 8.207.127 | |
| dopo la sfoltita del duplicato | 5.419.622 | −34% |
| dopo, verso la LAN (gzip) | 1.425.963 | −83% sul totale |

Il duplicato era `toolCall.result` byte-identico a `detail.output`/`detail.content`
su 1.015 tool call su 1.167. `JSON.parse` di quel payload costa 16,5 ms prima e
10,5 ms dopo: **il collo non è il parse, è il trasferimento** — ed è per questo
che la compressione conta e il resto è margine.

### La rotta che serve gli agenti — `/api/topics/:id/messages`

| | byte |
|---|---|
| `?limit=200` prima | 12.544.630 |
| `?limit=200` dopo | 5.416.000 |
| `?limit=30` (quello che chiama `read_chat`) prima | 1.540.794 |
| `?limit=30` dopo | 715.570 |

Non la chiama il client: la chiama il server MCP, che poi tiene 4.000 caratteri
per messaggio e butta il resto.

### Il feed della board — `/api/all-boards/tasks`

467 task, 1.435.735 byte, 175 ms. Verso la LAN, compresso: 347.328 byte (4,1×).
449 dei 467 task sono `done`; `description` da sola pesa 486 KB, e la card ne
mostra due righe con `line-clamp-2`.

Fino al 2026-08-14 si rileggeva a OGNI evento `task:*`: il minuto più affollato
degli ultimi tre giorni ne conta 24, cioè 34,6 MB e 24 ridisegni per arrivare a
uno stato. Ora una raffica costa due letture (`client/src/lib/burstCoalescer.ts`).

### Altre rotte, per confronto

| rotta | byte | ms | verso la LAN (gzip) |
|---|---|---|---|
| `/api/topics` | 693.182 | 16 | 103.947 (6,7×) |
| `/api/notifications` | 22.289 | 4 | |
| `/api/projects` | 3.666 | 4 | |
| `/api/system/dispatch-capacity` | 212 | 4 | |

### L'avvio, per com'è fatto oggi

Nessuno di questi numeri è un difetto: sono il punto di partenza per chi vorrà
toccare l'avvio, e servono a non farlo a naso.

**`/api/topics` porta 977 topic, di cui 967 ARCHIVIATI.** «Aperto» vuol dire
non-archiviato, quindi la sidebar ne disegna dieci e ne riceve novecentosettanta
in più. Dentro, il campo più pesante è `systemPrompt`: **150 KB su 712**,
valorizzato su 663 topic, e lo leggono solo due superfici — lo stato vuoto della
chat e la finestra delle impostazioni — sempre e solo del topic APERTO. Toglierlo
dalla lista vuol dire dare a quelle due una lettura per singolo topic: è una
modifica di comportamento, non una sfoltita, e per questo qui c'è il numero e non
la patch.

**Il bootstrap del WebSocket porta 176,7 KB** e non è compresso da niente: la
compressione HTTP non lo tocca, e `Bun.serve` ha `perMessageDeflate` spento di
default (nel codice non è impostato). Comprimere il WebSocket è una decisione a
parte da quella dell'HTTP, perché sullo stesso socket passano anche i tasti di un
terminale e i frame di una pane browser: là un deflate per messaggio è costo puro.
Se si farà, va fatto per messaggio (`ws.send(data, compress)`) e per peer, con la
stessa domanda dell'HTTP — «c'è una rete in mezzo».

## Il cancello che c'era ma non girava — e il rosso che non era un difetto

`bun run check:ink` non era invocato da nessun workflow. La spec girava negli
shard E2E e **misurava**, ma il confronto con `tests/e2e/ink-budget.json` lo fa
solo `scripts/check-ink-latency.ts`, che in CI non compariva. Un budget che
nessuno esegue non è un cancello.

Eseguito a mano il 2026-08-14 usciva rosso, e il rosso reggeva su quattro corse
indipendenti: «switch tab» con un campione a **353,6 / 355,4 / 356,8 / 359,7 ms**
contro un tetto di 250, mentre gli altri quattro campioni della stessa corsa
stavano fra 6 e 15 ms. Sei millisecondi di scarto su quattro corse non sono
rumore di scheduling: è una costante.

Sondato invece di ipotizzato. Il messaggio è **nel DOM a +39 ms** e **dipinto a
+357 ms**, con **zero long task** e ogni richiesta di rete risposta entro 8 ms.
In mezzo non calcola niente: è `MessageList.tsx` che tiene la lista a
`visibility: hidden` dietro uno scheletro per almeno `LIST_REVEAL_FLOOR_MS`
(320 ms), perché nessuno guardi react-virtuoso misurare le altezze e ri-ancorare
— un riassestamento che da solo vale un CLS di 0,296 (`refresh-cls.spec.ts`).

Quindi non era un difetto: era **un gesto diverso dentro la misura di un altro**.
«Aprire una chat mai aperta» costa 355 ms per scelta dichiarata; «passare fra due
chat aperte» ne costa 13. Il primo campione di `tab` era il primo, tutti gli
altri il secondo. La spec ora scalda ENTRAMBE le pane prima di misurare — la
stessa decisione che questo file aveva già preso per `send` — e il costo escluso
è scritto in `ink-budget.json` sotto `excluded`, col perché e con la costante che
lo governa.

Dopo la correzione: `switch tab` mediana 13 ms, massimo 14,3. Il cancello non è
diventato cieco — con `bun run check:ink --stall 300` tutti e tre i gesti
falliscono — ed è entrato in CI.
