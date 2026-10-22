# Maestro

## In tre righe

Maestro è un'app desktop Electron che orchestra flotte di agenti di coding AI in parallelo, per power user che vivono di tastiera e gestiscono più progetti insieme [README].
Il suo punto più forte rispetto a Topics è l'automazione senza supervisione: Auto Run esegue interi playbook markdown un task per sessione con context pulito, con record di quasi 24 ore di runtime continuo [README].
Il secondo punto è la costituzione "se lo puoi fare nella UI, lo puoi fare da CLI": ogni azione ha un verbo `maestro-cli` equivalente, così gli agenti pilotano l'app intera da soli [codice: AGENTS.md].

## Identità

Repository `RunMaestro/Maestro`, descrizione "Agent Orchestration Command Center", 3451 stelle e 368 fork misurati via API il 2026-10-14 [non verificato].
Licenza AGPL-3.0 [codice: LICENSE:1] (il `package.json` riporta la stringa non SPDX `"AGPL 3.0"` [codice: package.json:11]).
Ultimo commit `cc80635` del 2026-10-14 ("count Claude usage once per API response"), quindi sviluppo quotidiano attivo [non verificato].
Release stabile v1.0.0 "Full Orchestra" del 2026-10-09 [release v1.0.0], preceduta da RC e security release ravvicinate (v0.18.8-RC, v0.17.8, v0.17.7) [non verificato]; il repo dichiara già versione 1.0.1 [codice: package.json:3].
Piattaforme: desktop macOS (dmg/zip), Windows (nsis/portable), Linux (AppImage/deb/rpm) [codice: package.json:138], più build web-desktop nel browser e CLI `maestro-cli`/`maestro-p` [codice: package.json:16].
Maturità: prima major da pochi giorni, cadenza di release aggressiva con rami RC paralleli e guard CI (`guard-main-not-rc.yml`) [codice: .github/workflows/].

## Architettura

Linguaggi misurati con `git ls-files` più `wc -l` (esclusi i worktree interni `.claude/`): TypeScript 1.100.154 righe in 3652 file, TSX 501.514 righe in 1386 file, per un totale di circa 1,6 milioni di righe [non verificato].
Togliendo test e generati, `src/` utile è 713.618 righe in 2953 file [non verificato]. Niente Rust, Go o altri backend: è tutto TypeScript, il contrario di Topics.
Framework: Electron con split main/renderer e context isolation stretta, renderer React senza accesso Node [codice: src/main/preload/].
Modello dei processi: ogni agent ha due processi vivi insieme, uno AI e uno terminale (`aiPid`, `terminalPid`, `inputMode`), così si passa da chat a shell senza restart [codice: src/main/index.ts:2124].
Gli agenti AI girano in `child_process` batch non interattivi, i terminali in PTY via node-pty [codice: src/main/process-manager/spawners/PtySpawner.ts:2].
IPC: bridge minimo esposto come `window.maestro` via `contextBridge`, un modulo preload per namespace [codice: src/main/preload/].
Storage: `electron-store` per le sessioni con scritture differite e coalescing [codice: src/main/stores/deferred-writes.ts:25], più store JSON atomici (temp più rename) [codice: src/main/utils/atomic-json-store.ts:1] e SQLite via better-sqlite3 per le statistiche [codice: src/main/stats/stats-db.ts:1].
Colloquio con l'agente: lancio batch con prompt e risposta, mai interattivo. Claude via `claude --print --verbose --output-format stream-json` [codice: src/main/agents/claudeSpawnCore.ts:412], Codex via `exec --json` [codice: src/main/agents/definitions.ts:265], resume per provider (`--resume`, `resume <thread>`, `--session`) [codice: src/main/agents/definitions.ts:208].
Solo Claude dichiara `supportsAppendSystemPrompt`, per gli altri il system prompt è incorporato nel primo turno utente [codice: src/shared/embeddedSystemPrompt.ts:3].
C'è anche un wrapper TUI interattivo (`maestro-p` in `src/maestro-p/`) per il percorso Claude con prompt [non verificato].

