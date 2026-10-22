# Superset

## In tre righe

Superset è un'app desktop che fa girare Claude Code, Codex e altri agenti CLI in workspace paralleli, ognuno con terminali, diff viewer e browser integrato.

Punta a chi lavora con più agenti insieme e vuole rivedere patch, anteprime e PR senza uscire dall'app.

Il suo punto più forte rispetto a Topics è il Design Mode: selezioni un elemento nella preview e lo mandi all'agente con DOM, stili e screenshot.

## Identità

Repository `superset-sh/superset`, circa 15.187 stelle e 1.352 fork al giorno del clone [non verificato, via API GitHub].

Issue aperte circa 964, segno di uso reale e di un arretrato consistente [non verificato, via API GitHub].

Licenza Elastic 2.0: uso, fork, modifica e self-host permessi, rivendere Superset come servizio no [README].

Ultimo commit il 2026-10-14, SHA `3cdc1e2e176cc6fddd5344b5ef3926f821cd2029`, messaggio su docs e PR [#8512] [non verificato, da `git log` locale].

Release desktop `v1.38.0` pubblicata il 2026-10-14, con canary e CLI a cadenza quasi giornaliera [release v1.38.0].

Progetto giovane, repo creato a ottobre 2025, ma con ritmo maturo: changelog vivo e docs versionate [non verificato, da API GitHub] [README].

App firmata per macOS Apple Silicon e Intel, Linux sperimentale via AppImage, Windows assente [README].

Piattaforme: desktop Electron come superficie principale, più web, CLI, SDK e app iOS [README].

Il desktop è gratis per sempre, a pagamento solo servizi opzionali sopra [README].

## Architettura

Monorepo Bun con Turborepo: app in `apps/` e pacchetti in `packages/`, con tRPC per le API [codice: package.json:66].

Le app sono desktop, api, web, mobile, relay, realtime, gate, review-host, usercontent, marketing e docs [codice: package.json:66].

I pacchetti includono host-service, pty-daemon, mcp, trpc, db, local-db, sdk, cli, chat e sandbox [codice: package.json:66].

Linguaggi misurati via API GitHub: TypeScript 85,1%, HTML 7,9%, MDX 5,1%, poi Shell, Swift e CSS [non verificato, statistiche linguaggi GitHub].

Lo Swift sta nei moduli nativi iOS dell'app Expo, non nel desktop [codice: apps/mobile/modules/attachments-sheet/ios/AttachmentsSheetModule.swift:1].

Niente Rust o Go nel prodotto: il nativo è un addon Node per le metriche di processo su macOS [codice: packages/macos-process-metrics/package.json:1].

Il desktop è Electron con renderer React, main process TypeScript e build `electron-vite` [codice: apps/desktop/package.json:1].

La logica pesante vive fuori dal renderer: `host-service` gestisce workspace e terminali come client [codice: packages/pty-daemon/README.md:1].

`pty-daemon` possiede le PTY su Unix socket e sopravvive a restart e upgrade del binario tramite fd-handoff [codice: packages/pty-daemon/README.md:1].

Il daemon gira su Node di Electron, non su Bun, per incompatibilità verificate fra Bun e node-pty [codice: packages/pty-daemon/README.md:18].

Storage con Drizzle ORM, database locale via `local-db` e stack Postgres con proxy e Redis via Docker per lo sviluppo [codice: packages/local-db/package.json:1] [README].

Il relay remoto ha configurazione di deploy per Workers [non verificato, solo nome file visto in listing].

Con gli agenti parla in tre modi: processi CLI nelle sue PTY, protocolli ACP e hook di stato [doc: https://docs.superset.sh/agent-integration].

Le dipendenze desktop includono i pacchetti ACP di Claude e Codex [codice: apps/desktop/package.json:39].

Ogni utente usa i propri abbonamenti agenti, il server non centralizza le chiavi dei modelli [README].

## Sessioni e task

Il workspace è l'unità di lavoro: checkout git isolato con branch, terminali e porte proprie [README].

I worktree separano i file ma non isolano i processi né evitano i conflitti di merge [README].

Si lavora in parallelo, si confrontano due approcci allo stesso problema e si tiene il migliore [README].

Setup e teardown sono script versionati in `.superset/config.json` per workspace [README].

Le automazioni schedulano sessioni agenti con ricorrenze RRULE, per esempio triage notturno [README].

I task esistono come API con stati, gestibili anche via MCP con strumenti dedicati [doc: https://docs.superset.sh/mcp-server].

Non risulta una board kanban visuale: la navigazione docs elenca Tasks, non board [doc: https://docs.superset.sh/mcp-server].

Review significa diff viewer integrato, commenti sulle righe di una PR e rimando del feedback a un agente [README].

La pubblicazione del feedback su GitHub resta opzionale [README].

CI propria ampia: workflow per build desktop e CLI, release canary, e2e mobile, sandbox e triage [codice: .github/workflows/ci.yml:1].

## Usabilità

Superfici: desktop, web, CLI, SDK TypeScript, MCP e iPhone partono dagli stessi workspace [README].

Flussi guida curati: prima sessione parallela, race fra agenti, fan-out di un refactor, audit notturno [doc: https://docs.superset.sh/agent-integration].

Diff viewer con commenti, commit e push senza uscire dall'app [README].

Notifiche con suoni, badge sul dock e indicatori di stato nella sidebar [README].

Command palette unica per workspace, azioni e impostazioni [README].

Scorciatoie interamente rimappabili da interfaccia [README].

Temi custom costruibili e importabili come file [README].

Preset di terminali per layout di agenti e shell apribili con un tasto [README].

Onboarding con login dev locale senza credenziali di terze parti [README].

Setup minimo: basta Git, `gh` opzionale e proposto dall'app stessa [README].

Internazionalizzazione con Lingui e README tradotto in 17 lingue [README].

Integrazioni Slack e Linear che aprono workspace da messaggi e issue [README].

## Browser e anteprima

Il pannello browser è integrato nell'app, con cronologia locale e DevTools affiancato [doc: https://docs.superset.sh/browser].

Rilevamento porte per workspace: clicchi la porta nella sidebar e si apre nella tab [doc: https://docs.superset.sh/browser].

Il pezzo distintivo è il Design Mode con selettore di elementi dentro la pagina [doc: https://docs.superset.sh/browser].

Clicchi un elemento e si apre una scheda sotto di esso per descrivere la modifica [doc: https://docs.superset.sh/browser].

L'agente riceve DOM dell'elemento, stili computati, metadati React e screenshot ritagliato [doc: https://docs.superset.sh/browser].

Funziona su qualunque pagina carichi nel pannello, incluso il dev server locale [doc: https://docs.superset.sh/browser].

L'agente pilota il pannello via CLI con verbi di apertura, lettura, screenshot e console [doc: https://docs.superset.sh/browser].

Per interazioni complete esiste un endpoint CDP grezzo per client tipo Playwright, limitato a quel pannello [doc: https://docs.superset.sh/browser].

Una skill dedicata istruisce gli agenti a chiedere consenso prima di azioni consequenziali [doc: https://docs.superset.sh/browser].

Niente co-browse fra dispositivi alla Topics: da remoto vedi l'intero workspace via relay [doc: https://docs.superset.sh/remote-access].

La condivisione di artefatti passa dalle Pages pubblicate e commentabili dal team [README].

Nota tecnica: il pannello usa tag webview nativi, con difetti noti di sovrapposizione dei popover [issue #7260].

## Terminale, editor, file

Terminale integrato con tab, split infiniti e preset salvati [README].

Sessioni persistenti che sopravvivono ai restart dell'app [README].

Editor di prompt richiamato con scorciatoia, con editing multilinea e menzioni di file [README].

Sotto usa xterm con patch dedicate a IME, debouncing del render e flush [codice: apps/desktop/src/xterm-ime-patch.test.ts:1].

L'editor file usa CodeMirror come dipendenza desktop [codice: apps/desktop/package.json:46].

Esiste pagina docs dedicata a editor e file [doc: https://docs.superset.sh/editor].

Handoff agli IDE esterni con un clic per chi preferisce Cursor o VS Code [README].

I file di un repo grande sono un punto dolente noto [issue #5320].

La vista file scandaglia l'albero con avidità e su cartelle non ignorate arriva a OOM del renderer [issue #5320].

I terminali che non rispondono e i daemon irraggiungibili dopo restart sono fra le lamentele [issue #7926] [issue #7469].

## Remoto e mobile

Accesso remoto via Superset Relay, con toggle nel desktop oppure host dedicato da CLI [doc: https://docs.superset.sh/remote-access].

Comando tipico sull'host: login e avvio del server in background con registrazione al relay [doc: https://docs.superset.sh/remote-access].

Setup di un host anche over SSH da terminale integrato, con prompt interattivi gestiti [doc: https://docs.superset.sh/remote-access].

La docs raccomanda una macchina separata con solo i repo da condividere, perché il relay espone file, terminali e run [doc: https://docs.superset.sh/remote-access].

Da iPhone e iPad si continuano sessioni, si mandano prompt e si mergiano PR [README].

Il mobile richiede piano Pro e iOS 26 o superiore [README].

Le porte dei workspace remoti vengono inoltrate sulla macchina locale, solo TCP [doc: https://docs.superset.sh/remote-access].

Una sola workspace alla volta riceve l'inoltro, con gestione dei conflitti di porta locale [doc: https://docs.superset.sh/remote-access].

Connessione diretta LAN o Tailscale senza relay è richiesta ma non presente [issue #5360].

Spegnere l'accesso interrompe terminali e lavoro sull'host [doc: https://docs.superset.sh/remote-access].

I membri del team ricevono accesso agli host su invito, con ruoli e rimozione [doc: https://docs.superset.sh/remote-access].

## Provider e protocolli

Agenti pienamente supportati: Claude Code, Codex, OpenCode, Gemini CLI, Cursor, Copilot, Amp e altri [README].

La tabella ufficiale elenca oltre venti agenti più un generico senza configurazione [README].

Agenti custom aggiungibili con comando, trasporto del prompt e argomenti di resume e fork [doc: https://docs.superset.sh/agent-integration].

Chat integrata con model picker e controllo del livello di reasoning [doc: https://docs.superset.sh/agent-integration].

Provider BYO per OpenRouter, Bedrock, Vertex e Vercel AI Gateway [README].

MCP server pubblico con OAuth 2.1 a scope di organization [doc: https://docs.superset.sh/mcp-server].

Chiavi API dedicate per ambienti headless e pipeline [doc: https://docs.superset.sh/mcp-server].

Il server MCP espone task, workspace, agenti, terminali, pagine, automazioni, progetti, host e membri [doc: https://docs.superset.sh/mcp-server].

Le pagine pubblicate dagli agenti sono HTML autonomi versionati con commenti gestibili via MCP [doc: https://docs.superset.sh/mcp-server].

Skill ufficiali per CLI e MCP installabili negli agenti [doc: https://docs.superset.sh/agent-integration].

Plugin di marketplace che arrivano agli agenti come proxy MCP senza spedire codice [codice: docs/plugins.md:1].

## Performance

Benchmark pubblici dichiarati: nessuno trovato [non verificato].

Le issue raccontano il costo dell'architettura a processi [issue #4198].

Input lag da eccesso di sottoprocessi git su tutti i workspace aperti [issue #4198].

Fix puntuali proposti: status senza untracked e watcher limitati ai workspace aperti [issue #6004] [issue #6729].

Renderer inchiodato oltre il 100% di CPU dopo giorni di uptime [issue #5921].

Consumi massicci da rendering segnalati anche in forma generica [issue #6822].

Sidebar che scala col numero di workspace e blocca la digitazione [issue #8108].

Circa 19 processi brevi ogni 2,5 secondi in proporzione ai worktree [issue #6717].

Su Linux, switch di workspace che ricrawlano l'albero fino a centinaia di migliaia di watcher [issue #7877].

Pannello Changes congelato oltre 10 secondi al mount su dataset grandi [issue #5521].

Lati positivi: patch al terminale xterm e documenti interni di fix dell'input lag [codice: apps/desktop/src/xterm-ime-patch.test.ts:1].

Il pty-daemon evita di toccare le shell durante gli upgrade del servizio host [codice: packages/pty-daemon/README.md:1].

## Affidabilità e qualità

Test co-locati accanto ai componenti per convenzione di repo [codice: packages/pty-daemon/README.md:1].

Conteggio diretto su `git ls-files`: 1.320 file di test più 13 suite Node-only per PTY vere [non verificato, misura locale].

CI con workflow separati per desktop, CLI, canary, mobile e sandbox [codice: .github/workflows/ci.yml:1].

Gli aggiornamenti dell'app azzerano le sessioni secondo una segnalazione [issue #7977].

Il servizio host smette di rispondere sotto carico con WAL SQLite mai consolidato [issue #7426].

Un host morto non viene mai rilanciato automaticamente [issue #5503].

Il relay non ristabilito dopo restart sporco lascia l'host invisibile fino al riavvio [issue #5275].

Host-service canary con leak di processo e CPU al 90% fino al freeze [issue #6610].

Recupero sessioni agente con resume e fork espliciti per handoff fra agenti [doc: https://docs.superset.sh/agent-integration].

## Sicurezza e privacy

Default privato con connessioni esplicite scelte dall'utente [README].

Gli agenti girano con gli abbonamenti CLI dell'utente, nessun uso di credenziali condivise [README].

MCP con OAuth 2.1 e chiavi dedicate da custodire fuori dal versionamento [doc: https://docs.superset.sh/mcp-server].

Le chiavi garantiscono accesso pieno all'organization di chi le crea [doc: https://docs.superset.sh/mcp-server].

Accesso a file fuori workspace solo con approvazione inline in chat [doc: https://docs.superset.sh/agent-integration].

Porte inoltrate da trattare come servizi remoti, non localhost, perché trasportano auth [doc: https://docs.superset.sh/remote-access].

Telemetria con Sentry e rate-limit dedicato agli eventi di renderer non responsivo [issue #6701].

Policy di disclosure privata via advisory GitHub o email, con ack in 3 giorni lavorativi [codice: SECURITY.md:1].

Solo l'ultima release riceve fix di sicurezza [codice: SECURITY.md:43].

Resta il nodo fiducia: il relay vede transitare terminali e file [doc: https://docs.superset.sh/remote-access].

La licenza Elastic vieta di rivendere Superset come servizio, non di studiarlo [README].

## Estendibilità

MCP completo e bidirezionale: agenti esterni creano workspace e lanciano sessioni da soli [doc: https://docs.superset.sh/mcp-server].

Skill precaricate al lancio per orchestrare agenti paralleli e diagnosticare problemi [README].

CLI a binario singolo e SDK TypeScript per script e automazioni [README].

Script di lifecycle per progetto e script di terminale riusabili [README].

Temi custom costruibili e importabili come file [README].

Integrazioni Slack e Linear che aprono workspace da messaggi e issue [README].

Un plugin è solo manifest e skill: niente codice spedito [codice: docs/plugins.md:7].

I tool dei plugin arrivano dal vendor via proxy MCP oppure da server ospitati da Superset [codice: docs/plugins.md:13].

Le release dei plugin sono tag git verificati in CI [codice: docs/plugins.md:20].

## Da prendere per Topics

1. Design Mode elemento verso agente: selettore nel pannello e invio di DOM più stili più screenshot a sessione esistente o nuova [doc: https://docs.superset.sh/browser]. Conterebbe perché Topics pilota già il browser ma senza scorciatoia visiva per il feedback puntuale.
2. Endpoint CDP per singolo pannello più verbi CLI di lettura e screenshot con skill dedicata [doc: https://docs.superset.sh/browser]. Darebbe agli agenti Topics un'interfaccia browser standard senza esporre l'intera app.
3. PTY che sopravvivono a restart e upgrade via daemon separato e fd-handoff [codice: packages/pty-daemon/README.md:1]. Topics gira come servizio launchd: la stessa separazione ridurrebbe la perdita di sessioni agli aggiornamenti.
4. Rilevamento porte per workspace con apertura diretta nel pannello e inoltro su host remoti [doc: https://docs.superset.sh/browser] [doc: https://docs.superset.sh/remote-access]. Topics ha un solo pannello browser: l'associazione porta verso topic e il modello da copiare.
5. Feedback su righe di diff o PR rimandato a un agente, con pubblicazione su GitHub opzionale [README]. È il pezzo di review mancante fra kanban Topics e merge.
6. Configurazione agente generica con comando, trasporto prompt, resume e fork invece di integrazioni hardcoded [doc: https://docs.superset.sh/agent-integration]. Topics parla con tre CLI: questo schema regge il quarto senza codice nuovo.
7. Automazioni schedulate con RRULE e run on demand via MCP [doc: https://docs.superset.sh/mcp-server]. La board Topics lancia agenti da sola: la schedulazione è il passo successivo naturale.
8. Notifiche di completamento con suoni e badge dock quando serve attenzione [README]. La kanban autonoma di Topics ne ha bisogno più di Superset.
9. Scorciatoie interamente rimappabili da impostazioni [README]. Costo basso, resa alta per uso iPad e tastiera.

## Da evitare

Git come fonte di lag: sottoprocessi per workspace e watcher su tutto sono l'errore documentato da non ripetere [issue #4198] [issue #6729].

Status con untracked che costa decine di volte il necessario [issue #6004].

Vista file che scandaglia l'albero prima di mostrare qualcosa, fino a OOM [issue #5320].

Stato locale a crescita illimitata per workspace archiviati [issue #8106].

Aggiornamenti che azzerano le sessioni [issue #7977].

Host che non si ri-registra al relay e resta invisibile [issue #8445].

Processi orfani che girano al 90% di CPU dopo update canary [issue #6610].

Race sul refresh token fra comandi paralleli che slogga tutti gli agenti [issue #8426].

Supporto Linux lasciato indietro mentre macOS corre [issue #405].

Licenza Elastic 2.0: si può leggere e descrivere, non riusare codice oltre brevi citazioni [README].

## Fonti

- https://github.com/superset-sh/superset, SHA `3cdc1e2e176cc6fddd5344b5ef3926f821cd2029`
- https://github.com/superset-sh/superset/blob/3cdc1e2e176cc6fddd5344b5ef3926f821cd2029/README.md
- https://github.com/superset-sh/superset/blob/3cdc1e2e176cc6fddd5344b5ef3926f821cd2029/packages/pty-daemon/README.md
- https://github.com/superset-sh/superset/blob/3cdc1e2e176cc6fddd5344b5ef3926f821cd2029/docs/plugins.md
- https://github.com/superset-sh/superset/blob/3cdc1e2e176cc6fddd5344b5ef3926f821cd2029/SECURITY.md
- https://github.com/superset-sh/superset/blob/3cdc1e2e176cc6fddd5344b5ef3926f821cd2029/apps/desktop/package.json
- https://docs.superset.sh/browser
- https://docs.superset.sh/remote-access
- https://docs.superset.sh/agent-integration
- https://docs.superset.sh/mcp-server
- https://docs.superset.sh/skills
- https://docs.superset.sh/editor
- Release desktop-v1.38.0 del 2026-10-14, via `gh release list -R superset-sh/superset`
- Issue #405, #4198, #5320, #5360, #5503, #5521, #5921, #6004, #6185, #6610, #6701, #6717, #6729, #6822, #7260, #7426, #7469, #7877, #7926, #7977, #8106, #8108, #8426, #8445
