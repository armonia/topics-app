# CCManager

## In tre righe
- CCManager è una TUI da terminale che gestisce sessioni parallele di agenti di codice (Claude Code, Gemini, Codex, OpenCode e altri) sopra git worktree e più progetti [README].
- È pensata per chi vive nel terminale e vuole cambiare sessione con un tasto, senza tmux e senza interfaccia grafica [README].
- Il suo punto più forte rispetto a Topics è il rilevamento dello stato delle sessioni (busy, waiting, idle) letto direttamente dal terminale, con hook di notifica per ogni cambio di stato [codice: src/services/stateDetector/claude.ts:4].

## Identità
- Repository `kbwo/ccmanager`, descritto come gestore di sessioni per Claude Code, Gemini CLI, Codex CLI, Cursor, Copilot CLI, Cline, OpenCode e Kimi [README].
- Conta circa 1262 stelle e 94 fork al momento del clone, con creazione a giugno 2025 [doc: https://github.com/kbwo/ccmanager].
- La licenza è MIT [README].
- L'ultimo commit del clone è del 10 ottobre 2026 (`chore: update version to 4.4.6`), con push remoto al 12 ottobre 2026: il progetto è attivo [release v4.4.6].
- Le release sono ravvicinate: v4.4.6, v4.4.5, v4.4.4, v4.4.3 e v4.4.2 tra settembre e ottobre 2026, cadenza quasi settimanale [release v4.4.6].
- Gira su macOS (arm64 e x64), Linux (arm64 e x64) e Windows (x64) tramite binari precompilati distribuiti come pacchetti npm opzionali [codice: src/../scripts/build-binaries.ts:20].
- La maturità è buona per un tool CLI: suite di test ampia, CI su ogni push e configurazione per progetto [codice: src/../.github/workflows/ci.yml:1].

## Architettura
- Il codice è quasi tutto TypeScript: GitHub riporta circa 1,24 MB di TypeScript contro pochi KB di JavaScript e shell [doc: https://github.com/kbwo/ccmanager].
- I sorgenti in `src/` sommano circa 43.325 righe su 165 file TypeScript e TSX, misurati con `git ls-files` più `wc -l` [codice: src/services/worktreeService.ts:1].
- Il framework UI è Ink (React 19 nel terminale) con runtime Bun, come dicono le dipendenze `ink`, `react` e `@types/bun` in `package.json` [codice: src/../package.json:1].
- I binari nativi sono prodotti con la compilazione di Bun per cinque coppie sistema operativo e architettura [codice: src/../scripts/build-binaries.ts:20].
- Il modello dei processi è semplice: un solo processo TUI che genera un PTY per ogni sessione agente [codice: src/services/sessionManager.ts:58].
- Il PTY usa l'API Terminal integrata in Bun, incapsulata in una classe che espone `IPty` (pid, onData, onExit, write, resize, kill), scelta per evitare i problemi delle librerie native negli eseguibili compilati [codice: src/services/bunTerminal.ts:1].
- Accanto a ogni PTY reale gira un terminale virtuale `xterm headless` con addon di serializzazione, per snapshot dello schermo, rilevamento dello stato e ripristino visivo [codice: src/services/sessionManager.ts:58].
- Con l'agente parla nel modo più grezzo possibile: lo lancia come sottoprocesso nel PTY e ne legge lo schermo, senza Agent SDK, senza stream-json e senza ACP [codice: src/services/sessionManager.ts:19].
- Il rilevamento dello stato avviene per polling ogni 100 ms sul contenuto del terminale virtuale [codice: src/services/sessionManager.ts:19].
- Non c'è Rust né Go nel progetto: la velocità dichiarata viene da Bun e dall'assenza di Electron, non da componenti nativi [non verificato].
- Lo storage è su file locali: configurazione globale in `~/.config/ccmanager/config.json` e per progetto in `.ccmanager.json`, con priorità al progetto sul globale [codice: src/services/config/configReader.ts:21].
- Le sessioni da ripristinare sono persistite in uno store dedicato gestito da un orchestratore globale [codice: src/services/sessionRestorer.ts:14].
- L'orchestratore globale è un singleton: un gestore per la modalità a progetto singolo e uno per ogni progetto in modalità multi progetto, creati alla prima richiesta [codice: src/services/globalSessionOrchestrator.ts:6].
- Tutte le sessioni attive si raccolgono attraversando il gestore globale e quelli di progetto, così il ripristino copre ogni contesto [codice: src/services/globalSessionOrchestrator.ts:38].
- La logica di dominio usa la libreria Effect per operazioni ed errori tipizzati, con migrazione documentata in un documento dedicato [doc: https://github.com/kbwo/ccmanager/blob/46fe720edfec98d9ab84bf8a326c35b45913fb2b/docs/effect-error-handling-migration.md].
- I log passano da una classe dedicata invece dei `console` sparsi, come impongono le linee guida del repository [codice: src/../AGENTS.md:1].
- Lo stato di ogni sessione è protetto da un mutex dedicato che ne serializza gli aggiornamenti, dettaglio importante con polling e hook concorrenti [codice: src/types/index.ts:68].

## Sessioni e task
- Le sessioni sono parallele: più sessioni per worktree e più worktree per progetto, con supporto multi progetto in un'unica interfaccia [README].
- Ogni sessione registra comando usato, preset, strategia di rilevamento e stato protetto da mutex [codice: src/types/index.ts:46].
- Se il processo muore subito con il comando principale, la sessione conserva argomenti di riserva per un singolo nuovo tentativo [codice: src/types/index.ts:46].
- Il cambio di sessione riproduce l'output accumulato per ridisegnare lo schermo, con scrollback di 5000 righe [codice: src/services/sessionManager.ts:33].
- I worktree si creano, fondono ed eliminano dalla TUI, con supporto per rami remoti e gestione dei sottomoduli [codice: src/services/worktreeService.ts:274].
- Il merge ha strategia configurabile, inclusa l'opzione di squash nata da una richiesta esplicita [issue #223].
- Il riconoscimento dei sottomoduli ha richiesto fix dedicati dopo segnalazioni degli utenti [issue #189].
- Un file `.worktreeinclude` copia nei nuovi worktree i file ignorati da git come `.env` e certificati locali [README].
- Prima e dopo la creazione partono hook di shell configurabili, con variabili `CCMANAGER_WORKTREE_PATH`, `CCMANAGER_WORKTREE_BRANCH` e `CCMANAGER_GIT_ROOT` [codice: src/utils/hookExecutor.ts:15].
- Il ripristino dopo uscita o crash riapre le sessioni attive, dimenticando i record consumati per non duplicarli [codice: src/services/sessionRestorer.ts:126].
- Esiste anche la copia dei dati di sessione di Claude Code tra worktree per conservare il contesto conversazionale [README].
- Ogni sessione si può rinominare, terminare o riaprire dal menu azioni dedicato, con voci per nuova sessione ed eliminazione worktree [codice: src/components/SessionActions.tsx:1].
- Il gestore espone conteggi aggregati per stato (idle, busy, waiting, approvazione in attesa) più task in background e membri dei team di agenti, usati dalla dashboard [codice: src/services/sessionManager.ts:49].
- Non c'è una kanban globale con code, tentativi automatici, review e land come in Topics: resta un lanciatore e monitor di sessioni manuali [non verificato].
- L'esecuzione in contenitore è coperta dall'integrazione devcontainer [doc: https://github.com/kbwo/ccmanager/blob/46fe720edfec98d9ab84bf8a326c35b45913fb2b/docs/devcontainer.md].

## Usabilità
- Unica superficie: il terminale. Si installa con `npm install -g ccmanager` e si avvia con `ccmanager` [README].
- I flussi principali sono menu dei worktree, dashboard delle sessioni, creazione worktree, merge, eliminazione e configurazione, come componenti Ink separati [codice: src/components/App.tsx:1].
- La dashboard mostra icone di stato per sessione: busy, waiting, idle e approvazione automatica in attesa [codice: src/constants/statusIcons.ts:1].
- Le scorciatoie sono configurabili da UI o da file, con `Ctrl+E` come ritorno al menu e `Escape` per annullare [README].
- Il selettore di preset all'avvio permette di scegliere con quale comando aprire la sessione, con fallback se il comando principale fallisce [codice: src/services/sessionManager.ts:89].
- Le notifiche passano dagli status hook: comandi shell arbitrari eseguiti a ogni transizione di stato [codice: src/types/index.ts:130].
- La guida documenta esempi pronti con `noti`, webhook Slack e barra di tmux, con variabili standard come `CCMANAGER_OLD_STATE`, `CCMANAGER_NEW_STATE` e `CCMANAGER_SESSION_ID` [doc: https://github.com/kbwo/ccmanager/blob/46fe720edfec98d9ab84bf8a326c35b45913fb2b/docs/status-hooks.md].
- Il menu ricorda i progetti recenti per rientrare in fretta nel contesto precedente [codice: src/components/Menu.tsx:85].
- L'onboarding è minimo: il confronto con Claude Squad nel README punta su niente tmux, stati visibili e interfaccia immediata [README].
- Una richiesta aperta chiede il filtro delle sessioni per stato nella lista, segno che con molte sessioni la navigazione diventa faticosa [issue #310].

## Browser e anteprima
- Nessun browser e nessuna anteprima integrata: solo terminali testuali dentro la TUI [non verificato].
- Non esiste co-browse tra dispositivi né pilotaggio di pagine web da parte dell'agente [non verificato].
- Le sessioni sono processi CLI nel PTY, quindi tutto ciò che l'agente vede passa dal testo del terminale [codice: src/services/sessionManager.ts:58].
- Per Topics, che ha un WKWebView nativo pilotabile con 15 tool, qui non c'è nulla da confrontare né da prendere sul fronte browser.

## Terminale, editor, file
- Il terminale è il cuore del prodotto: PTY reale più terminale virtuale xterm per snapshot e serializzazione [codice: src/services/sessionManager.ts:58].
- Il ridimensionamento sopprime temporaneamente l'eco (250 ms) per evitare righe duplicate dopo SIGWINCH [codice: src/services/sessionManager.ts:36].
- Il ripristino visivo attende una finestra di quiete di 80 ms per non catturare frame a metà disegno [codice: src/services/sessionManager.ts:40].
- Non c'è un editor integrato: l'utente lavora nell'agente lanciato nel PTY [non verificato].
- La gestione file è al livello git: creazione worktree, copia dei file ignorati via `.worktreeinclude`, copia dei dati di sessione e merge [README].
- Lo stato git per worktree è mostrato nel menu per decidere cosa fondere o eliminare [codice: src/services/worktreeService.ts:1].

## Remoto e mobile
- Nessun accesso remoto e nessuna interfaccia mobile: è una TUI nel terminale locale [non verificato].
- Nessun server, relay o cifratura, perché non esce dalla macchina [non verificato].
- Chi vuole usarla da telefono deve arrangiarsi con SSH verso il proprio terminale, senza supporto dedicato [non verificato].
- Una issue aperta chiede un terminale apribile sul worktree, ma resta in ambito desktop locale [issue #229].
- Per Topics, che si usa da iPad e telefono in LAN, qui non c'è concorrenza né ispirazione.

## Provider e protocolli
- Il supporto provider è ampio sul lato lancio: Claude Code, Gemini CLI, Codex CLI, Cursor, Copilot CLI, Cline CLI, OpenCode e Kimi CLI [codice: src/services/stateDetector/index.ts:13].
- Esiste anche una nona strategia `mcode` nel selettore dei rilevatori [codice: src/services/stateDetector/index.ts:13].
- Il preset predefinito lancia `claude` con nome `Main`, e ogni preset può definire comando, argomenti e fallback [codice: src/services/config/globalConfigManager.ts:209].
- Una opzione mostra il selettore di preset prima di ogni avvio, comoda quando lo stesso worktree si usa con agenti diversi [codice: src/services/config/configReader.ts:142].
- Ogni provider ha un rilevatore di stato dedicato basato su euristiche dello schermo [codice: src/services/stateDetector/claude.ts:1].
- Per Claude si cercano spinner di attività, riquadro del prompt e statistiche dei token [codice: src/services/stateDetector/claude.ts:4].
- Non c'è integrazione MCP, né plugin per agenti, né protocollo ACP nel codice: l'unica occorrenza di `mcp` nei sorgenti è un flag `--no-mcp` passato a un agente in un test, mai un client o un server [codice: src/services/sessionManager.test.ts:184].
- L'estensione a nuovi provider avviene aggiungendo un rilevatore e una strategia, come mostrano le issue chiuse per Cursor, Copilot, Cline e OpenCode [issue #74] [issue #101] [issue #112] [issue #167].
- Le strategie si configurano per strumento, con personalizzazione documentata [doc: https://github.com/kbwo/ccmanager/blob/46fe720edfec98d9ab84bf8a326c35b45913fb2b/docs/gemini-support.md].

## Performance
- Nessun benchmark dichiarato nel README [README].
- I punti caldi sono il polling di stato ogni 100 ms per sessione e il replay dell'output al cambio di sessione [codice: src/services/sessionManager.ts:19].
- La cronologia è limitata a 10 MB ma per sessioni longeve il cambio pagina causa un ritardo visibile mentre il terminale scorre tutto lo storico [issue #270].
- Il debounce di 1500 ms prima di dichiarare idle una sessione Claude ritarda le transizioni, scelta voluta contro i falsi idle durante i ridisegni [codice: src/services/stateDetector/claude.ts:21].
- Oltre al ritardo di cambio sessione, si segnalano stati errati (idle mentre Claude lavora) poi corretti aggiornando le euristiche [issue #227] [issue #117].
- Non risultano lamentele su memoria, CPU o batteria nelle issue aperte, coerente con un processo Bun leggero rispetto a un guscio Electron [non verificato].
- Il rovescio è la fragilità delle euristiche: ogni cambio di UI di Claude Code o Codex può rompere il rilevamento, come accaduto più volte per Codex [issue #84] [issue #131].
- Un limitatore di concorrenza regola le operazioni parallele, usato per le interrogazioni di stato git sui worktree [codice: src/utils/gitStatus.ts:99].

## Affidabilità e qualità
- La suite conta 84 percorsi con `test` o `spec` nel nome, con test affiancati al codice secondo le linee guida del repository [codice: src/../AGENTS.md:1].
- La CI esegue typecheck, lint, test Vitest, build TypeScript e compilazione del binario nativo a ogni push su main e su ogni pull request [codice: src/../.github/workflows/ci.yml:1].
- La gestione errori usa il Result pattern della libreria Effect, con tipi dedicati per errori di processo, configurazione e filesystem [codice: src/types/errors.ts:1].
- La persistenza delle sessioni copre il recupero dopo crash, con test dedicati al ripristino [codice: src/services/globalSessionOrchestrator.restore.test.ts:1].
- Gli aggiornamenti passano da npm con binari per piattaforma [codice: src/../scripts/build-binaries.ts:20].
- Tra i problemi reali: hook di creazione che non partivano [issue #294].
- Sessioni che perdevano resume e ricerca se lanciate dall'app [issue #196].
- Modalità TTY di Codex che rompevano le scorciatoie delle altre sessioni [issue #131].
- Errore di spawn su Windows per `posix_spawnp` [issue #140].
- Il quadro è di buona igiene ingegneristica su un problema intrinsecamente fragile come il parsing dello schermo altrui.

## Sicurezza e privacy
- CCManager non gestisce token né OAuth in proprio: lancia le CLI che usano le credenziali già presenti sulla macchina [non verificato].
- Quindi non c'è un flusso di autenticazione da valutare nel prodotto [non verificato].
- La superficie principale sono gli hook: comandi shell arbitrari con i permessi dell'utente, distruttivi se mal configurati [codice: src/utils/hookExecutor.ts:15].
- Il caricamento automatico dei `.env` nei worktree è disabilitabile, opzione nata da una richiesta esplicita [issue #177].
- Nessuna telemetria nei sorgenti: la ricerca di telemetry, analytics, Sentry e PostHog non dà risultati, e l'unica occorrenza legata a MCP è il flag citato sopra [codice: src/services/sessionManager.test.ts:184].
- Nessuna porta esposta in rete: è un processo TUI locale senza server HTTP [non verificato].
- La sandbox è assente, a parte l'integrazione opzionale con devcontainer che isola le sessioni in contenitore [doc: https://github.com/kbwo/ccmanager/blob/46fe720edfec98d9ab84bf8a326c35b45913fb2b/docs/devcontainer.md].
- L'Auto Approval sperimentale merita prudenza: un gate AI approva da solo i prompt ritenuti sicuri, e un falso negativo approva azioni che l'utente avrebbe fermato [codice: src/services/autoApprovalVerifier.ts:32].
- La verifica supporta un comando custom separato dal prompt principale come secondo parere [codice: src/services/autoApprovalVerifier.ts:653].

## Estendibilità
- Niente server MCP e niente sistema di plugin per agenti [non verificato].
- L'estendibilità è per l'utente avanzato: preset di comando con fallback, scorciatoie configurabili, status hook e worktree hook come comandi shell [README].
- Le strategie di rilevamento si configurano per strumento [doc: https://github.com/kbwo/ccmanager/blob/46fe720edfec98d9ab84bf8a326c35b45913fb2b/docs/command-config.md].
- La cartella `plugins/` contiene solo un validatore di esempi di configurazione con skill annesse, non un meccanismo di plugin runtime [codice: src/../plugins/ccmanager-config/README.md:1].
- Chi vuole un nuovo provider contribuisce un rilevatore nel codice, non installa un'estensione [codice: src/services/stateDetector/index.ts:13].

## Da prendere per Topics
- 1. Rilevamento dello stato via terminale con polling e debounce: le euristiche su spinner e riquadro prompt con conferma di stabilità prima di dichiarare idle sono un ottimo fallback quando manca lo stream-json strutturato [codice: src/services/stateDetector/claude.ts:21]. Per Topics conterebbe come segnale indipendente dallo stato dichiarato dagli agenti.
- 2. Status hook per transizione (idle, busy, waiting, approvazione): un comando shell per stato è il meccanismo più semplice per notifiche desktop, suoni e automazioni esterne [codice: src/types/index.ts:130]. Per Topics significherebbe notifiche iPad e LAN quasi gratis.
- 3. Preset di comando con fallback automatico: se il comando principale fallisce all'avvio, ritenta una volta con argomenti di riserva [codice: src/services/sessionManager.ts:89]. Per Topics ridurrebbe i topic morti per flag CLI cambiate tra versioni.
- 4. `.worktreeinclude` per i file ignorati: copiare `.env` e certificati locali nei nuovi worktree risolve un dolore reale dei setup multi worktree [README]. Per Topics, che lancia agenti in worktree separate, è un'adozione a basso costo.
- 5. Copia dei dati di sessione Claude tra worktree: conserva il contesto conversazionale spostandosi di ramo [README]. Per Topics varrebbe come migrazione assistita del topic tra worktree.
- 6. Ripristino sessioni dopo crash con record dimenticati dopo l'uso: evita duplicati alla riapertura [codice: src/services/sessionRestorer.ts:126]. Per Topics è il modello corretto per la persistenza delle chat dopo un riavvio del servizio.
- 7. Auto Approval con gate esterno personalizzabile: la verifica via comando custom separato dal prompt principale è un buon confine di sicurezza [codice: src/services/autoApprovalVerifier.ts:653]. Per Topics conterebbe come secondo parere prima delle azioni rischiose.
- 8. Configurazione a due livelli (globale più progetto con override di campo): semplice e prevedibile, senza merge profondi sorprendenti [codice: src/services/config/configReader.ts:21]. Per Topics è un modello da copiare per le impostazioni per repo.
- 9. Orchestratore con un gestore di sessioni per progetto più uno globale: isola i contesti ma permette viste aggregate e ripristino totale [codice: src/services/globalSessionOrchestrator.ts:6]. Per Topics è lo schema giusto per la futura vista multi repo.
- 10. Variabili d'ambiente standard negli hook (`CCMANAGER_OLD_STATE`, `CCMANAGER_NEW_STATE`, `CCMANAGER_SESSION_ID`): rendono gli hook componibili con strumenti esterni senza API dedicate [doc: https://github.com/kbwo/ccmanager/blob/46fe720edfec98d9ab84bf8a326c35b45913fb2b/docs/status-hooks.md]. Per Topics varrebbe lo stesso contratto per gli hook dei topic.

## Da evitare
- 1. Parsing dello schermo come unico segnale di stato: ogni restyling della CLI rompe il rilevamento e costringe a rincorrere le release, come accaduto ripetutamente con Codex [issue #84] [issue #131]. Meglio preferire protocolli strutturati e tenere le euristiche come fallback.
- 2. Replay integrale dell'output al cambio di sessione: riversare megabyte di storico causa ritardi documentati dagli utenti [issue #270]. Meglio snapshot serializzato o rendering differenziale.
- 3. Bypass delle conferme di sicurezza integrate negli agenti: il README stesso sconsiglia l'approccio AutoYes della concorrenza perché aggira le protezioni di Claude Code [README]. L'Auto Approval va confinato a un gate esplicito e disattivabile.
- 4. Hook di shell che falliscono in silenzio sul percorso critico: i post-hook di creazione non partivano senza segnali chiari [issue #294]. Ogni hook deve registrare esito e durata in un log ispezionabile.
- 5. Scorciatoie globali fragili alle particolarità dei terminali: dal Num Lock che rompe `Ctrl+E` alle modalità TTY di Codex che avvelenano le altre sessioni [issue #327] [issue #131]. Serve isolamento dell'input per sessione e test su più emulatori.
- 6. Rilevatori scritti a mano per ogni provider senza astrarre il pattern: nove strategie con euristiche simili ma duplicate [codice: src/services/stateDetector/index.ts:13]. Se Topics adotta il rilevamento da terminale come fallback, meglio un motore a pattern dichiarativi con un solo punto di aggiornamento per provider.

## Fonti
- README e descrizione del progetto: [doc: https://github.com/kbwo/ccmanager]
- Metadati repository (stelle, fork, licenza, date): [doc: https://github.com/kbwo/ccmanager]
- Release v4.4.6 e precedenti: [release v4.4.6]
- Interfaccia PTY su Bun: [codice: src/services/bunTerminal.ts:1]
- Gestore sessioni, polling e costanti terminale: [codice: src/services/sessionManager.ts:19]
- Tipi di sessione, stati e hook: [codice: src/types/index.ts:46]
- Rilevatori di stato per provider: [codice: src/services/stateDetector/index.ts:13]
- Euristiche Claude e debounce idle: [codice: src/services/stateDetector/claude.ts:4]
- Lettore di configurazione a due livelli: [codice: src/services/config/configReader.ts:21]
- Preset predefinito `claude`: [codice: src/services/config/globalConfigManager.ts:209]
- Esecuzione hook: [codice: src/utils/hookExecutor.ts:15]
- Servizio worktree: [codice: src/services/worktreeService.ts:274]
- Ripristino sessioni: [codice: src/services/sessionRestorer.ts:126]
- Verifica Auto Approval: [codice: src/services/autoApprovalVerifier.ts:32]
- CI con test, lint e build binario: [codice: src/../.github/workflows/ci.yml:1]
- Linee guida di sviluppo e test: [codice: src/../AGENTS.md:1]
- Documentazione devcontainer: [doc: https://github.com/kbwo/ccmanager/blob/46fe720edfec98d9ab84bf8a326c35b45913fb2b/docs/devcontainer.md]
- Configurazione comandi: [doc: https://github.com/kbwo/ccmanager/blob/46fe720edfec98d9ab84bf8a326c35b45913fb2b/docs/command-config.md]
- Supporto Gemini: [doc: https://github.com/kbwo/ccmanager/blob/46fe720edfec98d9ab84bf8a326c35b45913fb2b/docs/gemini-support.md]
- Issue citate: [issue #270] [issue #227] [issue #117] [issue #84] [issue #131] [issue #223] [issue #189] [issue #196] [issue #294] [issue #140] [issue #177] [issue #310] [issue #229] [issue #327] [issue #74] [issue #101] [issue #112] [issue #167]
