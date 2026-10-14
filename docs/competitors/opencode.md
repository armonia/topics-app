# OpenCode

## In tre righe
- OpenCode è l'agente open source di coding più usato, si presenta come "The open source AI coding agent" [README].
- Vive nel terminale (TUI), sul desktop (Electron) e sul web, con un solo server locale che espone sessioni, PTY e API.
- Il suo punto più forte rispetto a Topics: ecosistema maturo di provider (48 moduli), plugin, skill e comandi, con sessioni condivisibili via link e accesso remoto da telefono già risolti.

## Identità
- Repository `anomalyco/opencode`, circa 213.000 stelle e 28.600 fork al 14/10/2026 (API GitHub, misurazione puntuale).
- Licenza MIT, dichiarata nel manifesto del pacchetto CLI e alla radice [codice: packages/cli/package.json:8].
- Ultimo commit il 14/10/2026, fix al pannello diff del TUI [release vX.Y].
- Release latest `v1.19.0` dell'11/10/2026, con patch quasi settimanali nella serie 1.18.x: cadenza molto alta [release v1.19.0].
- Maturità alta: monorepo con oltre 40 package, decine di workflow CI, changelog curato, versione interna 2.0.29 nei package.
- Piattaforme macOS, Windows e Linux via binario Bun e app desktop Electron con target per i tre OS [codice: packages/desktop/electron-builder.config.ts:85].
- Sviluppo rapidissimo: la serie 1.18.32 arriva a 1.19.0 in circa tre settimane, con migliaia di issue aperte a testimoniare l'uso reale.

## Architettura
- Monorepo Bun quasi tutto in TypeScript: circa 900.000 righe TS/TSX in 5.094 file (misurate con `git ls-files` più `wc -l`).
- Ripartizione misurata: `packages/core` 173.000 righe, `packages/app` 178.000, `packages/tui` 107.000, `packages/ai` 80.000.
- Completano il quadro: `packages/cli` 25.000, `packages/desktop` 15.000, `packages/server` 9.000, `packages/sdk` 3.000.
- Zero Rust o Go: nessun `Cargo.toml` o `go.mod` nel repo, solo binari precompilati via npm per PTY, watcher e affini [codice: packages/cli/package.json:61].
- Framework applicativo dominante: Effect, usato anche per HTTP, SQLite e concorrenza.
- `packages/server` usa Effect `http-api` con router e OpenAPI su `/openapi.json`, servito da `node:http` [codice: packages/server/src/routes.ts:37].
- Storage SQLite via Drizzle, con schema in snake case [codice: packages/core/src/database/database.ts:3].
- Il server parte su `127.0.0.1` con porta effimera se non specificata [codice: packages/server/src/process.ts:55].
- Gli eventi viaggiano in SSE con frame `data:` separati da doppia newline [codice: packages/server/src/event-feed.ts:29].
- Il desktop è Electron 44 con `electron-vite` ed `electron-builder` [codice: packages/desktop/package.json:18].
- Struttura desktop in `src/{main,preload,renderer,shared}`, con renderer isolato via `window.electron` e MessagePort.
- Il main del desktop avvia il server come sidecar con `serve --service` e credenziali dedicate [codice: packages/desktop/src/main/service/background-service.ts:53].
- La TUI usa OpenTUI con Solid e si collega al server via HTTP con riconnessione automatica [codice: packages/tui/src/app.tsx:216].
- `packages/cli` è il binario `opencode` con handler `serve`, `default`, `acp` e `service` [codice: packages/cli/src/index.ts:72].
- `packages/sdk` è un client embedded che punta a `http://opencode.local` senza bisogno di porta.
- Con l'agente parla in process via Effect (`Session`, `SessionRunner`); i terminali passano da PTY (`bun-pty` su Bun, `node-pty` su Node) [codice: packages/core/src/pty/pty.bun.ts:2].
- Modello dei processi: demone user level registrato in `service.json`, porta default `0xc0de` (49374), adozione dell'istanza esistente su conflitto.
- Nessun launchd o systemd: il demone è gestito dal CLI stesso via file di lease [codice: packages/cli/src/services/service-config.ts:46].

## Sessioni e task
- Le sessioni nascono con `Session.make()` e persistono in uno store dedicato [codice: packages/core/src/session/session.ts:42].
- Sessioni diverse girano concorrenti; il resume dello stesso ID viene unito da un coordinatore, senza fencing distribuito.
- C'è il fork con `parentID` e gli eventi `session.forked` [codice: packages/schema/src/session.ts:33].
- Retry dei draft e retry di trasporto su socket instabili [codice: packages/core/src/session/message-updater.ts:404].
- I worktree sono nativi: lista, crea, rimuovi e refresh via handler dedicati [codice: packages/server/src/handlers/worktree.ts:14].
- Niente kanban, code di task, tentativi supervisionati, merge o CI dentro il server: la review delle PR passa solo da workflow esterni.
- Rispetto a Topics manca quindi l'orchestrazione multi agente con code, review, land e publish [non verificato].

