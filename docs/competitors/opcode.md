# opcode

## In tre righe

opcode è un'app desktop (Tauri 2 più React) che fa da centro di comando per Claude Code: progetti, sessioni, agenti personalizzati in background, checkpoint con timeline, usage analytics e gestione MCP, il tutto usando la CLI `claude` installata dall'utente.
È pensata per sviluppatori che pagano Claude con abbonamento o API e vogliono una GUI invece del terminale.
Il suo punto più forte rispetto a Topics è il sistema di checkpoint con snapshot dei file, timeline visiva, fork e diff, unito a una dashboard di costi e token letta dai JSONL.

## Identità

Repository: https://github.com/winfunc/opcode, clone verificato allo SHA `d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b` [codice: repos/opcode, rev-parse HEAD].
Stelle: 22.414 al momento della misura, con licenza AGPL-3.0 [doc: https://github.com/winfunc/opcode].
Ultimo commit: 2026-09-18, release più recente v0.2.0 del 2025-08-31, precedente v0.1.0 del 2025-08-15, versione in `package.json` 0.2.1 [release v0.2.0].
Progetto creato a giugno 2025, quindi giovane (meno di un anno di vita alla v0.2) ma con crescita di stelle molto rapida [doc: https://github.com/winfunc/opcode].
I titoli di alcune issue parlano di "Claudia" e un sito `claudiacode.com`, segnale di un rinominazione passata da Claudia a opcode [issue #180] [issue #204].
Piattaforme: Linux x86_64 e ARM64, Windows, macOS, tutte compilate in CI [codice: .github/workflows/build-test.yml:24].
Maturità: pre 1.0, cadenza di release lenta (due release in due settimane ad agosto 2025, poi solo commit), issue aperte con crash e freeze ancora irrisolti [issue #289] [issue #327].

## Architettura

Linguaggi misurati sul clone: Rust circa 11.072 righe in 20 file, TypeScript più TSX circa 39.260 righe in 122 file [codice: `git ls-files '*.rs' | xargs wc -l`] [codice: `git ls-files '*.ts' '*.tsx' | xargs wc -l`].
Frontend: React 18, Vite 6, Tailwind 4, Zustand, Radix UI, Recharts per i grafici [codice: package.json:33].
Guscio: Tauri 2 con plugin dialog, shell, fs, process, updater, notification, clipboard, global-shortcut, http [codice: src-tauri/Cargo.toml:28].
Il backend Rust espone circa 90 comandi Tauri registrati in un unico `invoke_handler`: gestione progetti e sessioni Claude, checkpoint, agenti, usage, MCP, storage SQL, slash command, proxy [codice: src-tauri/src/main.rs:186].
Come parla con l'agente: niente Agent SDK, niente ACP, niente PTY. Lancia la CLI con `tokio::process::Command` in modalità headless (`-p`, `--output-format stream-json`, `--verbose`) e ne trasmette lo stdout riga per riga al frontend tramite eventi Tauri `claude-output:{sessionId}` [codice: src-tauri/src/commands/claude.rs:1174] [codice: src-tauri/src/commands/claude.rs:1269].
Cosa fa Rust, in concreto: spawning e kill dei processi, streaming stdout e stderr su task Tokio separati, snapshot e diff dei file per i checkpoint, parsing dei JSONL per le statistiche di uso, database SQLite con `rusqlite` (`agents.db`: agenti, run, impostazioni), server web alternativo con Axum [codice: src-tauri/src/process/registry.rs:239] [codice: src-tauri/src/commands/usage.rs:140] [codice: src-tauri/src/web_server.rs:770].
Modello dei processi: ogni esecuzione agente è un processo OS separato tracciato in un `ProcessRegistry` (run_id, PID, handle, output live), con kill gentile via SIGTERM e fallback SIGKILL dopo timeout [codice: src-tauri/src/process/registry.rs:363].
IPC: comandi Tauri `invoke` più eventi; in modalità web gli stessi concetti diventano REST più WebSocket con ponte a DOM `CustomEvent` in `apiAdapter.ts` [codice: src/lib/apiAdapter.ts:1].
Storage: JSONL di Claude come fonte di verità per le sessioni, SQLite per agenti e impostazioni, `timeline.json` più snapshot per i checkpoint [codice: src-tauri/src/checkpoint/mod.rs:215].
Binari: esiste un secondo binario `opcode-web` (Axum) oltre alla GUI, selezionato da `[[bin]]` in Cargo [codice: src-tauri/Cargo.toml:11].

## Sessioni e task

Le sessioni sono quelle native di Claude Code: opcode legge `~/.claude/projects`, mostra metadati e primo messaggio, e supporta nuova sessione, continue e resume [codice: src-tauri/src/commands/claude.rs:22].
Sessioni parallele: sì, più tab chat e più run agenti contemporanei, con registro dei processi in Rust e tab con stato running [codice: src-tauri/src/process/registry.rs:220] [codice: src/contexts/TabContext.tsx:40].
Niente worktree, niente board kanban, niente code, tentativi, review, merge, PR o CI: nessuna occorrenza di worktree o kanban nel codice [non verificato oltre grep].
Gli agenti personalizzati (CC Agents) hanno system prompt, modello, flag di permesso e hook, girano in processi separati e registrano cronologia completa con metriche calcolate dai JSONL [codice: src-tauri/src/commands/agents.rs:681].
Il fork da checkpoint crea un ramo di sessione, che è il meccanismo più vicino a un "tentativo parallelo" [codice: src-tauri/src/main.rs:216].
La review avviene sui diff tra checkpoint, non su PR [codice: src-tauri/src/main.rs:221].

## Usabilità

Superfici: app desktop più modalità web sperimentale per telefono, nessuna TUI, nessuna app mobile nativa [codice: src-tauri/src/web_main.rs:1].
Flusso principale: progetti, selezione sessione, chat con prompt fluttuante, tab multipli fino a 20 con persistenza su storage locale [codice: src/contexts/TabContext.tsx:40] [codice: src/contexts/TabContext.tsx:147].
Diff e review: visualizzatore diff tra checkpoint e widget per tool (Bash, Todo, file) [codice: src/components/ToolWidgets.tsx:1].
Notifiche e scorciatoie: plugin Tauri dichiarati in capabilities (`notification:default`, `global-shortcut:default`), titlebar custom, vibrancy macOS [codice: src-tauri/capabilities/default.json:6] [codice: src-tauri/src/main.rs:151].
Onboarding: schermata iniziale, rilevamento automatico di `~/.claude`, dialogo di selezione del binario Claude con discovery da nvm, Homebrew e PATH [codice: src-tauri/src/claude_binary.rs:33].
Extra: editor CLAUDE.md con anteprima, editor di hook con validazione, manager di slash command, import di agenti da GitHub [codice: src-tauri/src/commands/claude.rs:20].

## Browser e anteprima

Niente browser integrato vero e niente co-browse. Il componente `WebviewPreview` è un segnaposto con `iframe`: i commenti dicono esplicitamente che la navigazione webview reale sarà implementata in futuro [codice: src/components/WebviewPreview.tsx:69] [codice: src/components/WebviewPreview.tsx:105].
Serve solo da anteprima per dev server locali (`initialUrl` tipo `http://localhost:3000`), con barra URL e controlli finti [codice: src/components/WebviewPreview.tsx:50].
L'agente non pilota alcuna pagina: non esistono tool di automazione browser nel backend Rust [non verificato oltre grep].
Nessuna sincronizzazione DOM fra dispositivi, quindi nessun equivalente del co-browse Mac iPad di Topics.

## Terminale, editor, file

Niente terminale PTY integrato: l'output dei comandi Bash appare in widget di sola lettura dentro la chat [codice: src/components/ToolWidgets.tsx:1].
Editor inclusi: editor Markdown per CLAUDE.md con anteprima live, editor file Claude generico, editor di hook, tutti come tab [codice: src/contexts/TabContext.tsx:12].
File: lettura directory, ricerca file, file recenti e file picker esposti come comandi Rust che leggono il filesystem dell'utente [codice: src-tauri/src/main.rs:208].
Il pezzo forte è il checkpointing a livello file: traccia le operazioni Edit, Write e Bash dai messaggi, fotografa i file prima e dopo, ripristina con un click [codice: src-tauri/src/checkpoint/manager.rs:60] [codice: src-tauri/src/checkpoint/manager.rs:87].
Gli snapshot vivono dentro `~/.claude/projects/<id>/.timelines/<session>/` come `timeline.json` più cartelle checkpoint [codice: src-tauri/src/checkpoint/mod.rs:222].

## Remoto e mobile

Il binario `opcode-web` avvia un server Axum (default porta 8080) pensato per l'accesso da telefono in LAN, con REST più WebSocket per lo streaming [codice: src-tauri/src/web_server.rs:842] [codice: src-tauri/src/web_server.rs:831].
Il documento di design dichiara però problemi critici ancora aperti: eventi senza scope di sessione (le sessioni si disturbano), endpoint di cancel finto che non termina i processi, stderr non catturato, niente eventi di cancellazione [doc: https://github.com/winfunc/opcode/blob/d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b/web_server.design.md#L354].
Niente autenticazione, niente cifratura dichiarata, CORS aperto a tutte le origini, bind su `0.0.0.0` [codice: src-tauri/src/web_server.rs:776] [codice: src-tauri/src/web_server.rs:831].
La modalità web è quindi funzionale per una singola sessione ma non pronta per produzione secondo gli stessi autori [doc: https://github.com/winfunc/opcode/blob/d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b/web_server.design.md#L372].

## Provider e protocolli

Solo Claude Code: nessuna occorrenza di Codex, Gemini, OpenAI o ACP nel codice Rust e TypeScript [non verificato oltre grep].
Il modello si sceglie per sessione e per agente (campo `model` su run ed esecuzione) [codice: src-tauri/src/commands/agents.rs:681].
MCP in lettura e scrittura verso Claude: aggiunta server, lista, dettaglio, rimozione, import da JSON e da Claude Desktop, test di connessione, stato server, config di progetto [codice: src-tauri/src/commands/mcp.rs:121] [codice: src-tauri/src/commands/mcp.rs:644].
opcode non espone un proprio server MCP agli agenti, a differenza di Topics [non verificato oltre grep].
Supporto proxy HTTP e HTTPS con impostazioni persistite nel database e applicate all'avvio [codice: src-tauri/src/main.rs:66].
Hook di Claude Code modificabili da UI con merge a priorità utente, progetto e locale [codice: src/lib/hooksManager.ts:18].

## Performance

Avvio e memoria: nessun benchmark dichiarato nel repo [non verificato].
Rendering: liste virtualizzate con `@tanstack/react-virtual` nel viewer di esecuzione e cache dell'output per non rileggere i log [codice: src/components/AgentExecution.tsx:199] [codice: src/components/AgentRunOutputViewer.tsx:80].
Streaming reale riga per riga senza buffering, sia su eventi Tauri sia su WebSocket [codice: src-tauri/src/commands/claude.rs:1226].
Background: processi OS separati più monitoraggio risorse nel frontend ogni 2 minuti [codice: src/main.tsx:25].
Rust per la velocità: parsing JSONL per usage e snapshot file in Rust, niente sidecar Node, profilo release con LTO e `opt-level = "z"` [codice: src-tauri/Cargo.toml:74] [codice: src-tauri/src/commands/usage.rs:252].
Lamentele degli utenti: UI in lag dopo l'installazione [issue #180], build troppo lenta [issue #306], freeze al click con mancato riavvio [issue #327].

## Affidabilità e qualità

Test: 9 unit test Rust (8 in `claude.rs`, 1 in `checkpoint/state.rs`), nessun runner di test frontend dichiarato in `package.json`, documenti di test manuali sotto `src-tauri/tests/` [codice: src-tauri/src/commands/claude.rs:2191] [codice: src-tauri/src/checkpoint/state.rs:137].
CI compila su 4 piattaforme a ogni push e PR [codice: .github/workflows/build-test.yml:17].
Persistenza: la cronologia sopravvive perché vive nei JSONL di Claude; tab e timeline hanno persistenza propria [codice: src/contexts/TabContext.tsx:50].
Recupero: kill con SIGTERM, attesa fino a 5 secondi, poi SIGKILL e pulizia del registro [codice: src-tauri/src/process/registry.rs:299].
Aggiornamenti: dipendenza `tauri-plugin-updater` e permesso `updater:default` presenti, ma nessun endpoint di update visibile in `tauri.conf.json` [non verificato].
Bug aperti rilevanti: crash su installazione pulita [issue #289], freeze [issue #327], errore GBM su Arch Linux con Tauri [issue #26], checkpoint non creabile [issue #157], messaggi doppi con doppio consumo di token [issue #390], "Failed to send prompt" [issue #40], incolla immagini non funzionante [issue #135], percorsi con spazi falliti [issue #444].

## Sicurezza e privacy

Usa le credenziali dell'utente in modo lecito: non gestisce token o OAuth propri, trova e lancia la CLI `claude` dell'utente (con percorso personalizzabile) che usa l'abbonamento esistente [codice: src-tauri/src/claude_binary.rs:33].
Ogni esecuzione passa però `--dangerously-skip-permissions`, che disattiva le richieste di conferma di Claude: vale per sessioni, agenti e modalità web [codice: src-tauri/src/commands/claude.rs:943] [codice: src-tauri/src/commands/agents.rs:767] [codice: src-tauri/src/web_server.rs:486].
Sandbox: processi separati dichiarati nel README [README], ma i flag di permesso per agente risultano solo memorizzati mentre l'esecuzione salta comunque i permessi [codice: src-tauri/src/commands/agents.rs:389].
Scope filesystem molto largo: plugin fs su `$HOME/**` con lettura e scrittura totali, shell libera di eseguire `claude` con argomenti arbitrari [codice: src-tauri/capabilities/default.json:6].
Telemetria contraddittoria: il README dichiara "No Telemetry" [README], ma `main.tsx` monta `PostHogProvider` e il gestore del consenso parte con telemetria abilitata di default [codice: src/main.tsx:47] [codice: src/lib/analytics/consent.ts:27].
Rete: la modalità web espone il backend in LAN senza autenticazione, con CORS permissivo e CSP che consente `unsafe-eval` più domini PostHog [codice: src-tauri/src/web_server.rs:776] [codice: src-tauri/tauri.conf.json:28].

## Estendibilità

Agenti impacchettati come JSON condivisibili, con libreria locale, import ed export da file e browser di agenti da GitHub [codice: src-tauri/src/main.rs:250] [codice: cc_agents/README.md:1].
Slash command con CRUD completo da UI [codice: src-tauri/src/main.rs:285].
Hook di Claude editabili con validazione dei comandi [codice: src-tauri/src/main.rs:211].
Tab Storage che permette di leggere e scrivere il database SQLite con SQL diretto [codice: src-tauri/src/main.rs:277].
Niente API di plugin, niente skill, niente bus di eventi per estensioni: l'estendibilità passa dai formati di Claude (agenti, hook, MCP, slash command), non da un SDK [non verificato oltre grep].

## Da prendere per Topics

1. Checkpoint con snapshot file e timeline: cosa (fotografa i file toccati da Edit, Write e Bash, timeline con restore e fork), dove [codice: src-tauri/src/checkpoint/manager.rs:60], perché Topics non ha undo di sessione e questo è il gap più visibile.
2. Diff tra checkpoint: cosa (confronto fra due checkpoint da UI), dove [codice: src-tauri/src/main.rs:221], perché la review su Topics passerebbe da PR Git a confronto immediato pre merge.
3. Dashboard usage da JSONL: cosa (costi e token per modello, progetto e giorno con prezzi calcolati in Rust), dove [codice: src-tauri/src/commands/usage.rs:104], perché Topics non mostra quanto consuma ogni topic.
4. Libreria agenti in JSON condivisibile: cosa (file `.opcode.json` con prompt, modello e permessi più browser GitHub), dove [codice: cc_agents/README.md:1], perché Topics potrebbe distribuire agenti di board nello stesso formato.
5. Import MCP da Claude Desktop più test connessione: cosa (un click per importare server esistenti e verificarli), dove [codice: src-tauri/src/commands/mcp.rs:462] [codice: src-tauri/src/commands/mcp.rs:644], perché abbassa l'onboarding MCP a zero.
6. Discovery del binario Claude: cosa (cerca fra nvm, Homebrew, PATH e percorso custom persistito), dove [codice: src-tauri/src/claude_binary.rs:33], perché Topics lancia già `claude -p` e oggi si fida del PATH.
7. Eventi con scope di sessione: cosa (`claude-output:{id}` più canale generico), dove [codice: src-tauri/src/commands/claude.rs:1269], perché è il pattern che evita interferenze fra topic paralleli.
8. Kill gentile poi forzato: cosa (SIGTERM, attesa 5 s, SIGKILL, pulizia registro), dove [codice: src-tauri/src/process/registry.rs:299], perché la board di Topics che lancia agenti ha bisogno della stessa disciplina di spegnimento.
9. Output virtualizzato con cache: cosa (`useVirtualizer` più `outputCache`), dove [codice: src/components/AgentExecution.tsx:199], perché i log lunghi di Topics soffrono dello stesso problema di rendering.
10. Proxy persistito nel database e applicato all'avvio: cosa (impostazioni lette da SQLite prima di ogni lancio), dove [codice: src-tauri/src/main.rs:66], perché Topics in LAN aziendale incontrerà gli stessi proxy.

## Da evitare

1. `--dangerously-skip-permissions` sempre attivo: tre call site in desktop più tre in web, mai condizionato, trasforma ogni agente in esecuzione senza conferme [codice: src-tauri/src/commands/claude.rs:943].
2. Contraddizione sulla telemetria: README che promette zero tracciamento mentre PostHog è attivo di default mina la fiducia, e il dossier finisce in un repo pubblico [codice: src/main.tsx:47].
3. Anteprima iframe spacciata da browser: controlli di navigazione finti e TODO aperti, meglio non promettere un browser finché non c'è [codice: src/components/WebviewPreview.tsx:105].
4. Server LAN senza auth con CORS aperto: il combo bind `0.0.0.0`, `allow_origin(Any)` e cancel finto espone esecuzione di comandi a chiunque sia in rete [codice: src-tauri/src/web_server.rs:776].
5. Scrittura di `.claude/settings.json` solo se assente: se il file esiste gli hook dell'agente vengono ignorati in silenzio invece di fondersi [codice: src-tauri/src/commands/agents.rs:696].
6. Scope fs totale (`$HOME` più read-all e write-all): per un'app che apre progetti arbitrari è un bersaglio troppo largo da copiare [codice: src-tauri/capabilities/default.json:6].
7. Zero test frontend a fronte di 39 mila righe TS: le issue su freeze, doppi messaggi e percorsi con spazi mostrano dove si paga [issue #327] [issue #390] [issue #444].

## Fonti

- Repository e stelle: https://github.com/winfunc/opcode
- Release: https://github.com/winfunc/opcode/releases (v0.2.0 latest, v0.1.0)
- SHA del clone: `d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b` via `git -C repos/opcode rev-parse HEAD`
- Backend comandi: https://github.com/winfunc/opcode/blob/d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b/src-tauri/src/commands/claude.rs#L1174
- Registro processi: https://github.com/winfunc/opcode/blob/d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b/src-tauri/src/process/registry.rs#L239
- Checkpoint: https://github.com/winfunc/opcode/blob/d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b/src-tauri/src/checkpoint/manager.rs#L60
- Percorsi checkpoint: https://github.com/winfunc/opcode/blob/d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b/src-tauri/src/checkpoint/mod.rs#L215
- Agenti: https://github.com/winfunc/opcode/blob/d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b/src-tauri/src/commands/agents.rs#L681
- Usage: https://github.com/winfunc/opcode/blob/d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b/src-tauri/src/commands/usage.rs#L104
- MCP: https://github.com/winfunc/opcode/blob/d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b/src-tauri/src/commands/mcp.rs#L121
- Web server e limiti: https://github.com/winfunc/opcode/blob/d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b/web_server.design.md#L354
- Telemetria: https://github.com/winfunc/opcode/blob/d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b/src/main.tsx#L47
- Anteprima iframe: https://github.com/winfunc/opcode/blob/d1ca30a3c0c39fff01fde2f86c2d5af6a1db658b/src/components/WebviewPreview.tsx#L105
- Issue citate: #26, #40, #135, #157, #180, #204, #289, #306, #327, #390, #444 su https://github.com/winfunc/opcode/issues