## Sessioni e task

Organizzazione: Agent (workspace) con un CLI Terminal e più AI Tab, ogni tab collegata a una provider session nuova o ripresa dal pool [codice: ARCHITECTURE.md:35].
Sessioni parallele illimitate, ognuna con workspace, cronologia e contesto isolati [README].
Auto Run e Playbook: runner su file system che processa checklist markdown (spec-driven) o un obiettivo in testo libero (goal-driven), un task per sessione AI con context pulito, con loop, history e Thought Stream live [README] [codice: src/main/ipc/handlers/autorun.ts:26].
Auto Run gira isolato in directory separata con worktree [codice: ARCHITECTURE.md:871], altrimenti accoda sequenziale [codice: ARCHITECTURE.md:916], e i messaggi manuali si accodano dietro [codice: src/renderer/components/InputArea/InputArea.tsx:210].
Group Chat: un agente moderatore delega agli altri per più round e restituisce una sintesi [README], engine in [codice: src/main/group-chat/group-chat-moderator.ts].
Cross-Agent Mentions: `@altro-agent` in chat per un consulto single-turn in background senza bloccare [README].
Git worktree: agenti paralleli su branch isolati con `git worktree add`, PR con un click (`createPROnCompletion`, `git:createPR`) [codice: src/main/ipc/handlers/git/worktree.ts:232] [codice: src/main/ipc/handlers/git/github.ts:22], anche da CLI [codice: src/cli/commands/create-worktree.ts:1].
Message queueing: i messaggi scritti mentre l'agente è occupato vengono inviati in automatico quando è pronto [README]; la coda group-chat è di proprietà del main process e non perde messaggi [codice: src/main/group-chat/group-chat-queue.ts:1].
Tentativi e resilienza: se un turno muore per overload o quota, Maestro rinvia lo stesso prompt con backoff o attende il reset reale letto dall'errore, con failover opzionale su endpoint di backup [README] [codice: src/shared/retryClassification.ts:2].
Cue: motore di automazione event-driven (file changed, heartbeat/schedule, task pending, PR/issue GitHub, webhook, agent completed) configurato in `.maestro/cue.yaml` [codice: src/main/cue/cue-engine.ts:1] [codice: src/main/cue/triggers/cue-trigger-source-registry.ts:35].
Niente board kanban: l'unica occorrenza di "kanban" nel codice è un diagramma in un system prompt [codice: src/prompts/maestro-system-prompt.md:302].
Review e merge: diff viewer, git log con grafo, PR un click; CI esterna via `gh`, non integrata nell'app [non verificato].

## Usabilità

Superfici: desktop Electron, web-desktop nel browser, CLI completa [codice: src/cli/commands/].
Design keyboard-first: `Cmd+K` quick actions, `Cmd+J` switch AI/terminale, `Cmd+[`/`]` tra agenti, mastery tracking che premia l'uso della tastiera [README].
Onboarding: wizard con selezione agent e directory più tour [codice: src/renderer/components/Wizard/MaestroWizard.tsx].
Diff e review: GitDiffViewer con syntax highlighting [codice: src/renderer/components/GitDiffViewer.tsx:80], ImageDiffViewer per immagini [codice: src/renderer/components/ImageDiffViewer.tsx:19].
Notifiche: toast con colori e dismissible [codice: src/renderer/stores/notificationStore.ts], annunci audio text-to-speech al completamento [README].
Altro: draft auto-save per sessione, output filtering con regex, slash commands estendibili, cost tracking realtime per sessione e globale [codice: src/shared/modelPricing.ts:194], usage dashboard con heatmap ed export CSV, document graph dei markdown linkati, 12 temi, achievement in stile direttore d'orchestra [README].

## Browser e anteprima

