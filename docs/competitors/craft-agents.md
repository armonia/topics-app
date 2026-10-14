# Craft Agents

## In tre righe

- Craft Agents è un'app desktop Electron con server Bun che fa da guscio multi provider per sessioni agentiche parallele, orientata ai documenti più che al codice [README].
- Il suo punto più forte rispetto a Topics è il doppio backend agente (Claude Agent SDK più Pi SDK per Codex, Copilot e Gemini) con automazioni event driven e cron integrate [codice: packages/shared/src/agent/backend/factory.ts:5].
- Eccelle anche nel modello thin client: stessa UI in locale o da remoto sopra un server headless con token e TLS [README].

## Identità

- Repository `craft-ai-agents/craft-agents-oss`, nato a gennaio 2026 come gemma open di un prodotto commerciale per documenti collaborativi [README].
- Conta circa 7.256 stelle e circa 1.087 fork, trazione alta per un progetto di nove mesi [doc: https://github.com/craft-ai-agents/craft-agents-oss].
- Licenza Apache 2.0, dichiarata nel manifest e nel README [codice: package.json:4] [README].
- Marchi "Craft" e "Craft Agents" restano di proprietà dell'azienda, con linee guida d'uso dedicate [README].
- Ultimo commit e release v0.15.1 il 13 ottobre 2026 [release v0.15.1].
- Cadenza quasi settimanale: v0.15.0 l'11 ottobre, v0.14.1 il 6 ottobre, v0.14.0 il 30 settembre [release v0.15.0].
- Maturità medio alta: monorepo grande e curato, ma con issue aperte su bug strutturali di permessi, MCP e compattazione [issue #1052] [issue #1079].
- Piattaforme: desktop Electron su macOS, Windows e Linux, più server headless su VPS Linux con Docker [README].
- Installazione con script a una riga per macOS, Linux e Windows, oppure build da sorgente con Bun [README].

## Architettura

- Monorepo Bun con workspace `packages/*` e `apps/*`: `core` per i tipi, `shared` per la logica, `server-core` per sessioni e RPC, `server` come entry headless [codice: package.json:28].
- App: `electron` (GUI primaria), `cli` (client terminale), `webui` (client browser completo), `viewer` (sole trascrizioni condivise) [README].
- Pacchetti agente: `pi-agent-server` (backend Pi fuori processo), `session-mcp-server` (tool verso Codex), `session-tools-core` (definizioni dei tool di sessione) [codice: packages/session-mcp-server/package.json:5].
- Misurato nel clone: 1.383 file `.ts` e 474 `.tsx` per circa 398.000 righe TypeScript su 452.000 totali [non verificato].
- Zero file Rust o Go: tutta la velocità è affidata a Bun, non a moduli nativi di sistema [non verificato].
- UI React con shadcn e Tailwind v4, build con esbuild per il main process e Vite per il renderer [README].
- Processo Electron classico: main, preload con context bridge, renderer [README].
- Server RPC WebSocket scorporabile: in thin client la UI gira in locale e tutta la logica resta sul server [codice: packages/server-core/src/transport/client.ts:101].
- Storage senza database: JSON su disco in `~/.craft-agent/` per config, preferenze e temi, sessioni in JSONL con coda di persistenza [codice: packages/shared/src/sessions/jsonl.ts:2] [README].
- Ogni workspace ha cartella propria con config, tema, automazioni, sessioni, sorgenti, skill e stati [README].
- Con l'agente parla in due modi: ClaudeAgent usa `query()` del Claude Agent SDK 0.3.296 in process, PiAgent è un client verso un subprocess Pi in JSONL su stdio [codice: package.json:147] [codice: packages/shared/src/agent/backend/factory.ts:5].
- Niente ACP in tutto il repo, e `stream-json` è solo un formato di output della CLI, non il trasporto agente [codice: apps/cli/src/index.ts:410].

## Sessioni e task

- Sessioni parallele native con delega fire and forget tramite `spawn_session`, con prompt, nome, connessione LLM, modello, permessi, directory ed etichette [codice: packages/session-tools-core/src/tool-defs.ts:226].
- Isolamento per directory di lavoro, senza worktree automatiche né code con tentativi: l'unica occorrenza di worktree nel codice è un commento [codice: packages/server-core/src/runtime/inherited-app-env.ts:7].
- Branching conversazionale, non git: strategia `sdk-fork` oppure `seeded-fresh-session` con validazione di workspace, sessione e messaggio [codice: packages/server-core/src/sessions/SessionManager.ts:901].
- Stato di avanzamento come workflow dinamico per workspace: Todo, In Progress, Needs Review, Done, con inbox, archivio e flag [README].
- Il tool `set_session_status` rifiuta gli stati chiusi e scatena automazioni sul cambio di stato [codice: packages/session-tools-core/src/tool-defs.ts:250].
- Automazioni in `automations.json` con trigger su eventi: cambi di etichetta, stato, permessi, flag, avvio e fine sessione, uso dei tool [README].
- `SchedulerTick` con espressioni cron a 5 campi crea sessioni con prompt, menzioni e variabili d'ambiente espanse [codice: packages/shared/src/automations/types.ts:22].
- Azioni di automazione di tre tipi: prompt verso nuova sessione, webhook e script [codice: packages/shared/src/automations/types.ts:134].
- Task lunghi come background task con registro nel main process: running, completed, failed, stopped, orphaned, più hook UI dedicato [codice: packages/session-tools-core/src/tool-defs.ts:683].
- Review senza attrezzi dedicati: `submit_plan` fa approvare un piano all'utente, poi lo stato `needs-review` segnala il lavoro pronto [codice: packages/session-tools-core/src/handlers/submit-plan.ts:4].
- Merge e PR solo via `gh` invocato in Bash, elencato fra i comandi permessi dalla documentazione dei permessi [non verificato].
- Titoli di sessione generati dall'IA oppure manuali, con nomi brevi generati da liste di parole [README].

## Usabilità

- Superfici: app Electron primaria, WebUI completa da browser, CLI per scripting e CI, viewer di sola lettura per link condivisi [README].
- Condivisione di sessioni via link pubblici sul dominio del prodotto, con bundle isolato da hook e MCP dell'utente [codice: packages/shared/src/pages/share-bundle.ts:16].
- Allegati con drag and drop e conversione automatica di immagini, PDF e documenti Office [README].
- Temi a cascata con override per singolo workspace [README].
- Diff multi file in stile VS Code con viewer Shiki unificato o affiancato, aperto per tutti gli edit di un turno [codice: packages/ui/src/context/PlatformContext.tsx:61].
- Scorciatoie: `Cmd+N` nuova chat, `Cmd+1/2/3` per le zone, `SHIFT+TAB` per ciclare i permessi, `Cmd+/` per il dialogo delle scorciatoie [README].
- Tre modalità visibili in UI (Explore, Ask to Edit, Auto) mappate su quattro livelli interni con l'aggiunta di Guarded [README].
- Notifiche native con badge di conteggio e icona del dock aggiornata [codice: apps/electron/src/main/notifications.ts:54].
- Deep link `craftagents://` per viste, sessioni, impostazioni, sorgenti e nuova chat [codice: apps/electron/src/main/deep-link.ts:4].
- Onboarding fragile: esiste una issue su maschera di onboarding grigia che blocca la UI [issue #1044].
- Etichette Task create in automatico giudicate ridondanti e difficili da rimuovere, con ID di sessione non visibile [issue #1078].

## Browser e anteprima

- Browser integrato vero su `BrowserView` di Electron, con viste per toolbar, pagina e overlay nativo [codice: apps/electron/src/main/browser-pane-manager.ts:12].
- Pilotaggio via CDP: la classe `BrowserCDP` fa snapshot di accessibilità, click, compilazione e input fidato senza richiedere il focus [codice: apps/electron/src/main/browser-cdp.ts:386].
- L'agente usa un unico tool `browser_tool` con circa venti comandi: open, navigate, snapshot, find, click, fill, type, select, upload, screenshot, console, network, wait, key, scroll, back, forward, evaluate [codice: packages/shared/src/agent/browser-tool-runtime.ts:54].
- Supporto a comandi in batch con separatore e a finestre multiple con rilascio esplicito [codice: packages/shared/src/agent/browser-tool-runtime.ts:54].
- Contratto di 40 metodi fra sessioni e browser: navigazione, snapshot, interazioni, screenshot, console, rete, attesa, download [codice: packages/server-core/src/handlers/browser-pane-manager-interface.ts:239].
- L'utente può aggiungere pannelli browser manuali con striscia di tab [codice: apps/electron/src/renderer/components/browser/BrowserTabStrip.tsx:24].
- Sessioni su server remoto guidano il browser locale via capacità sul canale WebSocket, con `evaluate` sotto permesso e `uploadFile` bloccato sul bridge [codice: packages/server-core/src/handlers/browser-pane-manager-interface.ts:239].
- Niente co-browse fra dispositivi: nessun riscontro nel codice, è un ponte agente remoto verso browser locale per singolo utente [non verificato].
- Limiti noti: sessioni diverse riusano la stessa finestra del browser [issue #1070].
- I popup chiusi rompono il tool del browser integrato [issue #1059].
- Le SPA pesanti in JavaScript hanno problemi di rendering nell'anteprima [issue #807].

## Terminale, editor, file

- Nessun terminale interattivo: niente node-pty né xterm.js, l'unico riferimento a xterm è la variabile `TERM` per la login shell [codice: apps/electron/src/main/shell-env.ts:55].
- Il componente `TerminalOutput` mostra solo l'output dei comandi già eseguiti, non una shell [codice: packages/ui/src/components/terminal/index.ts:2].
- I parser dei tool Bash, Grep e Glob aprono overlay di sola lettura sui risultati [non verificato].
- L'agente esegue comandi tramite i tool dell'SDK, con i processi lunghi segnalati come evento `shell_backgrounded` [codice: packages/core/src/types/message.ts:598].
- Nessun editor integrato: niente Monaco né CodeMirror, solo il visualizzatore di diff Shiki [non verificato].
- File collegati come origini esterne: filesystem, vault Obsidian, repo git, più oltre 32 tool per documenti Craft [README].
- Smoke test Python per gli strumenti documento: PDF, XLSX, DOCX, PPTX, immagini, iCal e diff [codice: apps/electron/resources/scripts/tests/test_pdf_tool_smoke.py:1].

## Remoto e mobile

- Server headless avviato con token generato, stampa URL e token da copiare nell'app desktop [codice: packages/server/src/index.ts:9] [README].
- Stessa porta 9100 per RPC WebSocket e WebUI, con password breve opzionale e cookie di sessione [codice: packages/server/src/index.ts:21].
- TLS via certificato e chiave su file, con script per certificati di sviluppo e reverse proxy consigliato in produzione [README].
- In thin client l'app salta la gestione locale delle credenziali: il vault resta sul server [codice: apps/electron/src/main/index.ts:1065].
- Immagine Docker con volume per i dati e montaggio opzionale dei certificati in sola lettura [README].
- CLI come client WebSocket minimo con handshake a token, senza riconnessione né capacità negoziate [codice: apps/cli/src/client.ts:72].
- La CLI legge URL e token da env o flag, con supporto a CA custom per certificati autofirmati [README].
- Comando `run` autonomo: genera un server, crea la sessione, invia il prompt, trasmette la risposta ed esce [README].
- Comando di validazione a 21 passi che genera un server da solo se non gliene dai uno [README].
- Telefono via browser: WebUI adattiva con rilevamento touch e layout compatto sotto i 768 px, rifinita in più release [codice: apps/webui/src/responsive.ts:1].
- Frizioni mobili: toolbar del composer che esce dal viewport con testo grande [issue #1038].
- Annotazioni che non compaiono su browser touch per gestori di eventi mancanti [issue #847].
- Richiesta aperta di abilitare la WebUI da Electron in modalità server per l'accesso remoto da browser [issue #745].

## Provider e protocolli

- Due soli backend nella factory: ClaudeAgent su Anthropic e PiAgent su Pi, ogni altro provider è un profilo di autenticazione Pi [codice: packages/shared/src/agent/backend/factory.ts:63].
- Claude gestisce Anthropic diretta (API key oppure OAuth Claude Max e Pro) e qualunque endpoint compatibile con base URL personalizzata [README].
- Pi gestisce Google AI Studio, ChatGPT Plus via OAuth Codex, GitHub Copilot via OAuth, chiave OpenAI e altri del catalogo Pi [README].
- Migrazione automatica dalle vecchie connessioni Codex e Copilot ai nuovi profili Pi [codice: packages/shared/src/config/storage.ts:1654].
- Terze parti via endpoint compatibile: OpenRouter, Vercel AI Gateway, Ollama in locale, proxy custom [README].
- MCP via SDK ufficiale con trasporti HTTP streamable e stdio, validazione con connessione reale prima di salvare [codice: packages/shared/src/mcp/client.ts:24].
- Connessione dell'agente alle sorgenti con `@` anche a metà conversazione, senza riavvio [README].
- Importazione di skill e MCP da Claude Code guidata dall'agente in conversazione [README].
- Dolori noti: sessioni Anthropic dirette rotte da uno schema tool senza `additionalProperties: false` [issue #1096].
- Provider OpenAI compatibili che falliscono con errori di streaming senza motivo di fine [issue #1089].
- Rate limit con reset ignorato e sessioni inchiodate alla connessione fallita [issue #1046].
- Finestra di contesto a 1 milione gestita solo a livello di registro, non quella reale [issue #1073].
- Sottoinsieme di sorgenti MCP registrate in silenzio sul backend Claude, con lista dei falliti scartata [issue #1071].

## Performance

- Stack veloce per scelta: Bun come runtime, esbuild per il main, Vite per il renderer, ripgrep impacchettato per le ricerche [README].
- Risposte oltre circa 60 KB riassunte con modello leggero e intento preservato dal campo `_intent` negli schemi MCP [README].
- Sessioni con caricamento pigro e metadati freddi per aprire in fretta elenchi lunghi [codice: packages/server-core/src/sessions/SessionManager.ts:668].
- Nessun benchmark dichiarato nel repo [non verificato].
- Compattazione Pi che si blocca dopo il risultato di un tool, con timeout manuale a 300 secondi [issue #1060].
- Reasoning che divora il budget di output e lascia risposte vuote con sessione apparentemente muta [issue #1072].
- Pool di subprocess MCP orfani a ogni retry di autenticazione, senza recupero via TTL di inattività [issue #1079].
- Turni vuoti su errori di entitlement invece di un messaggio utile [issue #1046].
- Messaggi consecutivi recapitati uno per turno, così l'agente risponde solo all'ultimo [issue #1040].

## Affidabilità e qualità

- Rete di test ampia: 521 file fra `*.test.ts`, `*.tsx` e `*.isolated.ts`, più 9 smoke test Python [non verificato].
- Test dedicati a persistenza delle sessioni, parità dei messaggi, branching, watcher e cleanup dei branch [non verificato].
- CI con workflow di validazione su Bun 1.3.10, typecheck su tutti i pacchetti e lint su invii IPC e nomi dei tool [codice: .github/workflows/validate.yml:1].
- Controllo di parità e copertura delle stringhe i18n con ordinamento dei locale verificato in CI [non verificato].
- Persistenza sessioni su JSONL con coda di scrittura e test di durabilità dell'invio messaggi [codice: packages/shared/src/sessions/persistence-queue.ts:1].
- Aggiornamenti frequenti ma con regressioni: un upgrade minore ha rotto le chiamate MCP con errore di validazione `_intent` [issue #1086].
- Uno schema zod spedito nel pacchetto sbagliato ha svuotato gli schemi dei tool a runtime [issue #1082].
- Recupero parziale: richieste di permesso in sospeso che non emergono mai e lasciano la sessione bloccata [issue #1052].
- Messaggi inviati durante la compattazione ignorati senza accodamento [issue #1058].
- Percorsi assoluti persistiti con un punto spurio inserito nei record dei tool [issue #1056].

## Sicurezza e privacy

- Credenziali in file cifrato AES-256-GCM con chiave derivata dall'identificativo hardware via PBKDF2 a 100.000 iterazioni [codice: packages/shared/src/credentials/backends/secure-storage.ts:73].
- Directory con permessi 0700 e file credenziali con permessi 0600 [codice: packages/shared/src/credentials/backends/secure-storage.ts:301].
- Quattro modalità di permesso in ordine crescente: `safe`, `ask`, `guarded`, `allow-all`, con nomi UI Explore, Ask, Guarded ed Execute [codice: packages/shared/src/agent/mode-types.ts:31].
- Configurazione di fallback che blocca ogni scrittura in modalità sicura [non verificato].
- Regole di permesso additive per workspace e per sorgente [non verificato].
- Variabili d'ambiente sensibili filtrate prima di generare i subprocess MCP locali, con lista duplicata in due punti [codice: packages/shared/src/mcp/client.ts:52].
- Uso lecito delle credenziali Claude: API key oppure OAuth Max e Pro dell'utente, senza forzature sui controlli gestiti [issue #1077].
- Rete prudente: una sola porta esposta, bind di default su localhost, rifiuto del bind insicuro senza flag esplicito, token obbligatorio [codice: packages/server/src/index.ts:322].
- Telemetria solo come crash report via Sentry, attivo se l'URL di ingest è configurato, con redazione di header e breadcrumb [codice: apps/electron/src/main/index.ts:21].
- Condivisione con sandbox CSP e iframe per i bundle pubblicati, senza sandbox per l'esecuzione Bash dell'agente [codice: packages/shared/src/pages/share-bundle.ts:16].
- Nota di perimetro: `allowedWritePaths` risulta ignorato in modalità Ask, il che spinge le automazioni verso Allow All [issue #1065].
- Directory di config onorata solo in parte: workspaces, sessioni, credenziali e log restano sotto la home [issue #1062].

## Estendibilità

- Sorgenti in tipi chiusi `mcp`, `api` e `local`, ognuna come cartella con `config.json` e guida [codice: packages/shared/src/sources/types.ts:16].
- MCP remoti o stdio, REST di Google, Slack e Microsoft, filesystem e vault [README].
- Skill in cartelle per workspace più directory globale `~/.agents/skills` e di progetto `.agents/skills` [codice: packages/shared/src/skills/storage.ts:32].
- L'agente crea skill e sorgenti da conversazione e le applica senza riavvio [README].
- Automazioni con azioni webhook e script oltre ai prompt verso nuove sessioni [codice: packages/shared/src/automations/types.ts:134].
- Ponte verso l'esterno: `session-mcp-server` espone gli strumenti di sessione a Codex via stdio [codice: packages/session-mcp-server/package.json:5].
- Manca l'importazione automatica da Claude Code: nessun importatore da `.claude.json` trovato, solo MCP standard [non verificato].
- Proposta aperta di ricerca web nativa per le sessioni Pi via MCP parallelo opzionale [issue #1084].

## Da prendere per Topics

1. Automazioni event driven con cron: trigger su etichette, stati e tool più `SchedulerTick` che crea sessioni con prompt e menzioni, perfetto per la kanban che lancia agenti da sola [codice: packages/shared/src/automations/types.ts:22].
2. Doppio backend con fallback di provider: Anthropic diretto più Pi per Codex, Copilot e Gemini dietro un'unica factory, così Topics regge quando un provider cade [codice: packages/shared/src/agent/backend/factory.ts:63].
3. Riassunto automatico delle risposte oltre soglia con modello leggero e campo di intento: contiene i costi senza troncare il contesto utile [README].
4. Thin client con singola porta per RPC e WebUI, token obbligatorio e TLS via file: il modello LAN di Topics con cifratura vera invece del solo HTTP locale [codice: packages/server/src/index.ts:119].
5. Filtro delle variabili sensibili prima di generare subprocess MCP, con lista esplicita: misura semplice contro la fuoriuscita di token [codice: packages/shared/src/mcp/client.ts:52].
6. Permessi a quattro livelli con ciclo da tastiera e fallback di sola lettura: granularità in più senza complicare la UI [codice: packages/shared/src/agent/mode-types.ts:31].
7. Diff multi file per turno con viewer unificato o affiancato: la review di Topics guadagna il colpo d'occhio su tutti gli edit insieme [codice: packages/ui/src/context/PlatformContext.tsx:61].
8. Server MCP che espone gli strumenti interni via stdio: Topics potrebbe offrire tool di topic e kanban a Codex e Claude Code esterni [codice: packages/session-mcp-server/package.json:5].
9. Deep link con schema proprio per sessioni e azioni: utile per passare da telefono a topic preciso in LAN [codice: apps/electron/src/main/deep-link.ts:4].

## Da evitare

1. Unico `browser_tool` monolitico da venti comandi: comodo ma fragile, le issue su popup e finestre condivise mostrano che la granularità per finestra va disegnata prima [issue #1059] [issue #1070].
2. Pool di subprocess MCP senza TTL di recupero: a ogni retry i processi orfani restano, Topics deve dare a ogni pool un proprietario e una scadenza [issue #1079].
3. Soglie solo nominali (contesto a 1 milione a registro, reset del rate limit ignorato): ogni limite dichiarato deve guidare il comportamento reale [issue #1073] [issue #1046].
4. Schemi zod spediti nel pacchetto sbagliato che svuotano i tool a runtime: serve un test di integrazione sullo schema distribuito, il typecheck non basta [issue #1082].
5. Approvazioni che non emergono mai in UI con sessione bloccata: ogni richiesta di permesso vuole timeout e superficie visibile [issue #1052].
6. Path persistenti con punti spuri e config onorata solo in parte: i percorsi su disco vanno coperti da test di round trip [issue #1056] [issue #1062].

## Fonti

- [README](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/README.md)
- [release v0.15.1](https://github.com/craft-ai-agents/craft-agents-oss/releases/tag/v0.15.1)
- [release v0.15.0](https://github.com/craft-ai-agents/craft-agents-oss/releases/tag/v0.15.0)
- [doc: https://github.com/craft-ai-agents/craft-agents-oss](https://github.com/craft-ai-agents/craft-agents-oss)
- [codice: package.json:4](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/package.json#L4)
- [codice: package.json:147](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/package.json#L147)
- [codice: packages/shared/src/agent/backend/factory.ts:5](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/agent/backend/factory.ts#L5)
- [codice: packages/shared/src/agent/backend/factory.ts:63](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/agent/backend/factory.ts#L63)
- [codice: packages/shared/src/sessions/jsonl.ts:2](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/sessions/jsonl.ts#L2)
- [codice: packages/shared/src/sessions/persistence-queue.ts:1](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/sessions/persistence-queue.ts#L1)
- [codice: packages/shared/src/credentials/backends/secure-storage.ts:73](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/credentials/backends/secure-storage.ts#L73)
- [codice: packages/shared/src/credentials/backends/secure-storage.ts:301](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/credentials/backends/secure-storage.ts#L301)
- [codice: packages/shared/src/agent/mode-types.ts:31](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/agent/mode-types.ts#L31)
- [codice: packages/shared/src/mcp/client.ts:52](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/mcp/client.ts#L52)
- [codice: packages/shared/src/mcp/client.ts:24](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/mcp/client.ts#L24)
- [codice: packages/shared/src/agent/browser-tool-runtime.ts:54](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/agent/browser-tool-runtime.ts#L54)
- [codice: packages/server-core/src/handlers/browser-pane-manager-interface.ts:239](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/server-core/src/handlers/browser-pane-manager-interface.ts#L239)
- [codice: packages/session-tools-core/src/tool-defs.ts:226](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/session-tools-core/src/tool-defs.ts#L226)
- [codice: packages/server-core/src/sessions/SessionManager.ts:901](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/server-core/src/sessions/SessionManager.ts#L901)
- [codice: packages/server-core/src/sessions/SessionManager.ts:668](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/server-core/src/sessions/SessionManager.ts#L668)
- [codice: packages/shared/src/automations/types.ts:22](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/automations/types.ts#L22)
- [codice: packages/shared/src/automations/types.ts:134](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/automations/types.ts#L134)
- [codice: packages/server/src/index.ts:119](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/server/src/index.ts#L119)
- [codice: packages/server/src/index.ts:322](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/server/src/index.ts#L322)
- [codice: packages/session-mcp-server/package.json:5](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/session-mcp-server/package.json#L5)
- [codice: packages/shared/src/sources/types.ts:16](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/sources/types.ts#L16)
- [codice: packages/shared/src/skills/storage.ts:32](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/shared/src/skills/storage.ts#L32)
- [codice: apps/electron/src/main/deep-link.ts:4](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/apps/electron/src/main/deep-link.ts#L4)
- [codice: apps/electron/src/main/notifications.ts:54](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/apps/electron/src/main/notifications.ts#L54)
- [codice: apps/cli/src/client.ts:72](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/apps/cli/src/client.ts#L72)
- [issue #745](https://github.com/craft-ai-agents/craft-agents-oss/issues/745), [issue #807](https://github.com/craft-ai-agents/craft-agents-oss/issues/807), [issue #847](https://github.com/craft-ai-agents/craft-agents-oss/issues/847), [issue #1038](https://github.com/craft-ai-agents/craft-agents-oss/issues/1038), [issue #1040](https://github.com/craft-ai-agents/craft-agents-oss/issues/1040), [issue #1044](https://github.com/craft-ai-agents/craft-agents-oss/issues/1044), [issue #1046](https://github.com/craft-ai-agents/craft-agents-oss/issues/1046), [issue #1052](https://github.com/craft-ai-agents/craft-agents-oss/issues/1052), [issue #1056](https://github.com/craft-ai-agents/craft-agents-oss/issues/1056), [issue #1058](https://github.com/craft-ai-agents/craft-agents-oss/issues/1058), [issue #1059](https://github.com/craft-ai-agents/craft-agents-oss/issues/1059), [issue #1060](https://github.com/craft-ai-agents/craft-agents-oss/issues/1060), [issue #1062](https://github.com/craft-ai-agents/craft-agents-oss/issues/1062), [issue #1065](https://github.com/craft-ai-agents/craft-agents-oss/issues/1065), [issue #1070](https://github.com/craft-ai-agents/craft-agents-oss/issues/1070), [issue #1071](https://github.com/craft-ai-agents/craft-agents-oss/issues/1071), [issue #1072](https://github.com/craft-ai-agents/craft-agents-oss/issues/1072), [issue #1073](https://github.com/craft-ai-agents/craft-agents-oss/issues/1073), [issue #1077](https://github.com/craft-ai-agents/craft-agents-oss/issues/1077), [issue #1078](https://github.com/craft-ai-agents/craft-agents-oss/issues/1078), [issue #1079](https://github.com/craft-ai-agents/craft-agents-oss/issues/1079), [issue #1082](https://github.com/craft-ai-agents/craft-agents-oss/issues/1082), [issue #1084](https://github.com/craft-ai-agents/craft-agents-oss/issues/1084), [issue #1086](https://github.com/craft-ai-agents/craft-agents-oss/issues/1086), [issue #1089](https://github.com/craft-ai-agents/craft-agents-oss/issues/1089), [issue #1096](https://github.com/craft-ai-agents/craft-agents-oss/issues/1096)