## Usabilità
- Superfici: TUI, desktop Electron, shell web servita dal server, PWA da mobile, estensione VSCode.
- L'estensione VSCode apre `opencode` in uno split terminal con `Cmd+Esc`, è un ponte e non un client ricco [codice: sdks/vscode/src/extension.ts:44].
- Diff unificato o split sia in TUI (viewer dedicato) sia nel desktop (stato `diffStyle`) [codice: packages/tui/src/feature-plugins/system/diff-viewer.tsx:21].
- Notifiche in TUI con suono configurabile e coordinatore dedicato nel desktop [codice: packages/tui/src/attention.ts:131].
- Keymap personalizzabile in TUI e comandi con scorciatoie nella shell web [codice: packages/tui/src/context/keymap.tsx:257].
- Onboarding: `/init` genera `AGENTS.md` nel progetto, e l'API espone `POST /session/:id/init` [doc: https://opencode.ai/docs/server].
- Flusso principale: apri il TUI nella cartella, chatta, approva i tool, condividi la sessione con un link.
- La shell web è la stessa servita dal desktop e dal comando `serve`, quindi ogni client condivide stato e sessioni.

## Browser e anteprima
- Nessun browser integrato nel server: c'è il plugin `opencode.browser` che richiede un desktop collegato via RPC `experimental.browser` [codice: packages/plugin-browser/src/rpc.ts:548].
- L'agente può listare e aprire tab, navigare, leggere snapshot accessibili, valutare JS, cliccare e compilare campi.
- Può anche leggere console e rete, profili CPU e heap, report Lighthouse e fare screenshot [codice: packages/plugin-browser/src/rpc.ts:155].
- Gli screenshot tornano come attachment base64 più path locale al server [codice: packages/plugin-browser/src/tools.ts:103].
- La preview dei file avviene nel pannello Review del desktop [codice: packages/plugin-browser/src/rpc.ts:187].
- Il tunnel dati è TCP per attachment, massimo 64, in chunk da 64KB [codice: packages/plugin-browser/src/tunnel.ts:11].
- Un solo attachment browser per sessione, sostituito al re attach: niente co browse fra dispositivi [codice: packages/plugin-browser/src/connection.ts:88].
- Le issue chiedono registrazione e replay delle sessioni browser [issue #51662].
- Mancano WebGL nel browser integrato [issue #52509] e apertura dei link nel browser built in [issue #52680].

## Terminale, editor, file
- La TUI ha un terminale integrato nel pannello laterale, alimentato da snapshot di PTY persistenti [codice: packages/tui/src/component/terminal-pane.tsx:25].
- Il server espone handler separati per PTY effimere, socket PTY e PTY persistenti, con eventi di aggiunta e rimozione.
- L'editor non è integrato: si lavora sui file del progetto con diff e permessi, e l'estensione VSCode fa da ponte.
- I file condivisi via `share` sono resi da pagine dedicate nel sito sotto `/s/[id]`.
- Richiesta aperta per terminale e file con refresh live della review nel desktop [issue #52348].

## Remoto e mobile
- Nessuna app mobile nativa: da telefono si usa la PWA o il tunnel remoto.
- `opencode serve` espone API v2 e shell web; `share` pubblica una sessione con modalità `manual`, `auto` o `disabled` [codice: packages/schema/src/config.ts:42].
- Il remoto si abilita con `service set remote true` e si associa con `opencode pair`.
- Il tunnel usa OpenTunnel su hostname casuale non indovinabile, con retry esponenziale [codice: packages/cli/src/services/remote-tunnel.ts:24].
- Il pairing usa un codice casuale da 16 byte con TTL di 5 minuti e link monouso [codice: packages/server/src/pairing.ts:24].
- Autenticazione con `OPENCODE_PASSWORD` in Basic più token di sessione HMAC SHA256 da 30 giorni con confronto a tempo costante [codice: packages/server/src/auth.ts:33].
- Password generata da 32 byte casuali, mai scelta dall'utente [codice: packages/cli/src/server-process.ts:84].
- TLS solo attraverso il tunnel: in rete locale il traffico resta HTTP su loopback [non verificato].

## Provider e protocolli
- I provider sono 48 moduli: Anthropic, OpenAI, Google in più varianti, Azure, Bedrock, OpenRouter, DeepSeek, Groq, Cerebras, Mistral, xAI, Cohere, Together, Fireworks, Moonshot, Alibaba, gateway vari [codice: packages/ai/src/providers/index.ts:1].
- Completano l'offerta Ollama via plugin e il provider `opencode` Zen per il routing interno.
- Protocolli: messaggi Anthropic, chat e responses OpenAI, varianti compatibili, Gemini, immagini [codice: packages/ai/src/protocols/index.ts:1].
- Login OAuth per Codex e ChatGPT con PKCE su loopback e device code [codice: packages/core/src/plugin/provider/openai.ts:16].
- Altri OAuth: GitHub Copilot con device code, xAI, DigitalOcean e altri ancora.
- Nessun flusso OAuth Anthropic o Claude Code trovato nel codice ispezionato [non verificato].
- ACP supportato lato server, con mapping di sessioni, permessi e tool [codice: packages/cli/src/acp/agent.ts:58].
- MCP solo come client (HTTP streaming e stdio con OAuth), nessun server MCP esposto [codice: packages/core/src/mcp/client.ts:10].
- Topics invece parla con `claude -p` in stream json: OpenCode è provider agnostico, Topics è Claude centrico.

## Performance
- Nessun benchmark dichiarato trovato nel repo [non verificato].
- La TUI occupa 6,5-7 GB di RSS all'avvio anche in progetto vuoto, senza plugin [issue #49222].
- I processi MCP figli si accumulano a ogni reconnect del client fino a OOM [issue #46035].
- Bootstrap e compaction diventano lentissimi dopo una cinquantina di turni di conversazione [issue #50063].
- Le code SSE dei subscriber risultano da limitare sotto carico [issue #45215].
- Il watcher sottoscrive le cartelle skill in loop al 100% di CPU su macOS [issue #53811].
- Il desktop fermo occupa un core con rendering software e loop di observer [issue #52927].
- La TUI su Windows arranca su scroll con rotella e resize [issue #54239].
- Le modifiche al codice risultano più lente delle altre operazioni [issue #53510].
- Anche l'installer via curl è segnalato come lentissimo [issue #53702].
- Liste virtualizzate con TanStack e streaming SSE aiutano il rendering, ma sessioni lunghe e sottoprocessi MCP restano i punti deboli [non verificato].

## Affidabilità e qualità
- Circa 1.183 file di test e spec (`*.test.*`, `*.spec.*`), più 1.683 file sotto cartelle con `test` o `spec` nel percorso.
- CI con workflow di check e deploy separati per sito, changelog, binari e container.
- Persistenza in SQLite sotto XDG (`~/.local/share/opencode`) con WAL, busy timeout e claim write ahead [codice: packages/core/src/session/store.ts:62].
- Al riavvio riprende le sessioni sospese con semantica almeno una volta e fino a 10 tentativi [codice: packages/core/src/session/execution/restart.ts:37].
- Nessun auto update per la CLI (install via curl); `electron-updater` impacchettato per il desktop.
- Controllo degli aggiornamenti dei plugin ogni 24 ore [codice: packages/core/src/plugin/supervisor.ts:190].
- Crash segnalati: SIGABRT su Linux con la libreria PTY sotto pressione di memoria [issue #55459].
- Freeze del desktop su tab con schermo bianco [issue #55324] e spinner TUI che si blocca nelle operazioni lunghe [issue #55210].

## Sicurezza e privacy
- Credenziali in tabella SQLite dedicata, con import una tantum dal vecchio `auth.json` [codice: packages/core/src/credential.ts:68].
- File del database creato e mantenuto a `0600` [codice: packages/core/src/database/database.ts:89].
- Nessun portachiavi di sistema trovato nel codice: niente keychain o keytar [non verificato].
- Permessi dei tool su tre livelli `allow`, `deny`, `ask` con risposte una tantum o permanenti [codice: packages/schema/src/permission.ts:56].
- Porte solo su loopback di default; OAuth sempre su callback `127.0.0.1`, anche per MCP [codice: packages/core/src/mcp/oauth.ts:388].
- Nessuna telemetria di prodotto trovata nel codice, solo un flag `telemetry: false` nella config di build [non verificato].
- Rischio noto: i tool browser restano esposti nonostante il `deny` a livello agente se l'agente conserva `execute` [issue #54044].

## Estendibilità
- Plugin dichiarati con `Plugin.define({id, effect})`, con transform su agenti, comandi, integrazioni, MCP, modelli, provider, reference, skill, tool, VCS e ricerca web [codice: packages/plugin/src/effect/README.md:14].
- Hook di runtime e reload completano il ciclo di vita del plugin.
- Dichiarazione in config come stringa o voce con opzioni [codice: packages/schema/src/config/plugin.ts:6].
- Esempi built in nei plugin provider e in `packages/plugins/figma`.
- Comandi custom da file Markdown sotto cartelle `command` o `commands` [codice: packages/core/src/config/plugin/command.ts:159].
- Skill scoperte via `SKILL.md` con modulo di discovery dedicato [codice: packages/core/src/skill.ts:58].
- Temi in `packages/theme` e oltre 40 package che mostrano come comporre nuove superfici.

## Da prendere per Topics
1. Condivisione sessione via link con modalità manual, auto e disabled: la pagina Share mostra la sessione senza esporre il server, modo economico di mostrare un topic a terzi [codice: packages/schema/src/config.ts:42].
2. Pairing remoto con codice monouso a TTL breve e tunnel su hostname casuale: modello semplice da copiare per il telefono, con password generata e non scelta [codice: packages/server/src/pairing.ts:24].
3. Autenticazione a due strati, Basic con password persistente più token HMAC con scadenza e cookie per porta: adatta al servizio su 3333 meglio di una sola password statica [codice: packages/server/src/auth.ts:40].
4. Sidecar server unico per TUI, desktop e web: un solo backend con OpenAPI, i client sono gusci intercambiabili, e Topics può convergere allo stesso schema [codice: packages/desktop/src/main/service/background-service.ts:53].
5. Tool browser come plugin RPC con operazioni granulari (snapshot, evaluate, screenshot, console, rete, Lighthouse): secondo blocco di tool per il pannello browser oltre ai 15 esistenti [codice: packages/plugin-browser/src/rpc.ts:155].
6. Comandi e skill da file Markdown con discovery automatica: formato che gli utenti capiscono senza SDK, con comandi e skill sotto cartelle note [codice: packages/core/src/config/plugin/command.ts:159].
7. Permessi allow, deny e ask con risposte once e always: più espressivi di un semplice allow, e il caso `deny browser` aggirato via `execute` [issue #54044] insegna a valutare l'albero dei tool, non il singolo nome.
8. Resume delle sessioni sospese al riavvio con tentativi limitati: alza l'affidabilità percepita del servizio senza clustering [codice: packages/core/src/session/execution/restart.ts:37].
9. Worktree come primitiva di server con refresh: base necessaria prima di qualsiasi kanban multi agente [codice: packages/server/src/handlers/worktree.ts:14].
10. Provider compatibili OpenAI e Anthropic come fallback configurabile: riduce il lock in su Claude quando le credenziali mancano, senza cambiare il protocollo interno [codice: packages/ai/src/providers/index.ts:1].

## Da evitare
1. TUI che divora gigabyte di RAM all'avvio a progetto vuoto [issue #49222]: segnale di leak o bundle gonfio da non replicare nel guscio Tauri.
2. Figli MCP che si accumulano a ogni reconnect fino a OOM [issue #46035]: serve supervisione con kill alla disconnessione, non spawn cieco.
3. Sessioni che degradano dopo decine di turni senza compaction efficace [issue #50063]: limite esplicito di contesto con compattazione misurata, non crescita libera.
4. Watcher in loop su cartelle skill al 100% di CPU [issue #53811]: debounce e sottoscrizioni stabili, mai risottoscrizione su ogni evento.
5. Desktop fermo che occupa un core per rendering software e observer [issue #52927]: su WKWebView contano animazioni spente di default e observer con cleanup.
6. Permessi valutati per nome singolo e aggirabili via tool composti [issue #54044]: valutare l'effetto, non l'etichetta.
7. Installer lento e release frenetiche senza auto update della CLI: rilasciare spesso va bene, ma l'aggiornamento deve essere un comando solo e veloce [issue #53702].

## Fonti
- README e descrizione: https://github.com/anomalyco/opencode
- Documentazione server, share e remoti: https://opencode.ai/docs/server
- Codice citato allo SHA `8ffbcc2`: https://github.com/anomalyco/opencode/blob/8ffbcc2c81d1ff558618137204c36954797d7a6f/packages/server/src/process.ts#L55
- Stessa base per `packages/desktop/src/main/service/background-service.ts`, `packages/tui/src/app.tsx`, `packages/core/src/session/session.ts`, `packages/plugin-browser/src/rpc.ts`, `packages/server/src/auth.ts`, `packages/ai/src/providers/index.ts`
- Release: https://github.com/anomalyco/opencode/releases (latest v1.19.0 del 11/10/2026)
- Issue citate: #49222, #46035, #50063, #45215, #53811, #52927, #54239, #53510, #53702, #51662, #52509, #52680, #55459, #55324, #55210, #54044, #52348
