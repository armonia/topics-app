# CloudCLI

## In tre righe

CloudCLI (già Claude Code UI) è un'interfaccia web e desktop per pilotare da ovunque le sessioni di Claude Code, Codex, Cursor CLI e OpenCode [README].
È pensata per chi lavora da telefono o da un secondo dispositivo e vuole ritrovare progetti, chat, terminale e git senza SSH.
Il suo punto più forte rispetto a Topics è l'accesso remoto maturo (LAN, cloud gestita, push) unito al browser Playwright pilotato dall'agente via MCP [codice: server/modules/browser-use/browser-use.service.ts:18].

## Identità

Repository `siteboon/claudecodeui`, homepage commerciale `https://cloudcli.ai`, descrizione ufficiale: interfaccia gratuita e open source per gestire sessioni e progetti da mobile e web [README].
Circa 14.089 stelle al 14 ottobre 2026 [doc: https://github.com/siteboon/claudecodeui].
Licenza `AGPL-3.0-or-later` [codice: package.json:141].
Ultimo commit `7c3049f` del 9 ottobre 2026, release `v1.37.4` della stessa data [release v1.37.4].
Cadenza rapida: quattro release fra il 13 agosto e il 9 ottobre 2026 (`v1.37.1`, `v1.37.2`, `v1.37.3`, `v1.37.4`) [release v1.37.1].
Progetto maturo e molto attivo, nato a giugno 2025, aggiornato al giorno della rilevazione.
Piattaforme: web self hosted con `npx`, Docker con microVM di sandbox, app desktop Electron per macOS e Windows, offerta cloud gestita [README].

## Architettura

Monorepo TypeScript senza Rust né Go: circa 98.156 righe di `.ts`, 50.493 di `.tsx`, 8.070 di `.js`, più 54.677 di `.json` e 8.402 di markdown, misurati con `wc -l` sui file tracciati (totale 1.050 file, 834 sorgenti fra ts, tsx e js).
Il server è Express su Node con WebSocket in `ws`, persistenza in `better-sqlite3` [codice: package.json:166].
Il client è React 18 con Vite, Tailwind, CodeMirror e xterm [codice: package.json:157].
Il desktop è Electron con finestra nativa, tray e deep link su schema `cloudcli://` [codice: package.json:85].
Il modello dei processi è semplice: un solo processo Node serve API, WebSocket e statici sulla porta 3001, i plugin girano come processi figli su porte effimere e vengono proiettati via proxy WebSocket [codice: server/index.ts:281].
Con l'agente parla in quattro modi diversi, scelti da un dispatcher di runtime [codice: server/modules/providers/services/provider-runtime.service.ts:42].
Claude passa dal SDK ufficiale con la funzione `query` [codice: server/modules/providers/list/claude/claude-runtime.provider.js:20].
Codex passa dal SDK ufficiale con la classe `Codex` [codice: server/modules/providers/list/codex/codex-runtime.provider.ts:14].
Cursor viene lanciato come CLI in stream JSON con `cross-spawn`, ripresa con `--resume` e scelta del modello [codice: server/modules/providers/list/cursor/cursor-runtime.provider.js:66].
OpenCode viene lanciato come CLI con `cross-spawn` e gli eventi vengono normalizzati da un provider dedicato [codice: server/modules/providers/list/opencode/opencode-sessions.provider.ts:203].
Il terminale remoto usa `node-pty` lato server e xterm lato client [codice: server/modules/websocket/services/shell-websocket.service.ts:5].
Lo storage è SQLite locale con tabelle per sessioni, modelli dei provider, bozze, messaggi schedulati, utenti e chiavi [codice: server/modules/database/schema.ts:123].
Le sessioni vengono indicizzate anche osservando i database dei provider su disco [codice: server/modules/providers/services/sessions-watcher.service.ts:27].

## Sessioni e task

Le sessioni parallele usano git worktree veri, con servizi separati per creare, elencare, aprire, rimuovere e fondere [codice: server/modules/worktrees/services/worktree-merge.service.ts:35].
La fusione supporta squash oppure no fast forward con messaggio, rifiuta la fusione del worktree principale su sé stesso e in caso di conflitto abortisce e ripristina con `reset --merge` [codice: server/modules/worktrees/services/worktree-merge.service.ts:88].
Non c'è una kanban globale né un sistema di code con tentativi automatici: il modulo worktree non contiene code, retry o CI.
La revisione esiste come conteggio dei task e come creazione assistita di branch e pull request dal modulo agent [codice: server/modules/agent/agent.routes.ts:1215].
I messaggi schedulati permettono invii differiti con dispatcher dedicato [codice: server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts:1].
Le bozze di sessione permettono di iniziare a scrivere da un dispositivo e continuare da un altro [codice: server/modules/database/schema.ts:183].
Manca quindi l'orchestrazione autonoma che Topics ha: niente coda che lancia agenti da sola, niente land con merge automatico sorvegliato, niente publish.

## Usabilità

Superfici: web responsive per desktop, tablet e mobile, app Electron, nessuna TUI [README].
L'onboarding è guidato con scelta dei quattro provider e configurazione git iniziale [codice: src/modules/onboarding/Onboarding.tsx:100].
Il login ai provider avviene da modale integrata senza uscire dall'app [codice: src/modules/provider-auth/ProviderLoginModal.tsx:46].
La chat ha transcript in tempo reale, la palette dei comandi cerca fra chat, file e commit [codice: src/modules/command-palette/CommandPalette.tsx:76].
Il pannello git mostra explorer, diff, confronto fra branch e cronologia [codice: src/modules/git-panel/GitDiffViewer.tsx:32].
L'editor è CodeMirror con salvataggio da tastiera, il terminale è xterm con addon per fit, clipboard e link [codice: src/modules/shell/hooks/useShellTerminal.ts:3].
Le notifiche push usano Web Push con VAPID e service worker [codice: server/modules/notifications/vapid-keys.service.ts:18].
La documentazione è tradotta in otto lingue oltre l'inglese, segnale di base utenti internazionale [doc: https://github.com/siteboon/claudecodeui/tree/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/docs].

## Browser e anteprima

Ha un browser integrato basato su Playwright con Chromium, pensato per essere pilotato dall'agente e non come anteprima statica di file [codice: server/modules/browser-use/browser-use.service.ts:555].
Il contesto è persistente sotto `~/.cloudcli/browser-use/profiles`, con screenshot JPEG esposti come data URL, viewport e cursore visibili nel pannello [codice: src/modules/browser-use/BrowserUsePanel.tsx:23].
È esposto agli agenti come server MCP con strumenti di screenshot e interazione [codice: server/modules/browser-use/browser-use-mcp.ts:89].
Limiti prudenti: massimo tre sessioni per proprietario, scadenza dopo 30 minuti, disabilitato di default, solo il proprietario `agent` può crearle [codice: server/modules/browser-use/browser-use.service.ts:18].
Non c'è nulla di simile al co browse di Topics: nessuna rispecchiamento del DOM fra dispositivi, la mappa delle sessioni vive in memoria senza sincronizzazione.
Le issue mostrano i costi della scelta: snapshot vuoti e crash senza font di sistema, screenshot che gonfiano ogni risposta MCP di circa 12mila token [issue #1568].
Altre frizioni: registrazione MCP che congela porta e percorsi al momento del toggle [issue #1489], installazione del runtime che non rileva Playwright globale [issue #1528].

## Terminale, editor, file

Il terminale è completo: PTY reale lato server, xterm con accelerazione WebGL lato client, shell standalone separata dalla chat [codice: src/modules/shell/Shell.tsx:4].
L'editor è CodeMirror con minimappa, temi e supporto per molti linguaggi [codice: package.json:158].
L'albero dei file si esplora via API REST dedicate [codice: src/shared/api.ts:179].
Il modulo git copre stato, diff, commit e pull [codice: server/modules/git/tests/git.test.ts:1].
Punti deboli noti: lo scorrimento del terminale su iPhone è scattoso per listener touch non passivi [issue #954].
Il terminale può congelarsi su mobile mentre la chat continua, per socket dimezzati mai riconnessi [issue #953].
La traversata dell'albero su radici ampie ha potuto esaurire la memoria del server [issue #1082].
Il pannello git leggeva file binari non tracciati come diff di testo, con banda e memoria alle stelle [issue #1025].

## Remoto e mobile

È il suo territorio migliore. Il server self hosted espone la LAN con URL accessibile dal telefono, con interruttore dedicato nell'app desktop [codice: electron/main.js:340].
L'offerta cloud gestita promette accesso da qualsiasi dispositivo senza VPN [README].
Le notifiche arrivano via Web Push anche a tab chiusa, più notifiche desktop native [codice: server/modules/notifications/services/notification-orchestrator.service.js:1].
Manca però un tunnel ufficiale per l'accesso remoto al self hosted: il portal tunnel è solo una richiesta di funzionalità [issue #1575].
Topics, che punta alla LAN senza cloud, può osservare come CloudCLI combina LAN locale e cloud opzionale senza imporre l'una o l'altra.
La sincronia cross dispositivo delle bozze è un dettaglio copiabile subito [codice: server/modules/database/schema.ts:183].

## Provider e protocolli

Supporta quattro provider: Claude Code, Cursor CLI, Codex e OpenCode [codice: src/shared/types.ts:8].
Niente Gemini nativo nel tipo provider, a differenza di quanto la descrizione marketing potrebbe suggerire [non verificato].
Per Claude riusa le credenziali della CLI locale con priorità al rilevamento di `claude --version` [codice: server/modules/providers/list/claude/claude-auth.provider.ts:37].
Per Codex legge il file OAuth o la chiave API esistente [codice: server/modules/providers/list/codex/codex-auth.provider.ts:49].
Per OpenCode riusa versione e file di autenticazione locali [codice: server/modules/providers/list/opencode/opencode-auth.provider.ts:32].
Il supporto MCP copre server in `stdio` e `http`, con lettura delle configurazioni utente e di progetto [codice: server/modules/providers/services/mcp.service.ts:1].
Le skill dei provider si gestiscono da interfaccia dedicata [codice: src/modules/skills/ProviderSkills.tsx:209].
Gli slash command di progetto sono disponibili nel composer [codice: src/shared/hooks/useProjectSlashCommands.ts:1].
La voce è un proxy verso API compatibili con OpenAI per dettatura e sintesi [codice: server/modules/voice/voice.service.ts:25].
Nessuna directory `hooks` nel server: l'estendibilità passa da plugin, MCP e skill, non da hook di sistema.

## Performance

Dichiarano una scelta consapevole: niente virtualizzatore, finestra iniziale di 100 messaggi, pagine da 20, righe pigre con `IntersectionObserver`, `content-visibility: auto` e cache con `WeakMap` [doc: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/docs/architecture/04-message-store-and-lazy-loading.md].
Il transcript del server vive in cache LRU da 256 MB e 8 voci, lo streaming scarica ogni 100 ms, le tab nascoste non richiedono dati [doc: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/docs/architecture/04-message-store-and-lazy-loading.md].
Le lamentele storiche raccontano il rovescio: sessioni grandi lentissime [issue #126], risposte lentissime in chat [issue #263], cambio progetto lento [issue #540].
Restano aperti: ripresa lenta con molte immagini nella cronologia [issue #1063], immagini base64 di Codex che bloccano la sessione [issue #1099], chat con screenshot che congela Safari [issue #1471].
Sul lato server: traversata file senza limiti che esauriva la memoria [issue #1082], diff binari che causavano OOM [issue #1025].
Niente Rust per la velocità: tutto il lavoro pesante è Node con ripiego su `ripgrep` impacchettato per la ricerca [codice: package.json:159].

## Affidabilità e qualità

Circa 197 file di test fra server e client, con integrazione su database, provider, git, progetti e notifiche [codice: server/modules/database/tests/sessions.db.integration.test.ts:1].
La CI pubblica release su npm con OIDC, build desktop per macOS e Windows, immagini Docker e annunci su Discord [doc: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/.github/workflows/release.yml].
La persistenza è curata: il transcript su file è fonte di verità, niente localStorage per i messaggi, sessioni in SQLite, bozze in tabella dedicata [doc: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/docs/architecture/04-message-store-and-lazy-loading.md].
In caso di crash o abort viene sintetizzato un messaggio di completamento [codice: server/modules/websocket/services/chat-session-writer.service.ts:119].
Gli aggiornamenti web passano da modale dedicata, il desktop si scarica dalle release [codice: src/modules/version-upgrade/VersionUpgradeModal.tsx:1].
Le issue aperte pesano: aggiornamento senza controllo di prontezza né rollback che lascia il pannello irraggiungibile [issue #1537].
Nuova chat che crea due sessioni backend e recapita il primo messaggio a entrambe [issue #1306].
Chat che perde silenziosamente il primo prompt a WebSocket aperto [issue #1452].
Sessioni incastrate dopo la ripresa di task in background interrotti [issue #1368].

## Sicurezza e privacy

L'autenticazione dell'app usa JWT con segreto generato e conservato nel database, refresh automatico a metà vita, trasporto via header Bearer o token in query [codice: server/modules/auth/auth.middleware.ts:44].
Le credenziali dei provider restano quelle locali delle CLI, riuso lecito senza intercettazione di token: legge i file esistenti invece di chiederli [codice: server/modules/providers/list/codex/codex-auth.provider.ts:49].
La sandbox usa immagini Docker dedicate per Claude e Codex [codice: server/modules/cli/sandbox.service.ts:30].
Nessuna telemetria di tracciamento trovata nel server, solo righe di documentazione sparse.
Le porte esposte sono la 3001 del server più le effimere dei plugin, passaggio da valutare con attenzione in LAN [codice: server/index.ts:354].
Problemi aperti: token rinnovato servito dalla cache del browser che slogga l'utente subito dopo il login [issue #1308].
Manca il pulsante di logout nell'interfaccia [issue #797].
Nessuna allowlist di dispositivi approvati [issue #1053].
Credenziali errate che mandano in crash l'intera app con schermata bianca [issue #1480].

## Estendibilità

I plugin sono processi server esterni con registro, installazione e proxy dedicati [codice: server/modules/plugins/plugins.service.ts:1].
Esiste un progetto starter per scriverne di nuovi [doc: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/plugins/starter/README.md].
MCP e skill si configurano per provider dall'interfaccia [codice: src/modules/mcp/McpServers.tsx:1].
I comandi slash di progetto si definiscono per repository [codice: server/modules/commands/commands.routes.ts:31].
I messaggi schedulati estendono gli agenti con promemoria e wakeup [codice: server/modules/scheduled-messages/services/scheduled-messages.service.ts:1].
La voce aggiunge dettatura e lettura ad alta voce via provider OpenAI compatibili [codice: server/modules/voice/voice.service.ts:25].
Rispetto a Topics manca un server MCP esposto agli agenti esterni: qui MCP è qualcosa che si consuma, non qualcosa che si offre.

## Da prendere per Topics

1. Bozze cross dispositivo: iniziare a scrivere su un device e continuare su un altro è una tabella e un'API, non un progetto. Si vede in [codice: server/modules/database/schema.ts:183]. Per Topics conterebbe perché il co browse Mac iPad ne beneficia subito.
2. Merge dei worktree con rollback garantito: squash o no fast forward, verifica di pulizia prima e `reset --merge` dopo. Si vede in [codice: server/modules/worktrees/services/worktree-merge.service.ts:88]. Per Topics conterebbe perché rende il land meno pauroso.
3. Strategia di rendering senza virtualizzatore: finestra da 100, pagine da 20, `content-visibility`, cache con `WeakMap`. Si vede in [doc: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/docs/architecture/04-message-store-and-lazy-loading.md]. Per Topics conterebbe perché le liste virtualizzate sono fragili su WKWebView.
4. Transcript su file come fonte di verità, zero localStorage per i messaggi. Si vede in [doc: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/docs/architecture/04-message-store-and-lazy-loading.md]. Per Topics conterebbe perché sopravvive ai crash del guscio senza sync strani.
5. Browser dell'agente dietro MCP con limiti di default: spento, tre sessioni, scadenza breve. Si vede in [codice: server/modules/browser-use/browser-use.service.ts:18]. Per Topics conterebbe come modello per esporre il WKWebView agli agenti senza aprirlo a tutti.
6. Login ai provider da modale integrata con rilevamento delle CLI installate. Si vede in [codice: src/modules/provider-auth/ProviderLoginModal.tsx:46]. Per Topics conterebbe perché l'onboarding da iPad resta il punto più debole.
7. Messaggi schedulati con dispatcher dedicato per wakeup e promemoria degli agenti. Si vede in [codice: server/modules/scheduled-messages/services/scheduled-messages.service.ts:1]. Per Topics conterebbe perché la kanban potrebbe risvegliare agenti dormienti.
8. Web Push con VAPID per notifiche a tab chiusa. Si vede in [codice: server/modules/notifications/vapid-keys.service.ts:18]. Per Topics conterebbe perché avvisare l'iPad a schermo spento oggi non si può.

## Da evitare

La registrazione MCP che congela porta e percorsi al momento del toggle, poi tutto punta alla porta sbagliata [issue #1489].
Gli aggiornamenti senza controllo di prontezza né rollback, che lasciano il pannello irraggiungibile [issue #1537].
La creazione doppia di sessioni alla prima chat, con il primo messaggio recapitato a entrambe [issue #1306].
La lettura avida di file binari come diff di testo, con OOM e banda alle stelle [issue #1025].
La traversata illimitata dell'albero dei file su radici ampie [issue #1082].
Gli screenshot che gonfiano ogni risposta MCP di migliaia di token senza riduzione [issue #1568].
Il processo Claude ucciso a ogni turno, che orfana i task in background e rompe i risvegli schedulati [issue #1113].

## Fonti

- Repository: https://github.com/siteboon/claudecodeui
- SHA del clone: `7c3049fe8e157f12b7add3e496d8d2fe6fa5c014`
- README: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/README.md
- Manifest: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/package.json
- Runtime dei provider: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/server/modules/providers/services/provider-runtime.service.ts
- Runtime Claude: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/server/modules/providers/list/claude/claude-runtime.provider.js
- Runtime Codex: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/server/modules/providers/list/codex/codex-runtime.provider.ts
- Browser dell'agente: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/server/modules/browser-use/browser-use.service.ts
- Fusione worktree: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/server/modules/worktrees/services/worktree-merge.service.ts
- Schema SQLite: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/server/modules/database/schema.ts
- Architettura dei messaggi: https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/docs/architecture/04-message-store-and-lazy-loading.md
- Release v1.37.4: https://github.com/siteboon/claudecodeui/releases/tag/v1.37.4
- Release v1.37.1: https://github.com/siteboon/claudecodeui/releases/tag/v1.37.1