Browser integrato pilotabile: sì, `BrowserTabView` con test e2e dedicato [codice: src/renderer/components/MainPanel/BrowserTabView.tsx:228] [codice: e2e/browser-tab.spec.ts:276].
L'agente lo pilota via tool `browser_navigate`/`click` serviti da un coworking server, con permesso per-agent [codice: src/main/coworking/coworking-server-script.ts:143].
Niente co-browse fra dispositivi come Topics: ogni client ha il proprio renderer e il proprio tree, il desktop non rispecchia il DOM di un altro client [codice: src/main/ipc/handlers/persistence.ts:94] [codice: src/main/ipc/handlers/web.ts:282].
Anteprima file ricca: syntax highlighting, markdown, immagini, tabelle CSV/TSV ordinabili, jq su JSON/JSONL, diagrammi Mermaid, pan e zoom, player audio/video floating, Parquet come tabella filtrabile con query tipizzata che salta i row group [README] [codice: src/renderer/components/FilePreview/FilePreview.tsx:101].
Il motore Parquet evita di caricare file multi-gigabyte in memoria [README].

## Terminale, editor, file

Terminale xterm con rendering WebGL/canvas [codice: src/renderer/components/XTerminal.tsx:258], PTY reale via node-pty [codice: src/main/process-manager/spawners/PtySpawner.ts:2].
Dual-mode: ogni agent ha AI Terminal e Command Terminal commutabili [README].
Editor markdown su CodeMirror (`EditorView`) con gutter e numeri di riga [codice: src/renderer/components/FilePreview/markdownEditor/extensions.ts:9].
File explorer con refresh su evento e menzione `@` dei file nei prompt [README] [codice: src/renderer/components/FileExplorerPanel/FileExplorerPanel.tsx:64].
Git integrato: detection automatica, branch, diff, log, worktree, tutto senza uscire dall'app [README].

## Remoto e mobile

