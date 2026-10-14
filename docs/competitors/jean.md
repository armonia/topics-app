# Jean

## In tre righe
Jean è un ambiente desktop per pilotare agenti AI in parallelo, un worktree git per task, su laptop o server proprio [README].
Parla con nove backend CLI (Claude, Codex, OpenCode, Pi, Cursor, Command Code, Grok, Kimi, Antigravity) usando le installazioni e gli abbonamenti dell'utente, senza lock-in [README].
Il suo punto più forte rispetto a Topics è la maturità del flusso worktree più sessioni più review più integrazioni (GitHub, Linear, Sentry, CodeRabbit) con lo stesso backend Rust condiviso fra app desktop e server headless [README] [codice: jean-core/src/lib.rs:29].

## Identità
Repository `coollabsio/jean`, circa 1327 stelle e 162 fork al 2026-10-14, licenza Apache-2.0 [doc: https://github.com/coollabsio/jean] [codice: package.json:7].
Ultimo commit `bf10f32` del 2026-10-14, messaggio su archiviazione della sessione di piano originale [non verificato].
Release recenti molto ravvicinate: v1.0.11 del 2026-10-14, v1.0.10 del 2026-10-13, v1.0.9 del 2026-10-07 [release v1.0.11] [release v1.0.10] [release v1.0.9].
Progetto creato a gennaio 2026, quindi giovane (versione 1.0.x) ma con cadenza di release quasi giornaliera e circa 800 issue totali, segno di uso reale e manutenzione attiva [doc: https://github.com/coollabsio/jean/releases].
Piattaforme: macOS testato, Linux testato dalla comunità (Arch più Hyprland/Wayland), Windows non del tutto testato [README].
Dimensioni per confronto: il frontend TypeScript pesa circa 270 mila righe, il backend Rust circa 152 mila. Topics è più piccolo su entrambi gli assi, quindi da Jean conviene importare idee, non codice [non verificato].
Il nome del binario headless è `jean-server`, installabile con systemd su Linux e aggiornabile dal check di versione integrato [doc: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/docs/headless-server.md].

## Architettura
Linguaggi misurati sul clone: TypeScript più TSX circa 270.132 righe totali su 1126 file, Rust circa 152.523 righe su 148 file [codice: package.json:1] [codice: jean-core/Cargo.toml:1].
Il Rust si divide così: `jean-core` circa 149.451 righe (tutta la logica), `src-tauri` circa 3.062 righe (adattatore sottile), `src-server` circa 10 righe (solo entrypoint che riusa `jean-core`) [codice: src-server/src/main.rs:1] [codice: src-tauri/src/lib.rs:13].
Frontend: Tauri v2, React 19, TypeScript, Tailwind CSS v4, shadcn/ui v4, Zustand v5, TanStack Query, Pierre Diffs, xterm.js [README].
Modello dei processi: un solo `dispatch_core_command` Tauri riceve `(command, args)` e li smista al dispatch Rust di `jean-core`; lo stesso dispatch serve il WebSocket in modalità web access, quindi desktop e server condividono ogni comando [codice: src-tauri/src/lib.rs:16].
Storage: `rusqlite` con feature `bundled`, quindi SQLite senza dipendenza di sistema, più database agenti con FTS5, run log JSONL per sessione, worktree sotto `~/jean` di default e sovrascrivibile per progetto [codice: jean-core/Cargo.toml:20] [codice: jean-core/src/agents/db.rs:166].
Come parla con l'agente: non usa Agent SDK, lancia i CLI come processi figli e ne fa il parsing dello stream. Per Claude usa stream-json con estrazione dell'output strutturato dal tool sintetico `StructuredOutput`, per Pi usa un host RPC dedicato che sopravvive alla chiusura, per Codex usa l'app-server, per Grok e Kimi usa ACP [codice: jean-core/src/chat/mod.rs:42] [codice: jean-core/src/chat/claude.rs:1].
Dove sta il Rust e per cosa: ovunque nel backend. Orchestrazione chat per nove backend, PTY via `portable-pty`, git e GitHub/Linear/Sentry, server HTTP più WebSocket in Axum, MCP, resize e compressione immagini prima dell'invio, gestione processi cross platform [codice: jean-core/Cargo.toml:27] [codice: jean-core/Cargo.toml:29] [codice: jean-core/src/terminal/pty.rs:1].
Effetto: il Tauri fa solo da guscio (finestra, menu macOS, webview del browser, updater), tutta la logica vive in `jean-core` e gira identica su desktop e su Linux headless [codice: src-tauri/src/lib.rs:29] [doc: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/docs/headless-server.md].
Cosa fa il Rust dentro il guscio Tauri, in dettaglio: `desktop_commands.rs` espone vibrancy della finestra, notifiche native, lettura e scrittura clipboard con immagini [codice: src-tauri/src/desktop_commands.rs:49]; il modulo `platform` applica workaround per WebKit su Linux e recovery del processo WebView2 su Windows [codice: src-tauri/src/platform/mod.rs:1]; `remote_install.rs` valida host, utente SSH e porta e costruisce gli URL di web access [codice: src-tauri/src/remote_install.rs:64]; la config abilita `macOSPrivateApi` e l'updater integrato [codice: src-tauri/tauri.conf.json:52].
Modello dati delle sessioni: la struct `Session` in Rust porta resume id per backend (Codex thread id, Cursor chat id, sentinel per backend senza resume nativo) più stato di run sopravvissuto al restart, così il resume non dipende dallo storico proprietario del provider [codice: jean-core/src/chat/types.rs:788] [codice: jean-core/src/chat/types.rs:1728].
Ogni run scrive un log JSONL in append che si può riaprire in coda al restart, base del recupero dopo crash [codice: jean-core/src/chat/run_log.rs:26].

## Sessioni e task
Sessioni multiple per worktree, tab Recent trasversale ai progetti, modalità di esecuzione Plan, Build, Yolo più Supervised e Auto con plan approval flow [codice: src/types/chat.ts:66] [codice: jean-core/src/jean_mcp_core.rs:17] [README].
Ogni task ha il suo worktree git: creazione, archiviazione, restore, delete, label e filtri, progetti collegati per contesto cross project, directory base sovrascrivibile per progetto [README] [codice: jean-core/src/projects/commands.rs:118].
Strumenti di avanzamento: `/goal` tracking, recap di fine turno iniettato nel system prompt di ogni backend, digest di sessione, contesti salvati con summarization AI, auto naming, recovery delle run incomplete [codice: jean-core/src/chat/mod.rs:42] [README].
Automazioni: Mr. Robot interroga le issue GitHub aperte, crea un worktree per issue e prepara un piano eseguibile dopo approvazione; l'archiviazione automatica scatta quando la PR viene mergiata [README] [codice: src/hooks/useAutoArchiveOnMerge.ts:21].
Review e merge: diff viewer unificato e side by side con commenti per riga, generazione di contenuti PR e messaggi di commit via AI con schema JSON, risoluzione dei conflitti assistita, checkout di una PR come worktree, stato PR e workflow GitHub nel pannello [README].
Rispetto a Topics manca la kanban globale con code, tentativi, review, land e publish automatici: Jean è worktree centrico, l'orchestrazione fra task resta manuale o delegata a Mr. Robot sulle issue [non verificato].
Dettagli utili del flusso: i nomi dei worktree per le PR seguono una convenzione dedicata [codice: jean-core/src/projects/commands.rs:266]; la ricerca fra sessioni usa FTS5 con termini prefissati per parola [codice: jean-core/src/agents/db.rs:1448]; i plugin di opinione (RTK, Caveman) vivono in un modulo Rust dedicato da circa 2.749 righe [codice: jean-core/src/opinionated/commands.rs:1].
La chat gestisce permessi interattivi per backend: richieste di approvazione ACP, prompt di permesso Claude e code di approvazione con etichette dedicate nel frontend [codice: jean-core/src/chat/acp_permissions.rs:1] [codice: src/components/chat/AcpPermissionsRequest.tsx:1] [non verificato].

## Usabilità
Superfici: app desktop nativa, stessa UI servita via web access, viste mobili dedicate con swipe gesture [README].
Flussi principali: sidebar con progetti locali e remoti raggruppati per server, canvas di progetto con righe worktree, chat in modale o finestra, terminale multi dock, command palette, file browser con preview e editing [README].
Diff e review: Pierre Diffs con file list, statistiche, commenti di riga e tracking dei finding nelle review AI [README].
Notifiche: suoni configurabili, toast con azioni per le operazioni in background, badge su issue e PR aperte; notifiche server owned via ntfy risultano proposte ma non integrate al momento del clone [issue #591] [README].
Scorciatoie: keybinding configurabili, palette dei comandi, menu Magic su `Cmd/Ctrl+M`, toggle terminale e browser da tastiera [codice: src-tauri/src/lib.rs:94].
Onboarding: setup guidato che verifica prerequisiti (git, node, npm) e stato auth di ogni backend prima di marcarlo pronto, con installazione automatica solo dopo conferma esplicita [doc: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/docs/headless-server.md].
Regole di parità fra superfici: ogni nuovo comando Tauri deve essere registrato anche nel dispatch WebSocket, ogni azione nativa deve funzionare in web access e nelle viste mobili, con test sui tre casi [codice: src-tauri/src/lib.rs:402] [non verificato].
La guida interna agli agenti prescrive il pattern cipolla per lo stato (useState, Zustand per UI globale, TanStack Query per dati persistenti) e l'uso di `getState()` nei callback per evitare cascate di render [doc: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/AGENTS.md].

## Browser e anteprima
Sì, ma con architettura diversa da Topics e senza co-browse fra dispositivi. Ci sono due browser distinti [codice: src-tauri/src/browser/commands.rs:1] [codice: jean-core/src/agent_browser/mod.rs:1].
Il primo è il browser integrato dell'app desktop: tab webview secondarie con toolbar, navigazione, titoli ed eventi di load, più uno script di grab che estrae contesto React (selettore, testo, HTML troncato) dall'elemento cliccato per collegarlo alla chat [codice: src-tauri/src/browser/commands.rs:54].
Il secondo è l'agent browser per gli agenti: motore `vercel-labs/agent-browser` (Chromium dedicato), esposto ai CLI via MCP. Ogni sessione Jean ha la sua sessione browser isolata con profilo temporaneo, i login sono condivisi tramite chiave di restore unica, chiusura dopo 15 minuti di idle per liberare memoria [codice: jean-core/src/agent_browser/mod.rs:6].
L'agente pilota quindi un Chromium headless via MCP, non la webview vista dall'utente. Nessuna traccia di mirror del DOM Mac verso iPad né di pilotaggio del browser visibile con tool dedicati: il file di store del browser è solo locale [codice: src/store/browser-store.ts:1] [non verificato].
Dettagli di implementazione del browser desktop: il contesto catturato viene sanitizzato con troncamenti (testo a 10.000 caratteri, HTML a 80.000) prima di passare alla chat [codice: src-tauri/src/browser/commands.rs:20]; il registro dei tab vive in Rust con label per tab [codice: src-tauri/src/browser/registry.rs:1] [non verificato].
Dettagli dell'agent browser: il nome della sessione deriva dall'id Jean (`jean-<id>`), la directory di installazione gestita sta sotto app data, il comando MCP scritto nelle config dei CLI usa la chiave `agent-browser` [codice: jean-core/src/agent_browser/mod.rs:48].

## Terminale, editor, file
Terminale multi dock (flottante, sinistra, destra, basso) con xterm.js e ghostty-web, PTY Rust via `portable-pty` con normalizzazione delle dimensioni, gestione locale UTF-8 e guardie per IME e composizione [codice: jean-core/src/terminal/pty.rs:24] [README].
Apertura in editor esterno mappata per binario con argomenti goto e fallback su app macOS, più wrapper `.cmd` su Windows per evitare flash della console [codice: jean-core/src/lib.rs:77].
Operazioni git integrate con rilevamento conflitti, stash, revert, fetch e merge; file browser con preview, editing e scorciatoia dedicata [README].
Checkpoint AI prima del turno agente su ref `refs/jean/checkpoints`, con prune dei più vecchi, diff e restore [codice: jean-core/src/projects/checkpoints.rs:1].
Il terminale condivide ambiente di run dedicato fra comandi agente e shell interattiva, con registro centrale delle sessioni PTY in Rust [codice: jean-core/src/terminal/registry.rs:1] [non verificato].
Lo stato dei terminali per worktree è tenuto in uno store dedicato con test, separato da chat e progetti [codice: src/store/terminal-store.ts:1] [non verificato].

## Remoto e mobile
Ogni istanza Jean, desktop o headless, può servire l'intera UI su HTTP più WebSocket con token auth, porta di default 3456. Sul desktop è un interruttore in Settings, su `jean-server` è sempre attivo [README] [codice: jean-core/src/http_server/server.rs:26].
Multiserver: il desktop mostra progetti locali e remoti insieme nella stessa sidebar raggruppati per server, ogni azione gira sul server proprietario, installazione remota anche via SSH [README] [codice: src-tauri/src/lib.rs:402].
L'installazione remota avviene via SSH su host Linux con verifica di readiness, riesce a leggere gli host da `~/.ssh/config` e testa la connessione prima di procedere [codice: src-tauri/src/remote_install.rs:1] [codice: src-tauri/src/remote_install.rs:431].
Sicurezza del canale: token casuale da 32 byte in base64url con confronto a tempo costante, bind consigliato su localhost o rete privata, per l'esterno si raccomanda Tailscale con HTTPS davanti a localhost invece di esporre la porta [codice: jean-core/src/http_server/auth.rs:4] [README].
Telefono e tablet: viste mobili dedicate, non solo responsive, con gesture di swipe e scorciatoie da tastiera disattivate dove non hanno senso [README].

## Provider e protocolli
Nove backend: Claude, Codex, Cursor, OpenCode, Pi, Command Code, Grok, Kimi Code e Antigravity in beta, più profili CLI custom [README] [codice: jean-core/src/jean_mcp_core.rs:318].
Selezione modello e livelli thinking/effort con override per modalità, prompt di sistema custom, MCP server per backend, collaborazione multi agente, allegati file e immagini, ricerca in chat [README].
Protocolli: ACP per Grok e Kimi, server MCP proprio in tre trasporti (stdio con `--jean-mcp-stdio`, socket locale, HTTP) con protocollo `2024-11-05` e tool come `send_chat_message` con rate limit [codice: jean-core/src/jean_mcp_core.rs:19].
Autenticazione lecita: nessun proxy di token, Jean rileva i binari esistenti e verifica lo stato auth di ogni CLI, usando installazioni e abbonamenti dell'utente [README] [codice: jean-core/src/claude_cli/commands.rs:1387].
La verifica distingue installato più autenticato, installato non autenticato, non installato e comando fallito, con comandi di login e riloggazione per backend [non verificato].

## Performance
Avvio: binario unico per il server che incorpora `dist/` a compile time, niente asset da copiare in deploy [doc: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/docs/headless-server.md].
Rendering: lista messaggi virtualizzata, flush e coalescing dello streaming, TanStack Query con cache dei dati iniziali, guardie anti re-render negli store Zustand, parser incrementale riga per riga per evitare costi quadratici sulle sessioni lunghe [codice: src/components/chat/ChatWindow.tsx:188].
Immagini: resize a max 1568px sul lato lungo e compressione JPEG a 85% in `spawn_blocking`, con costo stimato in token documentato nel codice [non verificato].
Lamentele nelle issue: problemi di performance generici [issue #692], degrado su macOS Intel dalla v0.1.26 [issue #156], ottimizzazione dello streaming su WebKitGTK Linux [issue #129], RAM alta da processi `claude` orfani dopo la chiusura su Linux [issue #14], worktree lenti che spariscono dalla sidebar [issue #528], terminale che si blocca dopo inattività [issue #320].
Rust per la velocità: PTY e processi, parsing stream, SQLite bundled, server Axum con WebSocket, elaborazione immagini. Effetto dichiarato: stesso backend per desktop e server senza duplicare logica, non benchmark numerici [codice: jean-core/Cargo.toml:20].
Altri accorgimenti misurabili nel codice: normalizzazione delle dimensioni PTY per evitare asserzioni su valori degeneri e viewport minima 80 per 24 per i CLI interattivi [codice: jean-core/src/terminal/pty.rs:24]; mutazioni degli store Zustand con guardie anti no-op per non notificare tutti i subscriber a ogni `set()` [doc: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/AGENTS.md].
Sul fronte desktop: su Windows ogni `Command` passa da un helper silenzioso per non far lampeggiare la console, e solo le aperture intenzionali di UI usano il comando diretto [doc: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/AGENTS.md] [issue #589].

## Affidabilità e qualità
Test: 443 file fra unit, regression e script, più 13 spec e2e Playwright e suite Rust via `cargo test`; il gate `check:all` unisce typecheck, lint, fmt, clippy e tutti i test [codice: vitest.config.ts:1] [codice: package.json:1].
Persistenza: run log JSONL per sessione con resume dopo restart, host RPC dedicato per Pi che sopravvive alla chiusura, checkpoint git prima dei turni, archiviazione con retention [codice: jean-core/src/chat/mod.rs:42].
Recupero: envelope durevoli per prompt non inviati richiesti ma ancora aperti [issue #701], storia conversazione che sparisce dopo approvazione del piano segnalata il giorno del clone [issue #795].
Aggiornamenti: updater Tauri integrato con voce di menu dedicata su macOS, installer di release per `jean-server` con servizio systemd [codice: src-tauri/src/lib.rs:69].
Copertura test per area: regression mirate su reload web, replay dello stream, chiusura finestra e snapshot delle sessioni in corso, più unit su routing dei comandi, permessi, terminale e store [codice: src/App.web-stream-replay-regression.test.ts:1] [non verificato].
Il gate di qualità rifiuta warning: clippy con `-D warnings` sui tre manifest Rust, fmt check, eslint a zero warning, più test Rust e TypeScript in sequenza [codice: package.json:1].

## Sicurezza e privacy
Token di accesso generato in modo crittografico e validato a tempo costante, auth attiva di default, sconsiglio esplicito di bind su `0.0.0.0` senza TLS [codice: jean-core/src/http_server/auth.rs:11] [README].
Sandbox: modalità di esecuzione mappate sui controlli nativi di ogni backend più prompt di permesso interattivi, con tool dedicato per Claude e permessi ACP [codice: jean-core/src/chat/mod.rs:42].
Superficie Tauri: CSP restrittiva, protocollo asset limitato a `.jean/images` e app data, niente drag drop verso la finestra [codice: src-tauri/tauri.conf.json:1].
Credenziali: usa le login CLI dell'utente verificate per backend, nessuna esfiltration verso cloud di terze parti, tutto gira su macchine controllate dall'utente [README].
Telemetria: nessuna voce dedicata trovata in README e SECURITY, da considerare non verificata prima di dichiararla assente [non verificato].
Porte esposte: solo quella di web access se abilitata, con token obbligatorio [codice: jean-core/src/http_server/server.rs:47].
Validazione input: i comandi Rust validano nomi file con regex restrittiva e limiti di lunghezza su tema e stringhe prima di toccare il disco [codice: jean-core/src/lib.rs:88].
Installazione remota prudente: validazione di utente SSH, host e porta con escape della shell dedicato, e parsing del token senza mai stamparlo in chiaro nei log [codice: src-tauri/src/remote_install.rs:64].

## Estendibilità
MCP in entrambe le direzioni: Jean espone un proprio server MCP agli agenti esterni e si collega ai server MCP configurati per ogni backend, con discovery, health check e toggle [README] [codice: jean-core/src/jean_mcp_core.rs:19].
Magic prompt e magic command interamente editabili, ognuno con backend, modello, effort e modalità propri [README].
Plugin di opinione one click: RTK che dichiara un taglio del 60-90 percento dei token di output dei tool, e Caveman per risposte più terse [README].
Profili CLI custom, skill con servizio dedicato, command system con registry centrale, hook di sincronizzazione stato fra client [codice: src/services/skills.ts:1] [non verificato].
Le skill sono scoperte per backend e per worktree via TanStack Query con chiavi dedicate (Claude skill e comandi, Codex skill), quindi ogni sessione vede solo le skill del suo backend e del suo path [codice: src/services/skills.ts:10].
Il server MCP espone anche un tool `get_usage` con snapshot di abbonamento per Claude, Codex e Grok, pensato per decidere il cambio modello quando un piano si avvicina ai limiti [codice: jean-core/src/jean_mcp_core.rs:328].
I livelli di effort e thinking sono enumerati e condivisi fra UI, comandi e MCP (`off`, `adaptive`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultracode`) con override per singolo turno senza sporcare le impostazioni di sessione [codice: jean-core/src/jean_mcp_core.rs:318] [codice: src/types/chat.ts:26].

## Da prendere per Topics
1. Un solo dispatch Rust per desktop e web: un comando Tauri unico che smista su `jean-core` e lo stesso smistamento dietro il WebSocket elimina la doppia implementazione nativo più remoto [codice: src-tauri/src/lib.rs:16]. Per Topics conta perché oggi il guscio e il servizio rischiano di divergere.
2. Agent browser con sessione isolata per task e restore key condivisa per i login [codice: jean-core/src/agent_browser/mod.rs:34]. Per Topics conta perché dà agli agenti un browser pilotabile senza toccare la webview dell'utente.
3. Recap di fine turno iniettato nel system prompt con rendering compatto dedicato [codice: jean-core/src/chat/mod.rs:42]. Per Topics conta perché rende la lista topic scansionabile senza rileggere ogni turno.
4. Auto archiviazione del worktree al merge della PR [codice: src/hooks/useAutoArchiveOnMerge.ts:21]. Per Topics conta perché chiude da solo il ciclo task più review più land.
5. Mr. Robot: una issue GitHub diventa worktree più piano da approvare [README]. Per Topics conta come modello per collegare la kanban alle issue senza orchestrazione manuale.
6. Checkpoint git su ref dedicata prima di ogni turno agente [codice: jean-core/src/projects/checkpoints.rs:1]. Per Topics conta come rete di sicurezza economica contro edit distruttive.
7. Magic prompt editabili con backend e modello propri per operazione [README]. Per Topics conta perché review, commit e release note possono usare modelli economici diversi dalla chat.
8. Pre resize e compressione immagini prima dell'invio al modello [non verificato]. Per Topics conta perché taglia token e banda su co-browse con screenshot.
9. Tool MCP `get_usage` con snapshot di abbonamento per decidere il cambio modello a piano quasi esaurito [codice: jean-core/src/jean_mcp_core.rs:328]. Per Topics conta perché la kanban lancia agenti da sola e deve sapere quando un backend è scarico.
10. Installazione del server remoto via SSH con lettura di `~/.ssh/config`, test di connessione e verifica di readiness [codice: src-tauri/src/remote_install.rs:431]. Per Topics conta come modello per portare il servizio fuori dal Mac senza cloud.

## Da evitare
Evitare la proliferazione di modalità di esecuzione: plan, build, yolo, supervised e auto generano confusione e richieste di rimozione o sostituzione con comandi espliciti [issue #787] [codice: src/types/chat.ts:66].
Evitare processi CLI orfani alla chiusura: su Linux i processi agente restano in memoria e vanno bonificati con supervisione esplicita [issue #14].
Evitare WebKitGTK come collo di bottiglia dello streaming su Linux senza ottimizzazioni dedicate [issue #129].
Evitare stati di sessione ambigui su Windows e webview che perdono il focus tastiera dopo Alt più Tab, entrambi segnalati come bug reali [issue #590] [issue #724].
Evitare il flash della console Windows lanciando comandi con flag di creazione silenziosa: Jean ha dovuto introdurre un helper dedicato dopo le segnalazioni [issue #589].
Evitare la perdita di cronologia dopo l'approvazione del piano: il bug del giorno del clone mostra che l'archiviazione della sessione originale è il punto più fragile del flusso plan approval [issue #795].
Evitare comandi che esistono solo su desktop: ogni comando va registrato anche nel dispatch WebSocket o in web access fallisce con errore generico, e la parità va testata su tre superfici [non verificato].

Nota di metodo: ogni sezione sopra ha contenuto, nessuna è stata marcata come non applicabile perché Jean copre tutte le aree di Topics con architettura diversa [non verificato].
## Fonti
- README: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/README.md
- Headless server: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/docs/headless-server.md
- Release: https://github.com/coollabsio/jean/releases (v1.0.11 del 2026-10-14, v1.0.10 del 2026-10-13, v1.0.9 del 2026-10-07)
- jean-core lib: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/jean-core/src/lib.rs#L29
- Tauri adapter: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/src-tauri/src/lib.rs#L16
- Browser desktop: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/src-tauri/src/browser/commands.rs#L1
- Agent browser: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/jean-core/src/agent_browser/mod.rs#L1
- PTY: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/jean-core/src/terminal/pty.rs#L1
- HTTP server: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/jean-core/src/http_server/server.rs#L26
- Auth token: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/jean-core/src/http_server/auth.rs#L4
- MCP core: https://github.com/coollabsio/jean/blob/bf10f3216156752dee7c99b0e46c7441024bce27/jean-core/src/jean_mcp_core.rs#L17
- Issue: #14, #129, #156, #320, #528, #589, #590, #591, #692, #701, #724, #787, #795 su https://github.com/coollabsio/jean/issues
