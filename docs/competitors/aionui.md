# AionUi

## In tre righe

AionUi è un'app desktop open source che fa da guscio unificato a molti agenti CLI esterni, come Claude Code, Codex e Gemini, parlando con loro in ACP, e include anche un agente integrato a configurazione zero.

Punta a un pubblico largo, anche non tecnico, con assistenti pronti per Office, automazioni schedulate e accesso da telefono, chat e browser.

Il suo punto più forte rispetto a Topics è l'ecosistema di pilotaggio esterno già pronto: WebUI remota, canali di messaggistica, team multi agente e browser in app manovrato dall'agente, tutti documentati e coperti da test.

## Identità

Il repository è `iOfficeAI/AionUi`, con circa 33.500 stelle e 3.500 fork rilevati il 14 ottobre 2026 [non verificato].

La licenza è Apache 2.0 [codice: package.json:6].

Il progetto è nato ad agosto 2025 ed è molto attivo: ultimo commit il 14 ottobre 2026, con messaggio su documentazione e QR del gruppo cinese.

Le release sono frequenti: la stabile più recente è v2.2.2 del 9 settembre 2026, preceduta da v2.2.1 e da una lunga serie di 2.1.x [release v2.2.2].

Le piattaforme dichiarate sono macOS, Windows e Linux, con in più Android via Termux in modalità WebUI e una app mobile dedicata [doc: https://github.com/iOfficeAI/AionUi/blob/c140550d04e44f3d6f8a9830b40ae56e4689a977/docs/guides/webui.md].

La comunità vive su Discord in inglese, gruppo cinese su WeChat e account su X, con documentazione tradotta in almeno nove lingue [README].

Accanto al guscio esistono repository fratelli: il backend Rust, un catalogo di assistenti integrati e uno strumento da riga di comando per i documenti Office [README].

La maturità è alta per ritmo di release e ampiezza dei test, ma resta una coda lunga di bug aperti su Windows e sui backend agente meno diffusi [issue #4310] [issue #4296].

## Architettura

Il frontend è Electron 37 con React, Arco Design come libreria di componenti, icone IconPark e UnoCSS per gli stili, compilato con electron-vite [codice: package.json:78].

I due processi restano separati per regola interna: il main non tocca il DOM, il renderer non tocca Node, e ogni scambio passa dal bridge IPC nel preload [codice: packages/desktop/src/process/index.ts:1].

Il lavoro pesante sta in un binario Rust separato chiamato `aioncore`, mantenuto in un secondo repository con workspace Cargo.

L'app lo cerca in tre posti, nell'ordine: variabile d'ambiente dedicata, risorse integrate nell'installazione e PATH di sistema [codice: packages/desktop/src/process/backend/binaryResolver.ts:14] [doc: https://github.com/iOfficeAI/AionCore].

Misurato nel clone allo SHA citato: 1.613 file TypeScript e TSX per circa 288.600 righe, nessun file Rust o Go nel repository dell'interfaccia.

Lo storage locale è SQLite via better-sqlite3, con un driver dedicato, migrazioni versionate e procedure di riparazione [codice: package.json:114] [codice: packages/desktop/src/process/services/database/drivers/BetterSqlite3Driver.ts:1].

Con gli agenti parla soprattutto in ACP con SDK ufficiale, e usa gli SDK Anthropic e OpenAI per i percorsi nativi più un convertitore di protocollo [codice: package.json:78].

I pacchetti interni separano il desktop, il server web condiviso, la CLI web e gli script comuni, mentre gli script di automazione girano su Bun [codice: packages/desktop/package.json:1].

In sintesi è una divisione più netta di quella di Topics: backend Rust fuori dal repository contro server Bun dentro il monorepo, Electron contro guscio Tauri.

## Sessioni e task

Le conversazioni sono organizzate per progetto, con fork, menzioni di file e sessioni, slash command e una coda visibile dei comandi in attesa [codice: packages/desktop/src/renderer/components/chat/CommandQueuePanel.tsx:1].

Esistono viste guidate per la creazione delle conversazioni e stati di attesa espliciti quando l'agente ragiona [codice: packages/desktop/src/renderer/components/chat/ThoughtDisplay.tsx:1].

Al posto della kanban di Topics ci sono i team: gruppi di membri agente con un leader fisso, istanze parallele dello stesso assistente e una fase di warmup che avvia i runtime e inietta l'ambiente di collaborazione.

Per non confondere i parlanti, ogni istanza ha un colore di identità stabile legato al suo slot, usato su capsule, bordi e nomi [doc: https://github.com/iOfficeAI/AionUi/blob/c140550d04e44f3d6f8a9830b40ae56e4689a977/docs/prds/teams/team-runtime-experience.md].

Le automazioni non presidiate passano da cron, con finestra di creazione, pagina di dettaglio e libreria di scheduling [codice: packages/desktop/src/renderer/pages/cron/ScheduledTasksPage/CreateTaskDialog.tsx:1] [codice: package.json:121].

C'è un pannello di controllo versione con albero dei repository, surfacing delle worktree create a metà sessione e diff unificato aperto nel pannello di anteprima [codice: packages/desktop/src/renderer/pages/conversation/SourceControl/ScmPanel.tsx:167].

Manca invece il flusso strutturato di Topics fatto di code, tentativi, review, land e publish: la revisione qui è conversazionale, non un cancello esplicito [non verificato].

## Usabilità

Le superfici sono quattro: desktop Electron, WebUI da browser, app mobile e canali di messaggistica [doc: https://github.com/iOfficeAI/AionUi/blob/c140550d04e44f3d6f8a9830b40ae56e4689a977/docs/prds/remote/channels/channels.md].

L'onboarding è il cavallo di battaglia: l'agente integrato parte incollando una chiave API, senza installare CLI, con 21 assistenti professionali pronti e output Office modificabili [README].

Le liste lunghe usano virtualizzazione con react-virtuoso per non appesantire il rendering [codice: package.json:159].

Ci sono notifiche di fine turno su desktop e browser, input vocale con streaming, selettore di modelli e modalità per agente, scorciatoie da tastiera e temi anche via CSS personalizzato [codice: packages/desktop/src/renderer/hooks/system/notification/useDesktopTurnNotification.ts:1].

L'interfaccia è tradotta in molte lingue con chiavi i18n obbligatorie per ogni nuova stringa, pena il blocco in revisione [codice: packages/desktop/src/common/config/i18n-config.json:1].

I punti deboli segnalati dagli utenti includono controlli finestra sovrapposti in finestre strette su macOS [issue #4300], blocchi LaTeX scambiati per formule matematiche [issue #4311] e copia che fallisce nei contesti sicuri del browser [issue #4306].

## Browser e anteprima

Ha un vero browser dentro l'app, basato su `<webview>` di Electron, con tab multipli, indirizzo con ricerca, cronologia e login persistente salvato solo in locale [doc: https://github.com/iOfficeAI/AionUi/blob/c140550d04e44f3d6f8a9830b40ae56e4689a977/docs/prds/agent-browser/prd.md].

L'agente lo pilota via CDP: apre pagine, clicca, compila campi, scorre, legge contenuti e fa screenshot, e l'utente vede tutto in diretta nel pannello laterale.

Il passaggio di controllo è condiviso: l'agente apre la pagina di login, l'utente digita le credenziali nella stessa tab, poi l'agente prosegue da solo.

I tab del browser appartengono al progetto e non alla singola sessione, così cambiare conversazione non li sposta, mentre le credenziali restano globali e condivise.

Scelta notevole sul fronte prodotto: canale di controllo attivo di default per avere zero configurazione, con interruttore globale, avviso leggero al primo uso e badge di attività sul tab manovrato.

Il ponte CDP verso l'agente vive fra i server MCP integrati, con protocollo di instradamento per istanza [codice: packages/desktop/src/process/resources/builtinMcp/cdpBridge.ts:1].

Il pannello di anteprima mostra anche Markdown, HTML e documenti Office, con limiti di dimensione e controlli di refresh [codice: packages/desktop/src/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewPanel.tsx:1].

Due limiti strutturali: in modalità WebUI il browser in app non esiste, perché mancano webview e CDP, e non c'è nulla di simile al co-browse di Topics con DOM rispecchiato fra dispositivi [doc: https://github.com/iOfficeAI/AionUi/blob/c140550d04e44f3d6f8a9830b40ae56e4689a977/docs/prds/agent-browser/prd.md].

## Terminale, editor, file

Nessun terminale PTY integrato nel frontend: fra le dipendenze non risultano né node-pty né xterm, e le aperture di terminale avvengono con strumenti esterni dal pannello file [codice: package.json:78].

L'esecuzione dei comandi passa quindi dagli agenti gestiti dal backend Rust, non da un emulatore visibile all'utente: rispetto a Topics, che ha il PTY nel topic, qui è una lacuna e non una scelta documentata [non verificato].

L'editor di codice ha una configurazione centralizzata di font, dimensioni e a capo, pensata come unica fonte di verità [codice: packages/desktop/src/renderer/pages/conversation/Preview/theme/codeEditorConfig.ts:14].

La gestione file copre cartelle di lavoro recenti, selezione file anche da WebUI, anteprime per tipo MIME e segnali di aggiornamento live [codice: packages/desktop/src/renderer/components/workspace/webFsPicker.tsx:1].

Il pannello di controllo versione mostra stato, repertori e diff, con store dedicati per albero, interfaccia e trasporto [codice: packages/desktop/src/renderer/pages/conversation/SourceControl/scmStore.ts:1].

## Remoto e mobile

La modalità WebUI avvia un server web integrato: in locale di default, sulla LAN con flag apposito e anche headless su server, con porta 3000 come valore tipico [doc: https://github.com/iOfficeAI/AionUi/blob/c140550d04e44f3d6f8a9830b40ae56e4689a977/docs/guides/webui.md].

L'accesso è protetto da password di amministrazione generata al primo avvio e reimpostabile con uno script dedicato [codice: scripts/webui.ts:279].

Il registro dei processi agente nel server web tiene traccia dei backend lanciati per la sessione remota [codice: packages/web-host/src/agent-process-registry.ts:1].

I canali di messaggistica supportati includono Telegram, Slack, Discord, Lark, DingTalk e WeChat, con schede di configurazione, binding ad assistente e modello, e flusso di associazione guidato in due passi [doc: https://github.com/iOfficeAI/AionUi/blob/c140550d04e44f3d6f8a9830b40ae56e4689a977/docs/prds/remote/channels/channels.md].

Esiste una app mobile in React Native con configurazione Expo ed EAS [codice: mobile/app.config.ts:1], più guida al deploy su server e su Termux Android [doc: https://github.com/iOfficeAI/AionUi/blob/c140550d04e44f3d6f8a9830b40ae56e4689a977/docs/guides/deploy-server.md].

Nota di cautela per chi copia: in modalità team su connessioni lente la WebUI rifà troppe richieste al crescere dei membri, e pesa [issue #4120].

Cifratura oltre la password e relay via cloud non risultano documentati nel materiale letto [non verificato].

## Provider e protocolli

ACP è il protocollo principe: ogni agente esterno è un processo lanciato da comando risolto nel PATH, con handshake di capacità, e la vista di gestione mostra stato, errori di avvio e deriva di versione [codice: packages/desktop/src/renderer/utils/model/agentTypes.ts:20].

I tipi di agente coperti sono cinque: ACP, remoto, agente integrato `aionrs`, gateway OpenClaw e Nanobot [codice: packages/desktop/src/renderer/utils/model/agentTypes.ts:20].

I backend nominati nel codice e nelle issue includono Claude Code, Codex, Gemini, Antigravity, Qwen, Hermes, Cursor e opencode [issue #4290] [issue #4313].

Lato chiavi dirette supporta Anthropic, OpenAI e compatibili, Gemini anche via OAuth Google o Vertex AI, più Bedrock e gateway New API [codice: packages/desktop/src/common/utils/platformAuthType.ts:15].

MCP è pervasivo: server integrati per CDP, browser e generazione immagini, gestione dei server con importazione da JSON, capacità lette dall'handshake e monitoraggio della connessione [codice: packages/desktop/src/process/resources/builtinMcp/cdpBridge.ts:1].

Le estensioni possono contribuire agenti ACP, capacità, canali, skill, temi e parti di WebUI, con suite di test dedicata al ciclo di vita [codice: tests/e2e/specs/ext-acp.e2e.ts:1].

Il rilevamento dei modelli usa il catalogo parziale di opencode con fallback HTTP quando il backend ne restituisce uno incompleto [issue #4313].

## Performance

Il progetto dichiara attenzione sistematica: script di benchmark per avvio app e avvio sessioni ACP, report dedicati e perfino benchmark del database su Bun [codice: scripts/benchmark-startup.ts:1] [codice: scripts/benchmark-acp-startup.ts:1].

A runtime usa liste virtualizzate, throttle dei hook, chiusura nel tray e disattivazione automatica della GPU in caso di problemi [codice: packages/desktop/src/renderer/hooks/ui/useThrottle.ts:1].

Le lamentele degli utenti sono però sostanziose: lentezza generale all'apertura e uso pesante [issue #534], freeze su Windows [issue #4043] e crash di init su WSLg [issue #2767].

Casi specifici: il runtime integrato esce con SIGILL su CPU senza AVX [issue #2629], l'anello di uso contesto supera il 100 per cento perché somma i token cumulati invece del contesto reale [issue #4210], e i log di retry riversati in chat bloccano la sessione [issue #4259].

Rust nel backend aiuta su concorrenza e I/O, ma i colli di bottiglia percepiti stanno nel renderer Electron e nella gestione dei processi agente, non nel motore dati.

Nessun benchmark pubblico confrontabile è stato trovato nei documenti letti [non verificato].

## Affidabilità e qualità

Il conteggio misura 653 file di test fra unitari, integrazione ed end to end, su 1.613 file TypeScript totali.

Il framework è Vitest 4 con obiettivo di copertura all'80 per cento, e Playwright copre conversazioni, anteprime, team, canali e installazione [codice: vitest.config.ts:1] [codice: playwright.config.ts:1].

I workflow di integrazione continua sono circa sedici, fra controlli di pull request, build multipiattaforma, release e triage automatico delle issue [codice: .github/workflows/pr-checks.yml:1].

Gli aggiornamenti automatici usano electron-updater con feed CDN e diagnostica dedicata ai fallimenti di installazione [codice: packages/desktop/src/process/services/autoUpdaterService.ts:7].

Il recupero da database corrotto, i fallimenti di avvio del backend e la pulizia all'uscita sono coperti da test mirati [codice: tests/unit/process/startup/backendStartupFailure.test.ts:1].

Restano fragilità strutturali: risposte finali che a intermittenza non si mostrano [issue #4314], avvio agenti che muore su Windows per runtime integrato incompleto [issue #4310] e domande strutturate di Codex non renderizzate [issue #4312].

## Sicurezza e privacy

Le chiavi API dirette ruotano fra più valori con blacklist temporanea dei fallimenti, meccanismo utile contro i rate limit ma che allarga la superficie di segreti in memoria [codice: packages/desktop/src/common/api/ApiKeyManager.ts:18].

Gli agenti CLI esterni riusano invece il login già fatto dall'utente nei propri strumenti, senza duplicare segreti nel portachiavi dell'app.

La WebUI è protetta da password di amministrazione con stato di autenticazione verificato all'avvio [codice: scripts/webui.ts:265].

Il canale CDP che pilota il browser è solo locale e spegnibile, ma resta raggiungibile da altri programmi sulla stessa macchina per disegno dichiarato dagli autori [doc: https://github.com/iOfficeAI/AionUi/blob/c140550d04e44f3d6f8a9830b40ae56e4689a977/docs/prds/agent-browser/prd.md].

I permessi sono granulari per agente con alias di modalità permissive, anche se su Windows alcuni hook forzano di fatto la modalità automatica totale [issue #4317] e in team i consensi ripetuti logorano l'attenzione [issue #4316].

La telemetria via Sentry si attiva solo se il DSN è impostato in ambiente, altrimenti il report di avvio viene saltato [codice: packages/desktop/src/sentry.ts:485].

Le porte esposte sono la 3000 della WebUI e la 9230 del CDP di sviluppo, entrambe solo locali di default [doc: https://github.com/iOfficeAI/AionUi/blob/c140550d04e44f3d6f8a9830b40ae56e4689a977/docs/guides/cdp.md].

## Estendibilità

Il sistema di estensioni contribuisce tab di impostazioni renderizzate in isolamento, agenti, capacità, MCP, skill, temi, canali e parti di WebUI [codice: packages/desktop/src/renderer/pages/settings/ExtensionSettingsPage.tsx:22].

Le skill sono importabili con hub di ricerca, anteprima dei file, parser dei suggerimenti e directory native dichiarate per agente [codice: packages/desktop/src/process/services/skills/index.ts:1].

Gli hook pre strumento sono configurabili per agente, anche se con bug di escaping su Windows [issue #4317].

La selezione degli strumenti MCP per assistente è richiesta dagli utenti ma non ancora presente, e pesa su chi ha molti server [issue #4302].

Le convenzioni per contributori sono severissime e verificate in CI: confini di processo, niente testo fuori da i18n, componenti solo dalla libreria designata e copertura di test sulle modifiche [codice: AGENTS.md:20].

## Da prendere per Topics

1. Vista di gestione agenti con health check e deriva di versione: mostra per ogni backend se il comando esiste nel PATH, se l'handshake riesce e se la CLI è più vecchia o nuova di quella verificata [codice: packages/desktop/src/renderer/utils/model/agentTypes.ts:208]. Per Topics significherebbe diagnosi immediata quando l'output di `claude -p` o Codex cambia.
2. Browser in app pilotato con presa di controllo condivisa: l'utente completa il login e l'agente prosegue, con badge di attività e avviso al primo uso [doc: https://github.com/iOfficeAI/AionUi/blob/c140550d04e44f3d6f8a9830b40ae56e4689a977/docs/prds/agent-browser/prd.md]. È il pezzo di interazione che manca al co-browse di Topics.
3. Canali di messaggistica come superficie remota: schede di configurazione per Telegram e affini con binding ad assistente e modello [doc: https://github.com/iOfficeAI/AionUi/blob/c140550d04e44f3d6f8a9830b40ae56e4689a977/docs/prds/remote/channels/channels.md]. Per Topics sarebbe accesso da telefono senza scrivere una app.
4. Rotazione chiavi con blacklist temporanea sui rate limit [codice: packages/desktop/src/common/api/ApiKeyManager.ts:25]. Meccanismo piccolo e copiabile per il motore nativo di Topics.
5. Anello di uso contesto nell'interfaccia chat [codice: packages/desktop/src/renderer/components/agent/ContextUsageIndicator.tsx:1]. Utile, ma calcolandolo sul contesto reale e non sui token cumulati, che è l'errore che loro hanno commesso [issue #4210].
6. Contribuzioni delle estensioni alle impostazioni via tab isolate in iframe [codice: packages/desktop/src/renderer/pages/settings/ExtensionSettingsPage.tsx:22]. Darebbe a Topics un punto di estensione UI senza toccare il core.
7. Diagnostica di installazione e avvio con codici di errore azionabili, più recupero da database corrotto, entrambi coperti da test [codice: packages/desktop/src/process/services/installerLastFailure.ts:1]. Riduce i ticket da installazione rotta.
8. Benchmark di avvio e di sessione agente eseguiti da script versionati [codice: scripts/benchmark-startup.ts:1]. Darebbe a Topics una barra di performance misurabile invece che percepita.

## Da evitare

1. Backend binario da repository separato: sdoppia versionamento e diagnosi, e gli utenti Windows pagano runtime integrati incompleti che uccidono gli agenti all'avvio [issue #4310]. Topics con server Bun nel monorepo sta meglio.
2. CDP sempre attivo di default senza secret verso altri processi locali: comodo ma la minaccia è documentata dagli stessi autori nel PRD [doc: https://github.com/iOfficeAI/AionUi/blob/c140550d04e44f3d6f8a9830b40ae56e4689a977/docs/prds/agent-browser/prd.md]. Se copiato, prevedere secret per il canale o socket con permessi stretti.
3. Prompt passati come argomenti di riga di comando: su Windows si sbatte contro il limite di 32.767 caratteri e lo spawn fallisce [issue #4294]. Usare stdin o file temporanei, mai argv.
4. Hook di permessi fragili su Windows che spingono gli utenti verso la modalità totalmente automatica [issue #4317]. Un controllo di sicurezza che si rompe e invita a disattivarlo è peggio di niente.
5. Log di retry riversati nella cronologia chat fino a bloccare la sessione [issue #4259]. Tenere telemetria e trascrizione su canali separati.
6. Riuso delle credenziali CLI degli agenti esterni senza chiarezza su consenso e revoca: comodo, ma Topics dovrebbe dichiarare cosa tocca e come staccare la spina.

## Fonti

* Repository: https://github.com/iOfficeAI/AionUi (clone allo SHA c140550d04e44f3d6f8a9830b40ae56e4689a977)
* Backend Rust: https://github.com/iOfficeAI/AionCore
* Release: https://github.com/iOfficeAI/AionUi/releases (v2.2.2 del 9 settembre 2026)
* Guide WebUI, CDP e deploy nel clone, cartella docs/guides
* PRD browser in app, cartella docs/prds/agent-browser
* PRD team, cartella docs/prds/teams
* PRD canali remoti, cartella docs/prds/remote/channels
* Issue citate: #534, #2629, #2767, #4043, #4056, #4120, #4210, #4259, #4290, #4294, #4296, #4300, #4302, #4310, #4311, #4312, #4313, #4314, #4316, #4317