Mobile Remote Control con web server integrato e accesso via QR [README].
Server Fastify con HTTP e WebSocket su porta effimera (`port=0`) [codice: src/main/web-server/WebServer.ts:291], token random UUID nell'URL (`/$TOKEN/`) [codice: src/main/web-server/WebServer.ts:307] più login con password hash e cookie da 30 giorni [codice: src/main/web-server/auth/web-user-store.ts:33].
Accesso LAN via IP locale e da ovunque via tunnel Cloudflare Quick Tunnel con QR [codice: src/main/tunnel-manager.ts:18] [codice: src/main/ipc/handlers/system.ts:443].
Il web-desktop è un client indipendente (bridge IPC su WebSocket), non uno specchio: condivide i dati ma ogni tab browser ha il suo stato [codice: src/web-desktop/bootstrap.ts].
PWA con manifest e service worker [codice: src/web/public/sw.js:18], con fix dedicati per iOS standalone e viewport mobile [non verificato].
Di default il server ascolta solo su loopback, la LAN va abilitata e viaggia in HTTP plain [codice: src/main/web-server/WebServer.ts:295].
Le issue mostrano che il remoto è il fronte fragile: sessioni perse dopo reload browser [issue #1398], Auto Run sparito dalla UI dopo reload [issue #1470], worktree duplicati nel web [issue #1506].

## Provider e protocolli

Attivi: Claude Code e OpenCode e Codex secondo il README [README]; nel codice risultano attivi `claude-code` e `codex`, gli altri in beta [codice: src/shared/agentMetadata.ts:135].
Beta: OpenCode, Factory Droid, Copilot-CLI, Qwen3 Coder, Oh My Pi, Grok, Antigravity, Hermes, Pi [codice: src/shared/agentMetadata.ts:135].
Pass-through lecito: qualunque MCP tool, skill, permesso o autenticazione configurata nei CLI originali funziona identica in Maestro, che lancia i binari dell'utente in batch [README].
ACP (Agent Client Protocol): nessun riferimento in `src/`, non supportato [non verificato].
MCP: solo lato client e relay. I tool dei plugin sono esposti al modello via `maestro-cli mcp serve` [codice: src/main/ipc/handlers/cross-agent.ts], il relay dei permessi Claude passa da `--permission-prompt-tool` più `--mcp-config` [codice: src/main/permission-relay/spawn-args.ts:66].
Il "MCP Server" nella documentazione collega app AI alla documentazione di Maestro, non è controllo agenti [doc: https://docs.runmaestro.ai/mcp-server].
Skill: discovery in sola lettura da `.claude/skills` e `.codex/skills` [codice: src/main/ipc/handlers/agents.ts:199], nessun hook engine proprietario oltre il relay permessi.
Parser dedicati per 10 provider con factory che crea un'istanza fresca per processo [codice: src/main/parsers/parser-factory.ts:26].
Session discovery: importa sessioni preesistenti dai path dei provider (Claude `~/.claude/projects/`, Codex `~/.codex/sessions/`, OpenCode, Copilot, Grok) con storage astratto condiviso [codice: src/main/storage/base-session-storage.ts:47].

## Performance

Budget dichiarati: resting sotto 5000 nodi, heap JS sotto 250 MB, frame sotto 32 ms; animazioni misurate a frazioni di millisecondo per frame [codice: CLAUDE-PERFORMANCE.md:474].
Batching dello streaming a 200 ms (circa 5 render al secondo) [codice: src/renderer/hooks/session/useBatchedSessionUpdates.ts:178], persistenza con debounce [codice: src/renderer/hooks/utils/useDebouncedPersistence.ts], scroll throttled a 4 ms [codice: CLAUDE-PERFORMANCE.md:161].
Liste virtualizzate con TanStack Virtual in cronologia, ricerca file, explorer, chat di gruppo e griglia Parquet [codice: src/renderer/components/HistoryPanel.tsx:573].
Scritture differite e coalescenti nel main con rename atomico [codice: src/main/stores/deferred-writes.ts:25], igiene dei payload IPC (`setMany` contro `setAll`) per evitare churn da 500 MB [codice: CLAUDE-PERFORMANCE.md:255].
Profiling con Chromium contentTracing e analisi offline via script [codice: src/main/profiling/] [codice: scripts/analyze-perf-trace.mjs:1], power management con `powerSaveBlocker` refcounted [codice: src/main/power-manager.ts:1].
Niente Rust per la velocità: tutto il lavoro pesante resta in Node, la performance viene da batching e virtualizzazione.
Lamentele: switch ad agent con sessione lunga congelava la UI per circa 5 secondi [issue #1342, chiusa].
Avvio ed esecuzione test richiedono heap allargato (`NODE_OPTIONS=--max-old-space-size=8192`) [codice: package.json:66], segnale di suite pesante.

## Affidabilità e qualità

Test: 2045 file `*.test.ts(x)` in `src/__tests__` [non verificato], 9 spec e2e Playwright su Electron [codice: e2e/], più config separate per integration e performance [codice: vitest.integration.config.ts] [codice: vitest.performance.config.mts:16].
CI su 6 workflow: test, release, guard sui rami RC, publish del plugin SDK, stale [codice: .github/workflows/ci.yml].
Solo il main scrive gli store, la CLI legge soltanto [codice: src/main/stores/deferred-writes.ts:38].
Crash-safe: scritture atomiche temp più rename, quarantena dei file corrotti in sidecar `.corrupt-` con fallback ai default, backup del registry [codice: src/main/stores/corrupt-store-recovery.ts:1] [codice: src/main/stores/registry-backup.ts:22].
Auto-update via electron-updater con download non automatico, feed da GitHub a CDN, attivo dalla v0.8.7 [codice: src/main/auto-updater.ts:123] [doc: https://docs.runmaestro.ai/installation].
Telemetria crash su Sentry con DSN pubblico by design, attiva solo se il report è abilitato (default true) in build packaged [codice: src/main/index.ts:366].
Punti deboli visibili nelle issue: Auto Run che non riprende dopo i limiti di usage con controlli bloccati [issue #1804, aperta], Auto Run avviato da web-desktop non registrato sul desktop [issue #1519, chiusa].

## Sicurezza e privacy

Autenticazione lecita per costruzione: Maestro lancia i CLI già installati e autenticati dall'utente, le credenziali restano nelle directory dei provider (`CLAUDE_CONFIG_DIR`, `CODEX_HOME/auth.json`) [codice: src/main/agents/detector.ts:168].
I token Codex non escono dal main process [codice: src/main/agents/codex-usage-sampler.ts:4] e i debug package redactano chiavi e secret [codice: src/main/debug-package/packager.ts:67].
Nessuna sandbox OS: gli agenti girano con i privilegi dell'utente, la "sandbox" è solo flag dei CLI (`--sandbox read-only`, `--permission-mode plan`) fino al bypass totale [codice: SECURITY.md:80].
IPC blindato da context isolation e Node integration disabilitata [codice: SECURITY.md:103].
Rete: token random, loopback di default, LAN in HTTP plain, tunnel Cloudflare per il remoto [codice: SECURITY.md:88].
Precedente serio: CORS permissivo e WebSocket senza validazione Origin permettevano a pagine web di leggere risposte API ed eseguire comandi [issue #1710, chiusa].
Telemetria: check-in anonimo (UUID, versione, piattaforma) dietro preferenza di update-check, mai in build unpackaged [codice: src/main/checkin.ts:12].

## Estendibilità

Plugin con tre tier: dati (auto-enable), compute (utilityProcess più `vm`), UI (webview isolata), gate spento di default [codice: CLAUDE-PLUGINS.md:7].
Broker dei permessi default-deny con tabella metodo-capability e SDK congelato [codice: src/shared/plugins/rpc-protocol.ts], CLI `plugin init/validate/sign/pack` con firma e consenso [codice: src/cli/commands/plugin.ts].
Maestro Prompts: system prompt come `.md` editabili dalle impostazioni [codice: src/prompts/].
Slash command estendibili con autocomplete e variabili template [README] [codice: src/shared/templateVariables.ts].
Marketplace di playbook importabili da GitHub via ZIP con asset [codice: src/main/ipc/handlers/marketplace.ts].
Hook di Claude Code: non un engine proprio, solo relay dei permessi verso l'host [non verificato].

## Da prendere per Topics

1. Costituzione CLI-UI parity ("se lo puoi fare nella UI, lo puoi fare da CLI, stessa implementazione, ogni scrittura ha la sua lettura"): è il pezzo che rende gli agenti autonomi dentro l'app, e per Topics varrebbe più di qualunque feature [codice: AGENTS.md].
2. Cross-agent mentions con holding del turno: consultare un altro agent con `@nome` in background e tenere aperto il turno finché arriva la risposta è esattamente ciò che manca alla chat multi-provider di Topics [README] [codice: src/renderer/services/crossAgentMentions.ts].
3. Group Chat con moderatore multi-round: sintesi delegata invece di mention inline quando servono follow-up, con coda di proprietà del main che non perde messaggi [README] [codice: src/main/group-chat/group-chat-queue.ts:1].
4. Auto Run un task per sessione con context pulito: i playbook spec-driven con Thought Stream live sono il modello giusto per le code della kanban Topics [README] [codice: src/main/ipc/handlers/autorun.ts:26].
5. Agent Resilience con lettura del reset reale: rinvio automatico con backoff e attesa del reset letto dall'errore invece di muri di dialoghi, con una sola status card [README] [codice: src/shared/retryClassification.ts:2].
6. Session discovery dai provider: importare conversazioni nate fuori dall'app (prima dell'installazione) rende Topics utile dal primo avvio [README] [codice: src/main/storage/base-session-storage.ts:47].
7. Message queueing mentre l'agente è occupato: non perdere mai un pensiero è banale da implementare e cambia la UX della chat [README].
8. Usage Dashboard con costo per modello: pricing condiviso e tracking realtime per sessione e globale, con export CSV [codice: src/shared/modelPricing.ts:194] [codice: src/main/stats/stats-db.ts:1].
9. Maestro Prompts editabili: i system prompt come file `.md` modificabili dalle impostazioni, senza rebuild [codice: src/prompts/].
10. Tre vie di ingresso per ogni surface (hotkey, palette, menu) più Escape e chiusura grafica: regola semplice che elimina le scorciatoie morte [codice: AGENTS.md].

## Da evitare

1. Monolite da 1,6 milioni di righe con duplicazione ammessa: la loro stessa guida vieta di creare nuove utility perché esistono già 20 helper di formato duplicati, 60 mock factory e 500 registrazioni modali manuali [codice: AGENTS.md]. La scala senza disciplina diventa debito.
2. Electron pesante contro Tauri: suite che chiede 8 GB di heap per girare e budget di 250 MB resting dicono che il guscio costa [codice: package.json:66].
3. Sync multi-client fragile: le issue su web-desktop (stato perso al reload, Auto Run fantasma, worktree doppi) mostrano cosa succede quando ogni client ha il suo tree senza replay [issue #1470] [issue #1398] [issue #1506].
4. LAN in HTTP in chiaro con token in URL: comodo per il QR, ma il token nei log e il traffico leggibile in rete locale restano un rischio [codice: src/main/web-server/WebServer.ts:307].
5. Sandbox `vm` più processo separato più broker:mettere insieme tre meccanismi di isolamento per i plugin aumenta la superficie invece di ridurla, e la `vm` di Node è notoriamente escapabile [codice: CLAUDE-PLUGINS.md:7].
6. AGPL-3.0: il codice non è riusabile dentro Topics closed source, solo le idee con parole proprie [codice: LICENSE:1].
7. Gamification invasiva (achievement, rank da Apprentice a Titan): rumore per un tool professionale, non copiare il pattern [README].

## Fonti

- Repo: https://github.com/RunMaestro/Maestro (SHA `cc806353522710e8a530c70985a5a0543705c142`)
- Release: https://github.com/RunMaestro/Maestro/releases (v1.0.0 Full Orchestra, 2026-10-09) [release v1.0.0]
- README: https://github.com/RunMaestro/Maestro/blob/cc806353522710e8a530c70985a5a0543705c142/README.md [README]
- Architettura: https://github.com/RunMaestro/Maestro/blob/cc806353522710e8a530c70985a5a0543705c142/ARCHITECTURE.md
- Provider: https://github.com/RunMaestro/Maestro/blob/cc806353522710e8a530c70985a5a0543705c142/PROVIDER-SUPPORT.md
- Plugin: https://github.com/RunMaestro/Maestro/blob/cc806353522710e8a530c70985a5a0543705c142/CLAUDE-PLUGINS.md
- Performance: https://github.com/RunMaestro/Maestro/blob/cc806353522710e8a530c70985a5a0543705c142/CLAUDE-PERFORMANCE.md
- Sicurezza: https://github.com/RunMaestro/Maestro/blob/cc806353522710e8a530c70985a5a0543705c142/SECURITY.md
- Docs: https://docs.runmaestro.ai/ [doc: https://docs.runmaestro.ai/]
- MCP Server docs: https://docs.runmaestro.ai/mcp-server [doc: https://docs.runmaestro.ai/mcp-server]
- Auto Run: https://docs.runmaestro.ai/autorun-playbooks [doc: https://docs.runmaestro.ai/autorun-playbooks]
- Worktree: https://docs.runmaestro.ai/git-worktrees [doc: https://docs.runmaestro.ai/git-worktrees]
- Remoto: https://docs.runmaestro.ai/remote-access [doc: https://docs.runmaestro.ai/remote-access]
- Issue: #1342 freeze UI, #1710 CORS, #1804 Auto Run resume, #1470 Auto Run perso, #1398 sessioni perse, #1506 worktree doppi, #1519 Auto Run web-desktop, #1557 SSH localhost [issue #1342] [issue #1710] [issue #1804] [issue #1470]
