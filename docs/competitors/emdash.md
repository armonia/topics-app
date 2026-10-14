# Emdash

## In tre righe
Emdash è un'app desktop open source che coordina CLI di coding agent in task e worktree Git.
[README](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/README.md#L21-L37)

È pensata per chi lavora su più progetti o agenti, con integrazioni per GitHub, SSH, terminale ed editor.
[README](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/README.md#L21-L49)

Il punto da studiare per Topics è il collegamento fra Changes, diff, commenti PR e CI, pur distribuito fra sidebar e pannello editor.
[doc: https://emdash.com/docs/diff-view](https://emdash.com/docs/diff-view)

## Identità
Snapshot del 14 ottobre 2026: il repository mostra 5.983 stelle, 629 fork e licenza Apache-2.0; il clone analizzato era al commit `79f37d920bd576dc18ca5421856fd2cc9ec8abac`.
[Repo GitHub](https://github.com/generalaction/emdash) [commit](https://github.com/generalaction/emdash/commit/79f37d920bd576dc18ca5421856fd2cc9ec8abac) L'attività è elevata: la
lista delle ultime cinque release include v1.2.8 e tre canary pubblicate tra l'8 e il 10 ottobre, oltre a v1.2.7 del 27 settembre.
[release v1.2.8](https://github.com/generalaction/emdash/releases/tag/v1.2.8) [Releases](https://github.com/generalaction/emdash/releases) Il prodotto documenta build per macOS,
Windows e Linux. [README](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/README.md#L39-L49) Inferenza: è un progetto maturo per ampiezza
delle funzioni e ritmo di sviluppo, ma l'età recente del ramo v1 e le regressioni ancora aperte consigliano di distinguere maturità del codice da stabilità a ogni scala.
[release v1.2.8](https://github.com/generalaction/emdash/releases/tag/v1.2.8) [issue #3262](https://github.com/generalaction/emdash/issues/3262)

## Architettura
È un monorepo TypeScript/Node organizzato con pnpm e Nx; il desktop usa Electron 40.10.2, React 19.2, Vite 6 e TypeScript 6. Il renderer incorpora anche un pacchetto chat basato su
Solid. [codice: package.json:2-34](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/package.json#L2-L34)
[codice: apps/emdash-desktop/package.json:51-87](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/package.json#L51-L87)
[codice: packages/chat-ui/package.json:2-20](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/chat-ui/package.json#L2-L20) La misura
al commit esaminato conta 5.367 file tracciati, di cui 5.311 testuali, con 774.945 righe fisiche. La classificazione per estensione dà TypeScript 575.286, JSON 149.713, YAML
19.814, Markdown e MDX 18.357, CSS 3.738, JavaScript 1.779, SQL 1.502, più 4.756 righe nelle altre estensioni.
[snapshot misurato](https://github.com/generalaction/emdash/tree/79f37d920bd576dc18ca5421856fd2cc9ec8abac) Sono righe fisiche, inclusi test, file generati, lockfile, dati, commenti
e righe vuote, non LOC di prodotto. Il conteggio esclude 56 file binari. [snapshot misurato](https://github.com/generalaction/emdash/tree/79f37d920bd576dc18ca5421856fd2cc9ec8abac)
Il processo Electron separa main, preload e renderer; il renderer parla con servizi host-side attraverso contratti Wire su MessageChannel. Worker separati gestiscono
conversazioni/ACP, terminali, file watcher, LSP, PR e mementos.
[codice: apps/emdash-desktop/electron.vite.config.ts:51-105](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/electron.vite.config.ts#L51-L105)
[codice: apps/emdash-desktop/src/main/gateway/desktop-workers.ts:246-360](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/main/gateway/desktop-workers.ts#L246-L360)
SQLite via better-sqlite3 e Drizzle usa WAL e busy_timeout di 5 secondi; conversazioni, pull request e mementos hanno database distinti.
[codice: apps/emdash-desktop/src/main/db/drizzleClient.ts:22-45](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/main/db/drizzleClient.ts#L22-L45)
[codice: apps/emdash-desktop/src/main/gateway/desktop-workers.ts:249-255](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/main/gateway/desktop-workers.ts#L249-L255)
Workspace Server è un processo Node separato sul computer che ospita il repo; il client locale gli inoltra il socket Unix attraverso SSH e negozia la versione Wire.
[codice: apps/workspace-server/src/index.ts:49-93](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/workspace-server/src/index.ts#L49-L93)
[codice: apps/emdash-desktop/src/core/services/hosts/node/workspace-server/connect/ssh-streamlocal-transport.ts:6-13](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/services/hosts/node/workspace-server/connect/ssh-streamlocal-transport.ts#L6-L13)
Non usa Tauri o Rust nel desktop esaminato; Electron e moduli nativi Node coprono il perimetro applicativo. È una distinzione architetturale, non una misura di velocità.
[codice: apps/emdash-desktop/package.json:121-147](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/package.json#L121-L147)

## Sessioni e task
Il flusso principale crea task isolati in branch e worktree, avviabili da branch, issue o PR; è possibile disattivare il worktree e lavorare nel checkout corrente.
[README](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/README.md#L21-L37)
[doc: https://emdash.com/docs/tasks](https://emdash.com/docs/tasks) La UI elenca task attivi e archiviati, con ricerca e ordinamenti per ultimo uso, creazione, stato PR e notifiche
non lette. È una lista, non una board Kanban.
[codice: apps/emdash-desktop/src/core/features/projects/browser/components/task-view/task-list.tsx:44-74](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/projects/browser/components/task-view/task-list.tsx#L44-L74)
[codice: apps/emdash-desktop/src/core/features/projects/browser/components/task-view/task-list-model.ts:12-25](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/projects/browser/components/task-view/task-list-model.ts#L12-L25)
Ogni task può ospitare più conversazioni di provider diversi, distinguendo sessioni attive e inattive; terminare una sessione lascia la conversazione riapribile.
[codice: apps/emdash-desktop/src/core/features/conversations/contributions/browser/sidebar-conversations-list.tsx:54-70](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/conversations/contributions/browser/sidebar-conversations-list.tsx#L54-L70)
Inferenza: l'isolamento documentato è task-scoped, non conversation-scoped. Non è provato che due conversazioni nello stesso task abbiano worktree separati o possano modificare gli
stessi file senza conflitto. [doc: https://emdash.com/docs/tasks](https://emdash.com/docs/tasks) Ci sono retry specifici per provisioning, script lifecycle, push e sessione ACP, ma
non emerge una cronologia generale dei tentativi dell'agente confrontabile per task. Le automazioni pianificate hanno invece un proprio storico dei run.
[codice: apps/emdash-desktop/src/core/features/tasks/browser/main-panel.tsx:251-310](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/tasks/browser/main-panel.tsx#L251-L310)
[doc: https://emdash.com/docs/automations](https://emdash.com/docs/automations) Il contesto può partire da issue collegate, importando titolo, descrizione e stato da vari tracker.
L'elenco documentato include GitHub, GitLab, Jira, Linear, Asana, Trello, Notion e altri. [doc: https://emdash.com/docs/issues](https://emdash.com/docs/issues)

## Usabilità
Il task view mette nella stessa area di lavoro chat, file, Git, terminale e browser, mentre la gestione delle conversazioni resta nella sidebar. La lista task privilegia selezione,
ricerca e ordinamento rispetto alla gestione visuale del flusso. [README](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/README.md#L21-L37)
[codice: apps/emdash-desktop/src/core/features/projects/browser/components/task-view/task-list.tsx:216-245](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/projects/browser/components/task-view/task-list.tsx#L216-L245)
La sezione Changes raccoglie Changed, Staged e Pull Requests nella sidebar. Dentro una PR si scelgono Files, Commits e Checks; nella scheda Checks appaiono sia gli esiti CI sia i
commenti GitHub.
[codice: apps/emdash-desktop/src/core/features/source-control/contributions/browser/changes-panel.tsx:45-54](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/source-control/contributions/browser/changes-panel.tsx#L45-L54)
[codice: apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/pr-entry.tsx:150-174](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/pr-entry.tsx#L150-L174)
[codice: apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/checks-list.tsx:95-133](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/checks-list.tsx#L95-L133)
Il diff del file si apre nel pannello editor principale, non nella stessa scheda o riquadro della sidebar. Quindi PR, commenti e CI sono contigui nel flusso, ma non una singola
vista. [doc: https://emdash.com/docs/diff-view](https://emdash.com/docs/diff-view)
[codice: apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/files-list.tsx:21-87](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/files-list.tsx#L21-L87)
I commenti di review importati da GitHub sono in sola lettura nella UI verificata: si vedono autore, data, posizione, testo e link esterno, senza comandi visibili di risposta o
risoluzione.
[codice: apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/comments-list.tsx:26-83](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/comments-list.tsx#L26-L83)
[codice: packages/plugins/src/pull-requests/impl/github/client.ts:564-671](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/plugins/src/pull-requests/impl/github/client.ts#L564-L671)
Le note inserite sulle righe del diff sono bozze locali associate al task. L'agente le riceve solo se l'utente le aggiunge come contesto o usa la menzione prevista; inviarle
all'agente non pubblica una review su GitHub.
[codice: apps/emdash-desktop/src/core/features/source-control/api/browser/diff-view/stores/draft-comments-store.ts:37-115](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/source-control/api/browser/diff-view/stores/draft-comments-store.ts#L37-L115)
[codice: apps/emdash-desktop/src/core/features/conversations/browser/acp/acp-chat-panel.tsx:262-273](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/conversations/browser/acp/acp-chat-panel.tsx#L262-L273)
I check sono quelli del commit head corrente; la UI mostra stato, nome e durata, mentre il dettaglio completo resta su GitHub. Il refresh verifica che il commit head non sia
cambiato durante l'aggiornamento. [doc: https://emdash.com/docs/ci-checks](https://emdash.com/docs/ci-checks)
[codice: apps/emdash-desktop/src/core/services/pull-requests/node/pull-request-service.ts:284-304](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/services/pull-requests/node/pull-request-service.ts#L284-L304)
Tra le azioni Git ci sono staging, discard, commit, push, creazione PR e merge con squash o rebase. Il pannello consente anche mark-ready di una draft e bypass esplicito dei
requisiti quando il server GitHub lo permette. [doc: https://emdash.com/docs/diff-view](https://emdash.com/docs/diff-view)
[codice: apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/merge-footer.tsx:49-106](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/merge-footer.tsx#L49-L106)
Il registry dei provider PR al commit esaminato include solo GitHub; il supporto ad altri tracker issue non equivale a PR o CI su quelle piattaforme. [codice: packages/plugins/src/pull-requests/registry.ts:1-21](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/plugins/src/pull-requests/registry.ts#L1-L21)

## Browser e anteprima
Il browser integrato è una Electron webview per task, con profili persistenti separati e sessioni registrate; il progetto può rilevare URL localhost dall'output dei terminali e
presentarli come preview. [doc: https://emdash.com/docs/in-app-browser](https://emdash.com/docs/in-app-browser)
[codice: apps/emdash-desktop/src/core/features/browser/browser/browser-tab-provider.tsx:32-36](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/browser/browser/browser-tab-provider.tsx#L32-L36)
[codice: packages/core/src/services/preview-detection/node/url-detector.ts:40-105](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/core/src/services/preview-detection/node/url-detector.ts#L40-L105)
La preview di un servizio remoto passa attraverso un tunnel SSH verso un listener locale loopback.
[codice: apps/emdash-desktop/src/core/features/preview-servers/node/port-forward-tunnel.ts:57-85](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/preview-servers/node/port-forward-tunnel.ts#L57-L85)
Non riusa profilo, cookie o estensioni di Chrome di sistema; questo separa i dati, ma significa che il login del browser personale non si trasferisce automaticamente.
[doc: https://emdash.com/docs/in-app-browser](https://emdash.com/docs/in-app-browser) L'API Browser esaminata espone sessione, tab attiva, screenshot, DevTools, pulizia dati ed
eventi, ma non include azioni generiche di click o navigazione. Un fixture ACP di Codex pubblicizza un comando browser-control; il ponte verso la webview Emdash non è verificato,
quindi non si può concludere né che il pilotaggio funzioni né che sia impossibile.
[codice: apps/emdash-desktop/src/core/features/browser/api/contract.ts:11-55](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/browser/api/contract.ts#L11-L55)
[codice: packages/plugins/src/agents/impl/codex/__snapshots__/acp-fixture.test.ts.snap:62-65](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/plugins/src/agents/impl/codex/__snapshots__/acp-fixture.test.ts.snap#L62-L65)
La documentazione e il codice esaminati non mostrano un co-browse fra dispositivi; il repository descrive un'app desktop, non un renderer mobile.
[README](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/README.md#L39-L49)

## Terminale, editor, file
Monaco apre i file del workspace e si collega ai modelli host-side; i language server sono richiesti attraverso il runtime Host. Le scritture file usano una precondizione etag e
l'editor salva buffer di recovery su SQLite.
[codice: apps/emdash-desktop/src/core/features/editor/browser/task-editor/editor-provider.tsx:104-134](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/editor/browser/task-editor/editor-provider.tsx#L104-L134)
[codice: packages/core/src/runtimes/files/api/contract.ts:122-135](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/core/src/runtimes/files/api/contract.ts#L122-L135)
[codice: apps/emdash-desktop/src/core/features/editor/node/editor-buffer-service.ts:14-54](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/editor/node/editor-buffer-service.ts#L14-L54)
Il terminale usa xterm e node-pty; supporta input/output, ridimensionamento e chiusura. Quando una tab si smonta, lo scrollback viene conservato spostando il contenitore fuori
schermo.
[codice: packages/core/src/runtimes/terminals/api/contract.ts:19-58](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/core/src/runtimes/terminals/api/contract.ts#L19-L58)
[codice: apps/emdash-desktop/src/core/features/terminals/browser/pty/use-pty.ts:73-90](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/terminals/browser/pty/use-pty.ts#L73-L90)
L'architettura collega editor, terminale e Git al medesimo host del progetto, locale o remoto; l'editor non è solo un visualizzatore del diff.
[codice: apps/emdash-desktop/src/core/features/editor/node/lsp-controller.ts:13-35](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/editor/node/lsp-controller.ts#L13-L35)

## Remoto e mobile
L'interfaccia resta sul desktop locale, mentre su host SSH girano repo, worktree, Git, terminali, script, LSP e processi agente. Il Workspace Server espone il proprio socket
tramite il tunnel SSH già autenticato. [doc: https://emdash.com/docs/remote-development/remote-projects](https://emdash.com/docs/remote-development/remote-projects)
[codice: apps/emdash-desktop/src/core/services/hosts/node/workspace-server/connect/ssh-streamlocal-transport.ts:6-13](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/services/hosts/node/workspace-server/connect/ssh-streamlocal-transport.ts#L6-L13)
tmux è un'opzione per mantenere le sessioni agente oltre riavvii o disconnessioni SSH; non risulta necessario per ogni progetto.
[doc: https://emdash.com/docs/remote-development/remote-projects](https://emdash.com/docs/remote-development/remote-projects) Remote Tasks può provisionare host via script forniti
dall'utente, ma la documentazione segnala che la funzione dipende dal build abilitato.
[doc: https://emdash.com/docs/remote-development/remote-tasks](https://emdash.com/docs/remote-development/remote-tasks) Non emerge nel repository una UI web o app mobile per usare
task da telefono, né relay di servizio gestito dal progetto. È un limite dell'evidenza consultata, non un'affermazione su eventuali prodotti esterni.
[README](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/README.md#L39-L49)

## Provider e protocolli
Il registry al commit analizzato importa staticamente 37 provider; 23 dichiarano una capability ACP. La documentazione online riportava conteggi discordanti di 34 e 35, quindi per
questo snapshot vale il conteggio del codice.
[codice: packages/plugins/src/agents/registry.ts:1-87](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/plugins/src/agents/registry.ts#L1-L87)
[doc: https://emdash.com/docs/providers](https://emdash.com/docs/providers) [doc: https://emdash.com/docs](https://emdash.com/docs) Tra i percorsi verificati, OpenCode avvia la CLI
con ACP; gli adapter di Claude Code e Codex avviano il runtime incorporato nel bundle.
[codice: packages/plugins/src/agents/impl/opencode/index.ts:88-120](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/plugins/src/agents/impl/opencode/index.ts#L88-L120)
[codice: packages/plugins/src/agents/impl/claude/index.ts:144-162](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/plugins/src/agents/impl/claude/index.ts#L144-L162)
[codice: packages/plugins/src/agents/impl/codex/index.ts:148-164](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/plugins/src/agents/impl/codex/index.ts#L148-L164)
ACP usa SDK su stdio/NDJSON e gestisce sessioni, prompt, cronologia e stati live. Per agenti TUI tradizionali esiste invece un runtime PTY con hook installati prima dello spawn.
[codice: packages/plugins/src/agents/helpers/acp-stdio.ts:1-37](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/plugins/src/agents/helpers/acp-stdio.ts#L1-L37)
[codice: packages/core/src/services/agent-plugins/node/hook-installer.ts:54-150](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/core/src/services/agent-plugins/node/hook-installer.ts#L54-L150)
MCP supporta stdio e HTTP, ma è un gestore che materializza le configurazioni native per ogni provider compatibile, non un server MCP centrale dell'app.
[codice: packages/core/src/primitives/mcp/api/schemas.ts:20-35](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/core/src/primitives/mcp/api/schemas.ts#L20-L35)
[codice: packages/core/src/runtimes/agent-config/node/runtime/mcp.ts:32-79](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/core/src/runtimes/agent-config/node/runtime/mcp.ts#L32-L79) Le
estensioni utente comprendono prompt, skills, MCP, file di progetto e script; gli adapter provider risultano invece statici nel bundle e il codice non mostra un loader UI per
provider arbitrari. [doc: https://emdash.com/docs/library/prompts](https://emdash.com/docs/library/prompts)
[doc: https://emdash.com/docs/library/skills](https://emdash.com/docs/library/skills)
[codice: packages/plugins/src/agents/registry.ts:45-87](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/plugins/src/agents/registry.ts#L45-L87)

## Performance
Il repository contiene un benchmark interno di avvio, su build pacchettizzata e otto progetti di profilo: mira a mostrare la finestra entro 1,5 secondi e a rendere il workspace
usabile entro 5 secondi. Sono target del test, non risultati pubblicati né confronto con Topics.
[codice: apps/emdash-desktop/scripts/boot-bench.ts:1-45](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/scripts/boot-bench.ts#L1-L45)
[blog v1](https://emdash.com/blog/emdash-v1-stable) L'issue aperta #3262 descrive su Ubuntu 24.04.5 e Core i9-14900K circa 165% CPU per 10 secondi, poi 138% per 4 secondi, durante
l'esecuzione del workspace registry con 18 worktree locali e uno esterno. È un report issue-specifico, la causa ipotizzata dall'autore non è accertata, e il caso non è stato
riprodotto né verificato su v1.2.8. [issue #3262](https://github.com/generalaction/emdash/issues/3262) Issue #2987 riporta su un Mac con 190 worktree circa 253 invocazioni
concorrenti di Git per refresh e oltre 200 di load average; la PR #3073 ha poi unificato scansioni e diff ed è stata integrata. Questi numeri descrivono quella configurazione e non
misurano le prestazioni generali dopo il fix. [issue #2987](https://github.com/generalaction/emdash/issues/2987) [PR #3073](https://github.com/generalaction/emdash/pull/3073)
L'issue #2882 riferisce un indice FTS5 di 2,5 GB e 966.000 righe con 24 workspace, con blocco della UI durante il reindex; una risposta del progetto attribuisce una correzione a
una release successiva, ma la risoluzione non è stata verificata indipendentemente. [issue #2882](https://github.com/generalaction/emdash/issues/2882) Altri report storici citano
processi figli e scansioni eccessivi su 17 workspace SSH (#2853), consumo elevato con 27 progetti e 143 workspace (#3070), e circa 21,1 GB di RSS dopo attività con CLI e worktree
(#2153). #3070 collega il caso a #3073; per #2853 e #2153 non emerge una prova pubblica sufficiente che il caso specifico sia risolto.
[issue #2853](https://github.com/generalaction/emdash/issues/2853) [issue #3070](https://github.com/generalaction/emdash/issues/3070)
[issue #2153](https://github.com/generalaction/emdash/issues/2153) Due issue ancora aperte al 14 ottobre segnalano uno scroll wheel che non passa ai contenitori nell'in-app browser
(#2952) e una tab SSH congelata dopo il risveglio del laptop (#2865); non sono state verificate sulla v1.2.8. [issue #2952](https://github.com/generalaction/emdash/issues/2952)
[issue #2865](https://github.com/generalaction/emdash/issues/2865) Inferenza: le regressioni pubbliche si concentrano su molti workspace o host remoti; la chiusura di segnalazioni
storiche non prova prestazioni generali né elimina il rischio indicato da #3262. [issue #3262](https://github.com/generalaction/emdash/issues/3262)
[PR #3073](https://github.com/generalaction/emdash/pull/3073)

## Affidabilità e qualità
Il conteggio coerente adottato qui trova 1.251 file test/spec tracciati, nominati secondo il pattern `.(test|spec).[cm]?[jt]sx?`; non è il numero di test case e non implica che
siano tutti eseguiti in ogni build. [snapshot misurato](https://github.com/generalaction/emdash/tree/79f37d920bd576dc18ca5421856fd2cc9ec8abac) La CI per le PR esegue formattazione,
lint, typecheck e test sui progetti Nx affected, oltre a un controllo dei language server impacchettati. La guida esclude esplicitamente i progetti browser Playwright dalla CI.
[workflow](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/.github/workflows/code-consistency-check.yml#L1-L97)
[guida test](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/agents/workflows/testing.md#L45-L69) Al 14 ottobre, il controllo Workspace Server
sul commit HEAD era passato; l'ultimo Code Consistency Check campionato era verde su uno SHA di PR precedente, non su HEAD. Non è quindi provato un passaggio CI completo sul commit
analizzato. [run CI HEAD](https://github.com/generalaction/emdash/actions/runs/38588618038) [run CI PR](https://github.com/generalaction/emdash/actions/runs/38492538130) Il
bootstrap ha canali per watchdog, recovery e report di avvio; i database separati e i buffer di editor danno persistenza locale a parti dello stato. Non ho verificato un recupero
crash end-to-end né la ripresa universale di ogni processo agente.
[codice: apps/emdash-desktop/src/entry/preload.ts:8-34](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/entry/preload.ts#L8-L34)
[codice: apps/emdash-desktop/src/core/features/editor/node/editor-buffer-service.ts:65-115](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/editor/node/editor-buffer-service.ts#L65-L115)
Sui progetti remoti, tmux può tenere vive le sessioni oltre la disconnessione; è una capacità opzionale e distinta dalla ripartenza del desktop.
[doc: https://emdash.com/docs/remote-development/remote-projects](https://emdash.com/docs/remote-development/remote-projects) Le release stabili e canary ravvicinate indicano un
ciclo di aggiornamento frequente; non ho trovato in queste note prova di un rollback automatico dell'app desktop. [Releases](https://github.com/generalaction/emdash/releases)

## Sicurezza e privacy
Il README dichiara che database, codice e chat restano localmente e non sono inviati ai server Emdash; le CLI degli agenti possono comunque trasmettere prompt e codice ai
rispettivi provider. La telemetria è disattivabile. [README](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/README.md#L72-L86) In produzione
la telemetria PostHog è attiva per default; gli eventi possono includere identificativi di account, progetto, task e conversazione, e dopo l'accesso associarsi all'email. Errori
possono includere messaggio e stack trace. [doc: https://emdash.com/docs/telemetry](https://emdash.com/docs/telemetry) Il codice accetta campi raw di eccezione, inclusi messaggio e
stack trace, troncati a 2.000 caratteri; l'implementazione esaminata non mostra una redazione di quei valori. Le performance vitals vengono raccolte in sessioni campionate al 5%.
[codice: apps/emdash-desktop/src/main/lib/telemetry.ts:98-200](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/main/lib/telemetry.ts#L98-L200)
[codice: apps/emdash-desktop/src/main/lib/telemetry.ts:441-490](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/main/lib/telemetry.ts#L441-L490) I
token GitHub e SSH gestiti dall'app passano da Electron safeStorage prima di essere salvati; su Linux viene rifiutato il backend basic_text invece di archiviare credenziali in
chiaro.
[codice: apps/emdash-desktop/src/main/host/secrets/encrypted-app-secrets-store.ts:19-93](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/main/host/secrets/encrypted-app-secrets-store.ts#L19-L93)
[codice: apps/emdash-desktop/src/main/host/linux-secret-storage.ts:1-39](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/main/host/linux-secret-storage.ts#L1-L39)
L'integrazione Claude usa la CLI locale e ne interroga lo stato di autenticazione o rileva ANTHROPIC_API_KEY; non emerge l'estrazione di token dal profilo. Auto-trust dei worktree
è attivo per default, mentre l'auto-approve dei permessi è separato e disattivato per default.
[codice: packages/plugins/src/agents/impl/claude/index.ts:137-178](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/plugins/src/agents/impl/claude/index.ts#L137-L178)
[codice: apps/emdash-desktop/src/core/features/tasks/contributions/settings.ts:14-24](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/tasks/contributions/settings.ts#L14-L24)
Il worktree isola le modifiche Git, ma non equivale a sandbox del sistema operativo. La finestra Electron principale imposta sandbox:false, con nodeIntegration:false e
contextIsolation:true; le webview browser sono invece sandboxed.
[codice: apps/emdash-desktop/src/main/host/window.ts:46-53](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/main/host/window.ts#L46-L53)
[codice: apps/emdash-desktop/src/main/host/browser/webview-security.ts:58-66](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/main/host/browser/webview-security.ts#L58-L66)
OAuth, hook agent e tunnel preview locali usano loopback, porte effimere o token; il flusso OAuth aggiunge state e PKCE S256.
[codice: apps/emdash-desktop/src/main/core/shared/oauth-flow.ts:14-51](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/main/core/shared/oauth-flow.ts#L14-L51)
[codice: packages/core/src/runtimes/tui-agents/node/hooks/hook-server.ts:17-73](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/core/src/runtimes/tui-agents/node/hooks/hook-server.ts#L17-L73)
Una vecchia issue su apertura di protocolli arbitrari, incluso file://, è stata corretta con una allowlist HTTP/HTTPS. Una segnalazione diversa sul quoting dei comandi SSH risulta
chiusa senza una traccia pubblica di fix, quindi resta non verificata. [issue #1001](https://github.com/generalaction/emdash/issues/1001)
[PR #1028](https://github.com/generalaction/emdash/pull/1028)
[codice: apps/emdash-desktop/src/main/core/app/service.ts:145-158](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/main/core/app/service.ts#L145-L158)
[issue #1198](https://github.com/generalaction/emdash/issues/1198) Nel clone non compare SECURITY.md e i metadati non indicano una security policy; questo non prova che non
esistano segnalazioni private o vulnerabilità. [Repo GitHub](https://github.com/generalaction/emdash)

## Estendibilità
Si possono aggiungere prompt, skills e server MCP stdio o HTTP, oltre a configurare file.emdash.json e script di setup/lifecycle per progetto.
[doc: https://emdash.com/docs/library/prompts](https://emdash.com/docs/library/prompts) [doc: https://emdash.com/docs/library/skills](https://emdash.com/docs/library/skills)
[doc: https://emdash.com/docs/library/mcp](https://emdash.com/docs/library/mcp) [doc: https://emdash.com/docs/project-config](https://emdash.com/docs/project-config) Gli hook
vengono installati nei percorsi di configurazione dei singoli CLI; questa estensibilità aggiunge strumenti e istruzioni ai provider già integrati.
[codice: packages/core/src/services/agent-plugins/node/hook-installer.ts:54-150](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/core/src/services/agent-plugins/node/hook-installer.ts#L54-L150)
Inferenza: aggiungere un provider agent nuovo richiede una modifica del bundle e del registry, perché i 37 adapter sono importati staticamente. Non emerge un SDK pubblico per
plugin provider caricabili dall'utente.
[codice: packages/plugins/src/agents/registry.ts:45-87](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/plugins/src/agents/registry.ts#L45-L87)

## Da prendere per Topics
Primo, rendere leggibili in una sezione Changes stato Changed/Staged, PR associate e check CI correnti; il vantaggio è avere il contesto del task senza inseguire finestre,
mantenendo il diff nel pannello editor.
[codice: apps/emdash-desktop/src/core/features/source-control/contributions/browser/changes-panel.tsx:45-54](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/source-control/contributions/browser/changes-panel.tsx#L45-L54)
[doc: https://emdash.com/docs/ci-checks](https://emdash.com/docs/ci-checks) Secondo, importare i commenti GitHub come contesto di review in sola lettura e tenere ben distinta
l'annotazione locale destinata all'agente; il confine evita di far credere che una nota sia stata pubblicata sulla PR.
[codice: apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/comments-list.tsx:26-83](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/comments-list.tsx#L26-L83)
[codice: apps/emdash-desktop/src/core/features/source-control/api/browser/diff-view/stores/draft-comments-store.ts:37-115](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/source-control/api/browser/diff-view/stores/draft-comments-store.ts#L37-L115)
Terzo, associare le note inline al task e richiederne l'aggiunta esplicita al prompt; è un modello semplice per guidare un agente su una riga senza trasformare il draft in una
review pubblica.
[codice: apps/emdash-desktop/src/core/features/conversations/browser/acp/acp-chat-panel.tsx:262-273](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/conversations/browser/acp/acp-chat-panel.tsx#L262-L273)
Quarto, tenere i check agganciati allo SHA head e verificare che il commit non cambi durante il refresh, evitando di presentare come correnti esiti appartenenti a una revisione
precedente.
[codice: apps/emdash-desktop/src/core/services/pull-requests/node/pull-request-service.ts:284-304](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/services/pull-requests/node/pull-request-service.ts#L284-L304)
Quinto, rendere visibili separatamente i retry di sessione, provisioning e push. È un pattern operativo riutilizzabile senza promettere una cronologia generale dei tentativi che il
codice esaminato non mostra.
[codice: apps/emdash-desktop/src/core/features/tasks/browser/main-panel.tsx:251-310](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/tasks/browser/main-panel.tsx#L251-L310)

## Da evitare
Non copiare l'idea che task paralleli equivalgano a conversazioni isolate: nello stesso task non è dimostrato un worktree per conversazione, quindi file condivisi possono creare
conflitto. [doc: https://emdash.com/docs/tasks](https://emdash.com/docs/tasks) Non confondere commenti inline con commenti di review pubblicati. In Emdash i primi sono bozze locali
passate all'agente e i secondi vengono letti dalla PR; una UI che li mescola rischia di promettere un'azione GitHub mai avvenuta.
[codice: apps/emdash-desktop/src/core/features/source-control/api/browser/diff-view/stores/draft-comments-store.ts:37-115](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/source-control/api/browser/diff-view/stores/draft-comments-store.ts#L37-L115)
[codice: apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/comments-list.tsx:26-83](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/source-control/browser/diff-view/changes-panel/components/pr-entry/comments-list.tsx#L26-L83)
Non trattare le issue storiche chiuse come una garanzia di performance: #3262 resta aperta, e i fix pubblici citati riguardano cause e configurazioni specifiche.
[issue #3262](https://github.com/generalaction/emdash/issues/3262) [PR #3073](https://github.com/generalaction/emdash/pull/3073) Non chiamare "isolamento" un worktree Git quando si
intende sandbox di processo. Emdash abilita anche auto-trust worktree per Claude, scelta che riduce attrito ma cambia il prompt di fiducia.
[README](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/README.md#L21-L37)
[codice: apps/emdash-desktop/src/core/features/tasks/contributions/settings.ts:14-24](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/tasks/contributions/settings.ts#L14-L24)
Per una promessa privacy, esplicitare opt-out e telemetria di default: il README local-first da solo non descrive gli eventi PostHog e i campi d'errore inviati.
[README](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/README.md#L72-L86)
[doc: https://emdash.com/docs/telemetry](https://emdash.com/docs/telemetry)

## Fonti
Repository e snapshot analizzato: [GitHub generalaction/emdash](https://github.com/generalaction/emdash) e
[commit 79f37d9](https://github.com/generalaction/emdash/tree/79f37d920bd576dc18ca5421856fd2cc9ec8abac). Documentazione consultata: [Tasks](https://emdash.com/docs/tasks),
[Diff View](https://emdash.com/docs/diff-view), [CI Checks](https://emdash.com/docs/ci-checks), [In-App Browser](https://emdash.com/docs/in-app-browser),
[Remote Projects](https://emdash.com/docs/remote-development/remote-projects), [Remote Tasks](https://emdash.com/docs/remote-development/remote-tasks),
[Providers](https://emdash.com/docs/providers), [Prompts](https://emdash.com/docs/library/prompts), [Skills](https://emdash.com/docs/library/skills),
[MCP](https://emdash.com/docs/library/mcp), [Project Config](https://emdash.com/docs/project-config), [Telemetry](https://emdash.com/docs/telemetry). README e release:
[README](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/README.md),
[release v1.2.8](https://github.com/generalaction/emdash/releases/tag/v1.2.8).

Codice centrale: [registry agent](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/plugins/src/agents/registry.ts#L1-L87),
[Changes panel](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/source-control/contributions/browser/changes-panel.tsx#L45-L54)
, [browser contract](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/core/features/browser/api/contract.ts#L11-L55),
[workflow CI](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/.github/workflows/code-consistency-check.yml#L1-L97),
[telemetry](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/apps/emdash-desktop/src/main/lib/telemetry.ts#L98-L200).

Performance e qualità: [issue #3262](https://github.com/generalaction/emdash/issues/3262), [issue #2987](https://github.com/generalaction/emdash/issues/2987),
[issue #2882](https://github.com/generalaction/emdash/issues/2882), [issue #2853](https://github.com/generalaction/emdash/issues/2853),
[issue #3070](https://github.com/generalaction/emdash/issues/3070), [issue #2153](https://github.com/generalaction/emdash/issues/2153),
[issue #2952](https://github.com/generalaction/emdash/issues/2952), [issue #2865](https://github.com/generalaction/emdash/issues/2865),
[PR #3073](https://github.com/generalaction/emdash/pull/3073). Sicurezza: [issue #1001](https://github.com/generalaction/emdash/issues/1001),
[PR #1028](https://github.com/generalaction/emdash/pull/1028), [issue #1198](https://github.com/generalaction/emdash/issues/1198).
