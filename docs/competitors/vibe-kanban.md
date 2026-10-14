# Vibe Kanban

## In tre righe

Vibe Kanban è un kanban per orchestrare agenti di coding in workspace paralleli,
ognuno con branch, terminale e dev server propri.
Punta su chi pianifica e revisiona il lavoro degli agenti più che sul generare codice.
Fra i concorrenti è il più vicino alla board di Topics,
con diff inline, preview integrata e supporto a oltre dieci agenti [README].

## Identità

Repository `BloopAI/vibe-kanban`, nato a giugno 2025,
con circa 28 mila stelle e tremila fork al momento dello studio [non verificato].
Licenza Apache-2.0 [README].
Ultimo commit verificato il 19 settembre 2026 (`fix: Tanstack router api fix`) [codice: HEAD d5cbb53].
Ultima release stabile v0.1.44 del 24 aprile 2026,
con una 0.1.45 già presente nel manifest [release v0.1.44].
Oltre 540 issue aperte, segno di comunità attiva ma anche di arretrato [non verificato].
Progetto in transizione: la società che lo sviluppava ha annunciato la chiusura
ad aprile 2026 e il passaggio a modello community maintained [doc: https://www.vibekanban.com/blog/shutdown].
Piattaforme: distribuzione via `npx vibe-kanban`, binari desktop tramite Tauri,
Docker per self hosting [README].

## Architettura

Backend in Rust e frontend in TypeScript, quasi pari peso:
circa 109 mila righe di Rust su 443 file e circa 110 mila righe di TS e TSX
su quasi 700 file, misurate con `git ls-files` più `wc -l` [codice: Cargo.toml:1].
Il workspace Cargo conta 31 crate più un crate remoto separato,
segnale di separazione netta fra esecuzione locale e accesso remoto [codice: Cargo.toml:3].
Il server HTTP usa Axum 0.8 con Tokio come runtime asincrono [codice: Cargo.toml:20].
Lo storage è SQLite via sqlx con oltre cento migrazioni versionate [codice: crates/db/Cargo.toml:14].
Il frontend è React con TanStack Router,
diviso in pacchetti `local-web`, `remote-web`, `web-core` e `ui` [codice: package.json:1].
Esiste un guscio desktop Tauri 2 con plugin shell [codice: crates/tauri-app/Cargo.toml:14].
Rust è usato per tutto il backend operativo: esecuzione agenti, git, worktree,
proxy di preview, relay e tunnel, mentre il rendering resta web.
Con l'agente parla lanciando le CLI ufficiali come processi figli
(`tokio::process::Command` con spawn isolato senza finestra)
e dialogando su stdin e stdout con un protocol peer dedicato
e token di cancellazione [codice: crates/executors/src/executors/claude.rs:620].
I tipi condivisi fra Rust e TypeScript sono generati con `ts-rs`,
quindi il contratto API è derivato dal codice, non scritto a mano [codice: Cargo.toml:35].
La comunicazione realtime verso il frontend passa da WebSocket firmati
e da un bridge dedicato [codice: crates/ws-bridge/src/lib.rs:1].

## Sessioni e task

Il flusso è: issue sulla board kanban, poi workspace dove l'agente esegue,
poi revisione e merge [README].
Ogni workspace crea branch e worktree dedicati tramite un crate apposito
che sincronizza la creazione per evitare race condition [codice: crates/worktree-manager/src/worktree_manager.rs:59].
Il server espone route per git con stato dei merge, file in conflitto
e rebase in corso [codice: crates/server/src/routes/workspaces/git.rs:53].
Le PR si aprono dall'UI con descrizioni generate dall'agente
e si revisionano su GitHub [README].
I messaggi inviati mentre l'agente lavora non lo interrompono:
finiscono in una coda di follow up con stato dedicato [codice: crates/server/src/routes/sessions/queue.rs:15].
C'è un servizio di approvazioni che chiede conferma prima di azioni sensibili
e registra domande e risposte [codice: crates/executors/src/approvals.rs:1].
Le sottoattività esistono come task figli legati a un parent [non verificato].
Il monitoraggio dei processi di esecuzione ha route dedicate
con eventi di stop e riavvio [codice: crates/server/src/routes/workspaces/execution.rs:147].
I workspace supportano sessioni multiple e multi repo [doc: https://vibekanban.com/docs/workspaces/sessions].

## Usabilità

Superfici: web locale, app desktop Tauri, web remota per accesso da altri dispositivi,
estensione per VSCode e derivati [doc: https://vibekanban.com/docs/integrations/vscode-extension].
Il layout dei workspace ha quattro pannelli: sidebar dei workspace,
chat con l'agente, pannello di contesto (changes, log o preview)
e sidebar dei dettagli con git, terminale e note [doc: https://vibekanban.com/docs/workspaces/interface].
Ogni pannello si mostra o nasconde dalla navbar, e il pannello changes
offre viste affiancate o inline [doc: https://vibekanban.com/docs/workspaces/interface].
La command bar si apre con `Cmd/Ctrl + K` e copre creazione workspace,
PR e toggle dei pannelli [doc: https://vibekanban.com/docs/workspaces/command-bar].
La revisione avviene sui diff con commenti inline riga per riga,
inviabili all'agente senza uscire dall'UI [doc: https://vibekanban.com/docs/core-features/reviewing-code-changes].
L'onboarding guidato copre setup agente, progetti, issue e primo workspace
con schermate dedicate [doc: https://vibekanban.com/docs/getting-started].
Le notifiche sonore di fine task sono configurabili dal setup iniziale [doc: https://vibekanban.com/docs/getting-started].
La scala del testo è regolabile per gli schermi piccoli [issue #1232].

## Browser e anteprima

Ha un'anteprima integrata, non un browser pilotato dall'agente:
il dev server del workspace viene servito in un iframe isolato
tramite un proxy dedicato [codice: crates/preview-proxy/src/lib.rs:3].
Il proxy riscrive path e sottodomini per tenere separati
i contenuti dei vari workspace [codice: crates/server/src/routes/preview.rs:15].
Sopra l'anteprima girano script iniettati per click to component,
devtools e debug su mobile [codice: crates/preview-proxy/src/api.rs:1].
Dichiara anche device emulation e inspect mode [README].
Niente co browse fra dispositivi: il telefono vede la stessa UI remota,
non il DOM del Mac rispecchiato, quindi Topics resta avanti su questo punto.
Limiti noti: le app che richiedono cookie di autenticazione
andavano in redirect loop [issue #2851],
e l'anteprima si rompe quando l'istanza è ospitata in remoto [issue #3203].
Il rilevamento dell'URL del dev server perde i sottodomini
con certi domini locali [issue #2901].

## Terminale, editor, file

Ogni workspace ha un terminale su WebSocket con resize di righe e colonne
negoziato via query string [codice: crates/server/src/routes/terminal.rs:22].
I WebSocket passano da un middleware di firma,
quindi non sono endpoint anonimi [codice: crates/server/src/routes/terminal.rs:18].
L'editing avviene o nell'IDE esterno (estensione ufficiale)
o con apertura remota dell'editor via tunnel [codice: crates/server/src/routes/host_relay/open_remote_editor.rs:39].
La ricerca file e la sorveglianza del filesystem hanno servizi dedicati
con ranking dei risultati [codice: crates/services/src/services/file_ranker.rs:1].
I log di esecuzione sono persistiti in tabella dedicata
dopo essere stati tolti dalle colonne dei processi [non verificato].
Allegati e immagini delle sessioni usano tabelle di giunzione dedicate [non verificato].

## Remoto e mobile

L'accesso remoto combina cloud e relay: sul client si apre il cloud in browser,
si genera un pairing code sull'host e si collega l'host inserendo il codice [doc: https://vibekanban.com/docs/remote-access].
La priorità è al canale WebRTC diretto, con fallback su relay,
e l'apertura dell'editor remoto crea un tunnel SSH dedicato [codice: crates/server/src/routes/host_relay/open_remote_editor.rs:45].
I crate di rete sono molti (relay control, ws, webrtc, tunnel core, hosts, ws bridge),
segno che il remoto era un investimento centrale [codice: Cargo.toml:10].
Attenzione: con il sunset i servizi remoti (issue kanban, commenti, progetti, organizzazioni)
erano destinati alla rimozione dopo 30 giorni,
mentre i workspace locali restano funzionanti [doc: https://www.vibekanban.com/blog/shutdown].
Nessuna app mobile nativa: il client remoto è web, usabile da telefono.
Il login remoto passa da GitHub o Google sull'onboarding [doc: https://vibekanban.com/docs/getting-started].

## Provider e protocolli

Supporta dieci agenti selezionabili per workspace: Claude Code, Codex, Copilot,
Gemini, Amp, Cursor, OpenCode, Droid, Claude Code Router e Qwen [doc: https://vibekanban.com/docs/supported-coding-agents].
La versione della CLI di Claude è fissata nel codice alla 2.1.119,
aggiornata a mano [codice: crates/executors/src/executors/claude.rs:80].
Oltre agli executor nativi esiste un harness generico ACP con client,
normalizzazione dei log e persistenza di sessione [codice: crates/executors/src/executors/acp/session.rs:10].
Ogni executor ha configurazione di comandi MCP e override di comando
per profilo [codice: crates/executors/src/mcp_config.rs:1].
Le credenziali degli agenti restano quelle dell'utente: la documentazione chiede
di autenticarsi con il proprio agente prima di lanciare il tool,
quindi niente condivisione di token lato server [README].
Non risulta supporto al protocollo MCP come server generico
oltre al task server interno [codice: crates/mcp/src/lib.rs:1].

## Performance

Nessun benchmark dichiarato nel README.
Le issue raccontano i colli di bottiglia: conversazioni grandi occupano molta memoria
e rallentano l'interfaccia [issue #1140],
bundle JS da 4,7 MB senza code splitting con caricamenti di 7-10 secondi [issue #3153],
caricamento di kanban e workspace con uso di memoria fuori controllo
fino al blocco [issue #3373].
Sul backend: SQLite in lock durante logging intenso [issue #2926],
scritture su disco eccessive [issue #1059],
pagina progetti molto lenta [issue #2842],
finestra di diff lenta ad aprirsi [issue #1206].
Rust aiuta sul backend (git via libgit2, streaming dei log, proxy),
ma i problemi segnalati sono quasi tutti su frontend e SQLite,
fuori dalla portata del linguaggio di sistema.
Una mitigazione discussa è caricare solo l'ultimo giro di conversazione [issue #2624].

## Affidabilità e qualità

La CI su GitHub Actions usa path filter per lanciare solo i job toccati
(frontend, backend, remoto, Tauri) con toolchain nightly fissata [codice: .github/workflows/test.yml:20].
I file di test trovati nel clone sono pochi (una decina scarsa fra unit e integrazione,
fra cui sicurezza delle operazioni git e discovery dei repo)
a fronte di oltre 200 mila righe di codice [non verificato].
La persistenza è affidata a SQLite con migrazioni sqlx,
e le sessioni degli executor hanno tabella dedicata [non verificato].
Segnali di fragilità dalle issue: spegnimenti improvvisi dopo pochi secondi d'uso [issue #3231],
errori 500 da riga mancante nel database [issue #3174],
stato di autenticazione non resettabile nemmeno cancellando il database locale [issue #3434].
Gli aggiornamenti viaggiano via npm e release GitHub frequenti [release v0.1.44].
Il passaggio a edizione community solleva dubbi su quali versioni
restano affidabili per la board [issue #3444].

## Sicurezza e privacy

L'autenticazione verso gli agenti riusa le CLI già autenticate dell'utente,
scelta lecita che evita di maneggiare token altrui [README].
Il server ha route OAuth e un servizio per le credenziali,
più middleware di firma su WebSocket e richieste relay [codice: crates/services/src/services/oauth_credentials.rs:1].
L'anteprima gira su server HTTP separato apposta per isolare
i contenuti dall'app principale [codice: crates/preview-proxy/src/lib.rs:3].
La telemetria usa PostHog ed è attiva solo se le chiavi sono fornite in build,
quindi disabilitabile [codice: packages/local-web/src/app/entry/Bootstrap.tsx:31].
Esiste una policy di responsible disclosure aggiornata a febbraio 2026 [doc: https://vibekanban.com/docs/responsible-disclosure].
Rischi aperti: issue che descrivono inviti a organizzazioni riscattabili
da account non invitati [issue #3430],
redirect OAuth manipolabile verso takeover dell'account [issue #3429],
e contatti di sicurezza non raggiungibili secondo una segnalazione [issue #3466].
Il sandboxing dei workspace passa da container e dev script per progetto [non verificato].

## Estendibilità

Estensione ufficiale per VSCode, Cursor e Windsurf con log, diff
e monitoraggio dei processi dentro l'IDE [doc: https://vibekanban.com/docs/integrations/vscode-extension].
Configurazione MCP per agente documentata, più MCP server integrato
per esporre task e workspace [doc: https://vibekanban.com/docs/integrations/vibe-kanban-mcp-server].
Gli hook di Claude Code sono iniettati dal backend
(controllo git allo stop, PreToolUse legati a piani e approvazioni) [codice: crates/executors/src/executors/claude.rs:209].
I comandi degli executor si possono ridefinire per profilo
con override [codice: crates/executors/src/command.rs:1].
Cosa manca: un sistema di plugin per la UI,
richiesto dalla comunità ma mai realizzato [issue #1443].
Le skill degli agenti non sono gestite come entità proprie:
passano dalle configurazioni dei singoli executor [non verificato].
Il selettore di modello e policy di permessi è centralizzato [codice: crates/executors/src/model_selector.rs:1].

## Da prendere per Topics

1. Commenti inline sui diff inviati all'agente come feedback strutturato:
riduce il giro fra revisione e nuova esecuzione, ed è il pezzo più lodato della UX [doc: https://vibekanban.com/docs/core-features/reviewing-code-changes].
2. Coda dei messaggi di follow up mentre l'agente lavora:
evita interruzioni e perdita di contesto, problema sentito anche su Topics [codice: crates/server/src/routes/sessions/queue.rs:15].
3. Hook iniettati nelle CLI (controllo git, policy sui tool):
enforcement gratis senza modificare gli agenti [codice: crates/executors/src/executors/claude.rs:209].
4. Preview su server HTTP separato con proxy per workspace:
isolamento semplice ed efficace da copiare per l'anteprima di Topics [codice: crates/preview-proxy/src/lib.rs:3].
5. Script iniettati click to component sopra l'anteprima:
accorcia il ciclo vedi, indica, correggi [codice: crates/preview-proxy/src/api.rs:1].
6. Sincronizzazione globale sulla creazione dei worktree:
previene le race quando la board lancia più agenti insieme [codice: crates/worktree-manager/src/worktree_manager.rs:59].
7. Harness ACP generico con normalizzazione dei log:
un solo formato di eventi per agenti diversi semplifica chat e review [codice: crates/executors/src/executors/acp/session.rs:10].
8. Pairing code per collegare un dispositivo remoto all'host:
onboarding del remoto più semplice di token manuali [doc: https://vibekanban.com/docs/remote-access].

## Da evitare

1. Bundle frontend monolitico da quasi 5 MB senza code splitting:
porta a caricamenti di 7-10 secondi, errore già misurato [issue #3153].
2. Logging intenso su SQLite senza batching:
causa lock del database sotto carico [issue #2926].
3. Conversazioni intere tenute in memoria nel frontend:
degrada fino al blocco sui task lunghi [issue #1140].
4. Stato di autenticazione sparso fra più file oltre al database:
rende impossibile il reset pulito [issue #3434].
5. Dipendenza da servizi cloud proprietari per funzioni core (issue, commenti, organizzazioni):
al sunset vanno rimosse e lasciano buchi [doc: https://www.vibekanban.com/blog/shutdown].
6. Anteprima che non gestisce cookie di autenticazione:
esclude dal test proprio le app reali con login [issue #2851].

## Fonti

- Repository: https://github.com/BloopAI/vibe-kanban
- README: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/README.md
- Manifest workspace: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/Cargo.toml
- Executor Claude: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/executors/src/executors/claude.rs
- Worktree manager: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/worktree-manager/src/worktree_manager.rs
- Preview proxy: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/preview-proxy/src/lib.rs
- Annuncio di chiusura: https://www.vibekanban.com/blog/shutdown
- Documentazione: https://vibekanban.com/docs/getting-started
- Agenti supportati: https://vibekanban.com/docs/supported-coding-agents
- Accesso remoto: https://vibekanban.com/docs/remote-access
- Guida interfaccia: https://vibekanban.com/docs/workspaces/interface
