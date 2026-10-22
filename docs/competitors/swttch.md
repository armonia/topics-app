# Swttch

## In tre righe
Swttch è un pannello GUI per la CLI di Claude Code dentro gli IDE JetBrains, con la stessa UX dell'estensione per Cursor e VS Code.
Serve agli sviluppatori JetBrains che vogliono chat in streaming, schede di tool call e gestione dei permessi senza uscire dall'IDE.
Il suo punto più forte rispetto a Topics è il backend Node.js unico che serve sia il pannello JCEF sia il browser standalone con la stessa UI e lo stesso protocollo WebSocket [README].

## Identità
Repository `Swttch/swttch`, rinominato da `yhk1038/claude-code-gui-jetbrains` per supportare più provider oltre Claude Code [README].
Conta 227 stelle e 31 fork [doc: https://github.com/Swttch/swttch].
La licenza è AGPL-3.0 [README].
L'ultimo commit clonato è `7c33d90` del 2026-10-15 con messaggio di release [codice: backend/package.json:4].
Le release sono frequentissime, le ultime cinque sono v0.34.1, v0.34.2, v0.34.3, v0.34.4 e v0.34.5 tra il 9 e il 14 ottobre 2026 [release v0.34.5].
Il progetto è giovane, creato a gennaio 2026, ma maturo nel ritmo: fix mediamente in un giorno secondo la dichiarazione del team [README].
Piattaforme supportate: IDE JetBrains dalla 2024.2 alla 2025.3, più browser e mobile standalone via Node.js, con macOS, Linux e Windows coperti anche per sleep prevention [README].

## Architettura
Tre strati dichiarati: backend Node.js unico, UI WebView e bridge per ambiente [codice: AGENTS.md:19].
Il backend esegue la CLI agentica, sessioni, impostazioni e file I/O, ed espone un server WebSocket; la WebView comunica sempre con Node.js, mai direttamente con Kotlin [codice: AGENTS.md:52].
I bridge sono solo adattatori: `BrowserBridge` per il browser e `KotlinBridge` per le API native dell'IDE come tab editor e diff viewer [codice: AGENTS.md:55].
Misurato nel clone: TypeScript `.ts` 1.390 file per 178.417 righe, `.tsx` 757 file per 93.571 righe, Kotlin `.kt` 189 file per 28.971 righe, totale repo 3.075 file [non verificato].
Lo storage riusa i file nativi della CLI: sessioni JSONL lette da `readJsonlEntries` e lista progetti sincronizzata con le cartelle di Claude [codice: backend/src/core/features/readJsonlEntries.ts:1].
Niente SQLite proprio, niente Rust o Go: il codice veloce è TypeScript su Node.js più un guscio Kotlin sottile senza logica di business [codice: AGENTS.md:60].
Il dialogo con l'agente avviene spawnando `claude -p` con `--output-format stream-json`, `--input-format stream-json`, `--verbose`, `--include-partial-messages` e `--permission-prompt-tool stdio` [codice: backend/src/core/claude-process.ts:183].
Il server di default sta sulla porta fissa 19836, con override via variabile `PORT` [codice: backend/src/server.ts:55].
La macchina a stati della sessione è Idle, Streaming, Waiting Permission, Has Diff, Error [codice: AGENTS.md:72].

## Sessioni e task
Sessioni multiple parallele con tab, dropdown per cambio rapido e cronologia completa, con ripristino automatico dopo il riavvio dell'IDE via routing di URL di sessione [README].
Un solo processo backend serve più progetti insieme [README].
Non risultano worktree per sessione, code globali, kanban autonoma, tentativi con retry, review con land e merge, PR o CI integrata: il modello è una chat per progetto, non un orchestratore di agenti.
Il recupero di una sessione interrotta è supportato via auto resume [codice: backend/src/core/features/auto-resume.ts:1].
Le issue mostrano cura per i casi limite di sessione, come la sessione fantasma che resta attiva dopo la pulizia [issue #540] e l'output dei subagent mandato per errore nel thread principale [issue #535].

## Usabilità
Superfici: pannello IDE JCEF, browser standalone e mobile via browser, terminal launcher `ccg`, niente TUI e niente app mobile nativa [README].
Flussi principali: streaming Markdown con syntax highlighting e matematica, pensiero visibile in tempo reale, tool call card coerenti con Cursor e VS Code, dialoghi nativi di permesso, allegati via drag and drop, slash command dinamici, interruzione immediata dello streaming [README].
Il contesto editor è il pezzo curato: `Alt+K` invia file e selezione come `@src/file.ts#L10-L25`, con chip cliccabili [README].
Diff e review: card con riepilogo per file, apertura nel diff viewer dell'IDE, apply e reject, con numeri di riga sui diff delle tool call [README] [issue #508].
Notifiche: banner OS nativi su macOS, Linux e Windows con azioni, più suoni di sistema configurabili [codice: backend/src/system-notifications/notifier.ts:121].
Scorciatoie: `Ctrl+Shift+C` apre il pannello, `Cmd+N` o `Ctrl+N` nuova tab, `Alt+K` invio contesto [README].
Onboarding: schermata di benvenuto e diagnostica `ccg doctor` via CLI [codice: cli/commands/doctor.sh:1].
Le issue di usabilità sono fitte e piccole: scroll che salta durante l'output [issue #530], selezione testo instabile [issue #513], scorciatoie Emacs assenti nell'input [issue #506].

## Browser e anteprima
Non ha un browser integrato pilotabile dall'agente e non ha anteprima web integrata nel senso di Topics: la parola browser indica solo che la stessa GUI gira in un browser esterno come client WebSocket [README].
Non c'è co-browse fra dispositivi, niente mirror del DOM, niente tool di pilotaggio della pagina.
Il launcher `ccg` apre la stessa UI nel browser di default su `http://localhost:19836` [README].
Per Topics, che punta su WKWebView nativo e co-browse Mac iPad, qui non c'è nulla da copiare sul browser agente.

## Terminale, editor, file
Niente terminale PTY integrato: offre solo apertura del terminale esterno e comando `Open Claude in Terminal` dal pannello [README].
L'integrazione editor è da plugin JetBrains: invio del file corrente e della selezione, apertura file a riga data, refresh dei file dopo le modifiche dell'agente, diff viewer nativo [codice: backend/src/ws/editor-context-route.ts:1].
I file si allegano via picker o drag and drop, con anteprima e icone per piattaforma [codice: backend/src/core/features/filePreview.ts:1].
Le issue Windows mostrano spawn di `git.exe` senza finestra nascosta con flash di console [issue #539] e problemi di path WSL con cartelle sparite [issue #561].

## Remoto e mobile
Accesso remoto via tunnel Cloudflare: genera un URL esterno con QR code usando `cloudflared`, senza terze parti oltre il proxy Cloudflare, pensato per raggiungere la GUI da dispositivi esterni [README].
Il tunnel è gestito da `tunnel-manager.ts` con binario per utente, download per OS e architettura, file di log e PID in tmp [codice: backend/src/core/features/tunnel-manager.ts:35].
C'è anche pairing con QR dedicato [codice: backend/src/core/handlers/issueTunnelPairing.ts:1].
Sul mobile non esiste client nativo: si usa il browser del telefono verso il backend o il tunnel [README].
Niente cifratura end to end propria: la sicurezza del trasporto remoto è quella del tunnel Cloudflare [non verificato].
La prevenzione dello sleep tiene sveglia la macchina durante i task lunghi su macOS, Linux e Windows [README], con una issue che segnala sovrascrittura dell'impostazione utente su Windows [issue #485].

## Provider e protocolli
Supporta solo la CLI di Claude Code, versione minima 1.0.0, installata e autenticata dall'utente [README].
Niente Codex, Gemini, OpenCode o ACP nel backend e nella WebView: le uniche occorrenze sono rumore in file vendor [non verificato].
Il rename in Swttch dichiara l'intento di supportare più provider in futuro, ma oggi è solo un intento [README].
Il protocollo MCP è gestito come client della CLI: lista server, riconnessione, OAuth, enable e disable, aggiunta via `claude mcp add-json`, rimozione e ricerca nel registry ufficiale [codice: backend/src/core/handlers/mcpActionsHandler.ts:168].
C'è sonda di disponibilità per il modello promozionale Fable via chiamata reale a basso costo [codice: backend/src/core/features/fable-probe.ts:1].
Niente server MCP esposto da Swttch stesso, a differenza di Topics [non verificato].

## Performance
Nessun benchmark dichiarato nel README [README].
L'architettura aiuta: processo singolo per più progetti, streaming con messaggi parziali, rendering Markdown in tempo reale [README].
La parte Kotlin resta sottile per scelta, così il peso sta nel backend Node.js già caldo [codice: AGENTS.md:60].
Le lamentele vere riguardano fluidità e blocchi: scroll incostante dal fondo [issue #537], freeze su arm64 [issue #526], chat bloccata su riconnessione quando il backend muore con un dialog aperto [issue #516], scroll che si resetta durante l'output [issue #530].
Nessun uso di Rust per la velocità: non c'è codice Rust nel repo [non verificato].

## Affidabilità e qualità
Test misurati nel clone: 887 file di test, di cui 268 nel backend, 525 nella WebView, 81 in Kotlin e 13 nella CLI [non verificato].
Il principio dichiarato è TDD rosso verde refactor con test sul comportamento osservabile e regressione per ogni bug [codice: AGENTS.md:27].
La persistenza riusa le sessioni della CLI con ripristino automatico e retry delle migrazioni [codice: backend/src/core/features/migration-retry.ts:1].
Il backend spazza i processi CLI orfani e i container MCP rimasti appesi all'avvio [codice: backend/src/server.ts:299].
Gli aggiornamenti coprono plugin, CLI con auto update e backend, con una issue che nota la CLI mai aggiornata via plugin in passato [issue #499].
Il troubleshooting documenta problemi noti fuori dal loro controllo: clipboard su Wayland, pannello vuoto su Linux, JCEF su Android Studio, colori della review su IDE vecchi [README].

## Sicurezza e privacy
Usa le credenziali dell'utente via CLI già autenticata, non gestisce token propri: il requisito è `claude` installato e autenticato [README].
I permessi passano per `--permission-prompt-tool stdio` con dialoghi nativi e policy configurabile [codice: backend/src/core/claude-process.ts:191].
Il kit di dettatura vocale è volutamente fuori processo: il backend risolve solo il percorso dell'eseguibile e parla via stdin e stdout per non maneggiare credenziali nel processo del plugin [codice: backend/src/core/extend-kit.ts:14].
Telemetria opt in su istanza Rybbit self hosted, solo a consenso accettato, fire and forget, con chiave iniettata a build time e mai committata [codice: backend/src/core/features/telemetry.ts:14].
Porte esposte: localhost 19836 di default, più URL pubblico solo quando l'utente attiva il tunnel cloudflared [codice: backend/src/server.ts:55].
Sandbox dei comandi non documentata oltre i permessi della CLI [non verificato].

## Estendibilità
MCP con GUI completa: gestione server, OAuth, enable, aggiunta da registry e ispezione dei tool esposti [codice: backend/src/shared/mcp.ts:8].
Slash command caricati dinamicamente dalla CLI, con `/clear` e `/compact` di base [README].
Impostazioni bidirezionali: la GUI modifica sia le proprie sia quelle originali di Claude Code, globali e locali, con gestione di skill, agenti e MCP pianificata [README].
Account multipli con pool e recupero, più sponsor key per funzioni a pagamento [codice: backend/src/core/features/account-manager.ts:1].
Niente plugin API pubblica né hook documentati per terze parti: l'estensione passa dalla CLI e dai file `.claude` [non verificato].

## Da prendere per Topics
1. Backend unico che serve IDE e browser con lo stesso protocollo: un solo backend e due client intercambiabili riducono il codice doppio.
   Si vede in [codice: AGENTS.md:44].
   Per Topics conterebbe perché oggi guscio, server e client mobile rischiano tre logiche diverse.
2. Invio contesto editor con una scorciatoia: `Alt+K` con `@file#L10-L25` e chip rimovibile è veloce e visibile.
   Si vede in [README].
   Per Topics conterebbe perché allegare file e selezione è il gesto più frequente in chat.
3. Sincronizzazione bidirezionale delle impostazioni con la CLI: modificare i settings originali dalla GUI evita derive tra file e pannello.
   Si vede in [README].
   Per Topics conterebbe perché anche noi avvolgiamo `claude -p` e i suoi settings.
4. Gestione MCP con GUI completa sopra i comandi CLI: lista, OAuth, enable, aggiunta da registry e ispezione tool in un posto solo.
   Si vede in [codice: backend/src/core/handlers/mcpActionsHandler.ts:168].
   Per Topics conterebbe perché il nostro server MCP merita un pannello di pari livello.
5. Sweep dei processi orfani e dei container all'avvio: uccide le CLI rimaste e rimuove i container MCP appesi.
   Si vede in [codice: backend/src/server.ts:299].
   Per Topics conterebbe perché i lanci da kanban lasciano gli stessi resti.
6. Tunnel con QR per accesso da telefono: cloudflared gratuito e illimitato come opzione esplicita.
   Si vede in [README].
   Per Topics conterebbe come alternativa al solo LAN, con consenso esplicito.
7. Sleep prevention per task lunghi: caffeinate, systemd-inhibit e API Windows dietro un interruttore.
   Si vede in [README].
   Per Topics conterebbe perché i task in background muoiono con lo sleep.
8. Principio di conservazione dei dati originali della CLI fino alla UI: niente rename né filtri nei livelli intermedi.
   Si vede in [codice: AGENTS.md:66].
   Per Topics conterebbe perché preserva i campi JSONL per usi futuri.

## Da evitare
1. Plugin che aggira le credenziali caricando codice che le legge nel proprio processo: loro lo vietano e tengono il kit vocale fuori processo [codice: backend/src/core/extend-kit.ts:14].
   Rischio legale e di fiducia da non replicare.
2. Sleep guard che sovrascrive la scelta dell'utente: impostare valori fissi al posto di Never sleep ha generato una issue [issue #485].
   Meglio ripristinare sempre il valore precedente.
3. Spawn di processi con finestra visibile su Windows: `git.exe` lanciato senza nascondere la console fa lampeggiare finestre [issue #539].
   Ogni spawn deve nascondere la finestra.
4. Path WSL trattati come path normali: cartelle sparite e file illeggibili quando cambia il mapping [issue #561].
   Serve risoluzione esplicita dei path WSL.
5. Scroll che ruba la posizione durante lo streaming: tre issue diverse su reset e salti dello scroll [issue #530].
   La regola è non muovere mai la vista se l'utente ha scrollato su.
6. Licenza AGPL per codice da riusare dentro Topics: il repo è AGPL-3.0 [README].
   Si può studiare e descrivere, non copiare oltre le citazioni brevi.

## Fonti
- https://github.com/Swttch/swttch/blob/7c33d907a3ca983eb9e506c30761d40f69b6860f/AGENTS.md
- https://github.com/Swttch/swttch/blob/7c33d907a3ca983eb9e506c30761d40f69b6860f/README.md
- https://github.com/Swttch/swttch/blob/7c33d907a3ca983eb9e506c30761d40f69b6860f/backend/package.json
- https://github.com/Swttch/swttch/blob/7c33d907a3ca983eb9e506c30761d40f69b6860f/backend/src/core/claude-process.ts#L183
- https://github.com/Swttch/swttch/blob/7c33d907a3ca983eb9e506c30761d40f69b6860f/backend/src/server.ts#L55
- https://github.com/Swttch/swttch/blob/7c33d907a3ca983eb9e506c30761d40f69b6860f/backend/src/core/features/tunnel-manager.ts#L35
- https://github.com/Swttch/swttch/blob/7c33d907a3ca983eb9e506c30761d40f69b6860f/backend/src/core/features/telemetry.ts#L14
- https://github.com/Swttch/swttch/blob/7c33d907a3ca983eb9e506c30761d40f69b6860f/backend/src/core/extend-kit.ts#L14
- https://github.com/Swttch/swttch/blob/7c33d907a3ca983eb9e506c30761d40f69b6860f/backend/src/core/handlers/mcpActionsHandler.ts#L168
- https://github.com/Swttch/swttch/blob/7c33d907a3ca983eb9e506c30761d40f69b6860f/backend/src/shared/mcp.ts#L8
- [doc: https://plugins.jetbrains.com/plugin/30313-claude-code-with-gui]
- [doc: https://github.com/Swttch/swttch/blob/main/cli/README.md]
- [doc: https://github.com/Swttch/swttch/blob/main/docs/troubleshooting/en/README.md]
