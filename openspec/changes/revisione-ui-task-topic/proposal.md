# Revisione UI/UX di task e topic: studio

Card 7d221b53, chiesta da Attilio il 25/10. Questo documento è lo studio: niente codice dell'interfaccia. Ogni difetto ha lo stato di oggi su `origin/main` (3f1056509d, v2.3.40), una immagine, la copertura delle change esistenti e la correzione proposta in una riga. Le card piccole nascono dopo il tuo sì.

## Deciso da Attilio (29/10, tutte e tre come consigliate)

1. **Task = card + topic nascosto, resta così; si cura la proiezione.** Consigliata: la separazione c'è già (vedi «Il task come chat pulita»), il difetto è cosa il drawer mostra, non il modello. Alternativa: far nascere ogni task come topic visibile in sidebar con la card come sua vista; costa una migrazione del modello e rompe «la board non sporca la sidebar».
2. **Sette card piccole, una per difetto, in quest'ordine:** loader, spazio sotto l'input, accordion, anteprime board, drawer pulito, terminale, streaming del testo. Consigliata: ordine di costo crescente, le prime tre sono CSS e un componente. Alternativa: partire dal drawer pulito, che è quello che hai descritto con più forza.
3. **Font del terminale: una pila sola per chat e terminale, con JetBrains Mono incluso nel bundle.** Consigliata: oggi il font non viene caricato da nessuna parte, dove non è installato cade su Menlo. Alternativa: non includere nulla e usare solo `ui-monospace` (peso zero, ma l'aspetto cambia per macchina).

Le sette card sono sulla board topics-app, in fila nell'ordine del punto 2.

## Come ho misurato

Client buildato da un worktree su `origin/main` (`bun run build:client`), server di test isolato (`scripts/start-test-server.sh`, porta 13977, DB vuoto, tutto in `/private/tmp`), WebKit headless di Playwright, finestra 1440×900 o 2000×1000. Il client è quello vero col server vero, non la demo della landing (la demo non ha chat né drawer). Dati: due topic seminati con `/api/test/seed-message`, quattro task sulla board, e una CLI finta (`fake-claude.ts`, stesso dialetto stream-json: testo, `Read`, `Bash`, `Task` con figli, `Edit`) che ha fatto girare un turno vero dal dispatcher. Immagini in `~/.topics/media/ui-task-topic-*`.

Limite onesto: la CLI finta non chiama mai `update_task`, quindi le card arrivate in review dicono «Niente consegnato» e «Consegna senza riassunto»; con un agente vero quella riga cambia. Il resto (struttura, spazi, font, loader) non dipende da questo.

## 1. Icona accordion evitabile

**Oggi.** Ogni riga di tool con un corpo porta un chevron da 12 px (`ToolCallRow.tsx:431-436`, `ToolGroupRow.tsx:115-117`), anche quando la riga è già un bersaglio da cliccare intera. Le righe dei sotto-agenti si aprono da sole e ripetono la stessa etichetta due volte («Explore (Controlla…)» e subito sotto «Explore · Controlla…»). Immagine: `ui-task-topic-01-chat-storia-accordion.png`.
**Coperto?** No. `chat-strips-in-transcript` riguarda l'accordion della striscia comandi, non le righe del trascritto.
**Correzione.** Il chevron compare solo su hover e focus (resta sempre sul touch, `coarse:`), la colonna da 12 px resta riservata come oggi così niente si sposta; la riga del sotto-agente non ripete l'etichetta.

## 2. Sotto-agenti e cose in background «in una parte che non si capisce»

**Oggi.** Lo stesso lavoro sta in tre posti con tre grafiche: una riga dentro l'elenco dei tool (`03-loader-sottoagente.png`, con i passi «ATTIVITÀ · 2 PASSI»), la striscia in fondo al trascritto (`SubAgentsStrip.tsx`, solo per figli registrati e comandi vivi), e nel drawer di un task dentro «Dettagli sessione · N azioni» (`05-drawer-task.png`). Nel mio giro il `Task` della CLI è comparso solo come riga inline: non ho potuto provare la striscia con un figlio nativo registrato (non verificato).
**Coperto?** In parte: `chat-live-work` (una riga per ogni cosa viva, anteprima di una riga, si apre) e `chat-strips-in-transcript` (le strisce stanno a fondo trascritto, accordion). Il sorgente dice che sono atterrate (PR #257), ma i loro `tasks.md` non hanno caselle, quindi lo stato lo dà solo il codice. Non coprono la riga inline del `Task` né il rapporto con «Dettagli sessione».
**Correzione.** Un sotto-agente è UNA riga con nome, ultimo passo e durata: la stessa grafica inline, in striscia e nel drawer, e la riga inline sparisce quando la striscia lo mostra già.

## 3. Loader banale e schiacciato

**Oggi.** Una riga di testo da 11 px, alta 16 px, il cerchio che gira e una frase che ruota («Sto ragionando… · 6s · 3 × 10 · 42 token · ≈ 0,0 tok/s»), `MessageParts.tsx:59-300`. Misurato sul DOM durante un turno: 2 px dal blocco sopra, e sotto nessun respiro proprio (lo spazio sotto è quello del footer della lista). Nel drawer c'è un secondo loader, diverso («agent al lavoro… 28s», `06-drawer-al-lavoro.png`). I token al secondo scendono a 0,0 appena il tool lavora, un numero che sembra un guasto. Immagini: `02-loader-comando.png`, `03-loader-sottoagente.png`, video `08-drawer-al-lavoro.webm`.
**Coperto?** No: `active-agents-feedback` (archiviata) ha fatto il glifo, non l'insieme.
**Correzione.** Una sola grafica per chat e drawer: padding di 8 px sopra e sotto, la frase a sinistra e quello che sta facendo davvero («Esegue: rg -n …», dal tool in corso) al posto di token e tok/s; i numeri solo al passaggio del mouse.

## 4. Spazio sotto l'input troppo alto

**Oggi.** Misurato: in chat sotto il riquadro dell'input restano 50 px (riquadro 46 px; sotto la riga dei controlli «Agisce · ⚡ · modello · HIGH» di 30 px, più 12 px di margine del form, `m-3`). Nel drawer del task il riquadro sta a 12 px dal fondo. Stessa app, due ritmi.
**Coperto?** No.
**Correzione.** La riga dei controlli entra nel riquadro (una barra sotto il campo, come il drawer) e il margine del form scende a 8 px: ~16 px guadagnati, e chat e drawer finiscono alla stessa altezza.

## 5. Le scritte dei tool compaiono subito, non in streaming

**Oggi.** Il provider ignora per scelta i delta di testo e prende gli snapshot cumulativi (`claude-code.ts:4408-4412`, «Text/thinking deltas are ignored»): un paragrafo arriva intero al primo frame dopo l'emissione, senza nessuna cadenza lato client (nessun typewriter nel codice). I tool invece partono davvero in streaming: la riga nasce al `content_block_start` e l'argomento principale compare appena è completo (`:4412-4470`), quindi il difetto vero è il testo, e il nome del tool col suo `$ comando` che «salta» a riga intera.
**Coperto?** No (`chat-claude-code-parity` ha 31 caselle aperte ma nessuna su questo).
**Correzione.** Rivelazione lato client del testo appena arrivato, 2-3 caratteri a frame con tetto (mai più di 600 ms di ritardo sul reale), spenta con `prefers-reduced-motion` e per i blocchi già in storia; per i tool, il comando si scrive nella riga mentre arrivano i `partial_json`.

## 6. Terminali: font e resa

**Oggi.** xterm usa `'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo` a 13 px (`SingleTerminalPane.tsx:441`), la chat usa un'altra pila (`ui-monospace, SFMono-Regular, Consolas…`, `index.css:588`). JetBrains Mono non è incluso da nessuna parte (`document.fonts` vuoto): dove non è installato, e in questo giro, si vede Menlo. Il testo tocca il bordo sinistro e quello alto del pannello (nessun padding), l'interlinea è `normal` (15 px su 13), i caratteri a blocchi `░▒▓` hanno buchi. Immagine: `07-terminale.png`.
**Coperto?** No (`live-terminals` riguarda l'elenco dei terminali, non la resa).
**Correzione.** Una pila sola (JetBrains Mono incluso, `font-display: swap`), padding di 12 px, interlinea 1,25; i blocchi `░▒▓` li disegna il font (JetBrains Mono li ha), perché `customGlyphs` di xterm vale solo per i renderer canvas/WebGL e qui il DOM è tenuto apposta.

## 7. Anteprime nella board: solo dettagli tecnici

**Oggi.** La card in review porta: titolo, chip «Niente consegnato», «NOTA DI SISTEMA» con il testo della macchina, chip «serve te», «Sonnet 5 · via Claude Code · 35s», tre bottoni e un campo di commento (`04-board-anteprime.png`). La card in lavorazione mostra «ferma · nessun agente da 6 min» (uno stato di coda) e la card dispatchata «modifiche git ▾», «Triage», «Sonnet 5 · via Claude…». Quello che manca è la cosa che chiedi: *cosa sta facendo e a che punto è*. Cosa funziona già: quando l'ultima parola è dell'agente (la card «Stati vuoti nelle liste», KANBAN-71/`board-card-last-exchange`) la card mostra la sua frase, non la cronaca.
**Coperto?** In parte da `conversazione-unica-della-card` (ultima parola = domanda, stato di consegna come chip). Non copre la riga di avanzamento.
**Correzione.** Una riga di avanzamento nel corpo, in chiaro, sotto il titolo (ultimo passo del tool in corso, o l'ultima frase dell'agente). La nota di sistema è ripiegata sotto un «mostra» e mai sola nel corpo.
**Modello e durata sulla card (decisione di Attilio, 31/10).** Non più solo nel dettaglio: il modello con il provider, la durata e i token stanno in una sola riga secondaria discreta, in lavorazione e in review. Niente pillole impilate. Sta sulla stessa riga dello stato quando ci sta; il tempo dall'ultimo aggiornamento resta in fondo, a destra. A 300 px la riga non va in overflow: si accorcia dalla coda, prima i token e poi il resto.
**In review.** Il corpo tiene l'ultima frase dell'agente, anche quando l'ultima voce del thread è una nota di sistema; la nota sta ripiegata sotto «mostra». Sotto, la stessa riga secondaria con modello e durata.
**Tool una volta sola.** Il tool in corso compare solo nella riga di avanzamento in alto (`name · input`). La riga separata «Bash · …» sotto la misura è tolta, insieme al tempo trascorso sul tool: il tempo totale resta nella misura. Un test fallisce se `<LiveToolLine>` torna nella card.
**Pallino.** Il punto di lavorazione è il caricamento `SparkLoader` di main, non più il pallino sky.
**Decisione di Attilio (01/11), sostituisce i punti sulla misura e sui tasti di review sopra.**
- **Misura in fascia avvolta.** Una fascia larga quanto la card, sfondo tenue (`bg-black/[0.12]`, in scuro `dark:bg-white/[0.16]`), angoli arrotondati, testo `text-app-text-secondary` (il `text-app-text-muted` scende sotto 4,5:1 sulla fascia). A sinistra caricamento e «modello · provider» (il caricamento solo in lavorazione), che va a capo per intero: niente troncamento. A destra «⏱ durata · token» in cifre tabellari, mai a capo né tagliate, e «ora» (il tempo dall'ultimo aggiornamento) dentro la fascia, mai su una riga sua.
- **Review: sulla faccia solo «Approva».** Ogni altra uscita sta nel menu «…», «Archivia» compreso, anche sulle card con un ramo (03/11). «Rifai così» non è in nessuno dei due: rimandare indietro si fa dal campo, che invia il testo all'agente, dalla riga come dal menu (`sendsBackWithText`). Le liste le danno `reviewFaceExclude` e `reviewMenuExclude` in `taskChoices.ts`.
- **Prova.** `taskChoices.test.ts` («la review: faccia e menu») e `Card.test.ts` (contratto di faccia, menu, misura, «ora» nella fascia, riga di avanzamento). Contrasto: `cardMeasureBand.test.ts` calcola il rapporto dai token di `index.css` e dalle classi della fascia, in chiaro e in scuro. Riga di avanzamento: `cardProgressLine.test.ts`, sul valore. Mutazioni rosse (exit 1, poi ripristinato con `cmp` identico): «Archivia» tolto dal ramo; «drop» rimesso in faccia; modello tolto dalla fascia; troncamento del modello rimesso; testo muted sulla fascia; riga di avanzamento svuotata nel render e nella funzione; riga delle scelte che ignora `exclude`. E2e (non eseguite su questa macchina, le misura la CI): `board-card-choices`, `board-review-quiet-note`, `board-card-updated-ago`, più `board-card-landing-receipt` e `board-text-never-lands` (il «Landa su main» si apre dal menu) e `task-model-labels` (larghezza e scrollWidth della misura).

## 8. Il task come chat pulita (verifica tecnica)

**Come è fatto oggi.** Un task dispatchato è due cose: la card (`tasks`, commenti in `task_comments`) e **un topic vero** con la sua sessione (`assignedTopicId`; nel mio giro `topic:67a213fe`, marcato archiviato così non compare in sidebar, con la cronologia completa in `/api/history/topic:<8>`: la busta del dispatcher come riga utente, le frasi dell'agente, i tool). Il drawer è una proiezione dei due, in una colonna sola (`conversazione-unica-della-card`, 42 caselle su 43, manca solo la prova video 5.7). Quindi «il task è una sessione chat che nasconde il processo» tecnicamente è già vero: il processo sta nel topic nascosto, dietro «Dettagli sessione».
**Cosa non va, visto.** Nella colonna Conversazione di un task finito (`05-drawer-task.png`) sta tutto insieme, allo stesso peso: la frase dell'agente, «Turno della board: l'ha aperto il dispatcher · mostra il testo», «Turno concluso dall'agente senza portare il task in review: riprovo tra 60s… (tentativo 2/2)», un blocco «Nessun lavoro consegnato: 2 turni, nessun ramo…» con le «Ultime parole dell'agent (recuperate dalla sessione)» incollate senza a capo, «Consegna senza riassunto», «sistema Review». In 90 secondi di vita la card ha prodotto 6 righe di cronaca contro una frase vera. Durante il lavoro (`06-drawer-al-lavoro.png`) c'è solo «Dettagli sessione · 3 azioni» chiuso e un loader: non si capisce cosa succede.
**Correzione.** La colonna mostra solo parole (tue, dell'agente, domande) e UNA riga di stato viva che si riscrive («Legge dashboard.tsx», poi «Esegue i test»); la cronaca di sistema va in «Dettagli», già esistente; «Dettagli sessione» si apre con i passi in forma di striscia (sezione 2) e non come elenco di tool.
**Non ancora specificato.** Se una card in `in_progress` debba mostrare in colonna lo streaming del testo dell'agente (come un topic) o solo la riga di stato: dipende da quanto vuoi che somigli a una chat. Lo decidi guardando la riga viva.

## Fuori

Codice dell'interfaccia (lo scrive la card di ogni difetto, dopo il tuo ok); il modello dati task/topic; il Windows/Tauri shell; la resa su telefono (non misurata qui).

## Barra di questo studio

PR di sola documentazione aperta su `armonia/topics-app`; gli otto file `~/.topics/media/ui-task-topic-*` esistono (`ls -la`). Le barre delle card future: misura DOM (`scripts/ui-audit.js`) per gli spazi, `toHaveScreenshot` per la resa, e il tuo occhio per loader e font.

### Giro del 01/11 (fascia, tasti, placeholder)
- La misura sta in una fascia `rounded-lg bg-black/[0.12]` (in scuro `dark:bg-white/[0.16]`), larga quanto la card, uguale in lavorazione e in review. Non è `bg-app-user-bubble`: era troppo vicino alla card per vedersi.
- Il provider «via» esce dalla riga di misura (`measureLine`): a 300 px modello e provider restano interi; il tooltip conserva la riga piena.
- Placeholder del campo di commento: «Commenta o correggi…» (IT), «Comment or fix…» (EN); le spec e2e allineate.
- Il tempo «ora» sta dentro la fascia, a destra, insieme a durata e token (03/11). La soglia «0m fa» → «ora» resta a 45 s, come prima: la spec `board-card-updated-ago` la codifica.
- Il contrasto fra fascia e card è misurato da `cardMeasureBand.test.ts` (testo sulla fascia ≥ 4,5:1, fascia distinta dalla card ≥ 1,2:1, in chiaro e in scuro). La prova visiva resta l'affiancamento di Jarvis.
