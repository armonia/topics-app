# Agor

## In tre righe

Agor è un workspace web multiplayer dove team e agenti AI lavorano insieme su board spaziali live,
con ogni attività ancorata a un branch git isolato dotato di ambiente e cronologia propri. Si
rivolge a team che usano già Claude Code, Codex, Gemini, Copilot, OpenCode o Cursor e vogliono riuso
condiviso di prompt, skill e memoria. Il punto più forte rispetto a Topics è la dimensione
multiplayer nativa: cursori live, terminale condiviso, gateway Slack e GitHub, scheduler, contro un
Topics single user in LAN.

## Identità

Repository `preset-io/agor`, descritto come multiplayer AI che riunisce team e agenti [README].
Creato il 2025-10-04, conta 1450 stelle e 132 fork [non verificato]. Il pacchetto npm si chiama
`agor-live` e le keyword dichiarate sono ai, agents, orchestration, session-management [codice:
package.json:9]. Licenza Business Source License 1.1, quindi source-available e non open source:
l'uso in produzione è permesso ma non la commercializzazione come orchestratore di agenti, con
conversione ad Apache 2.0 il 2029-01-15 [README]. Nota di metodo: per questa licenza il dossier
descrive tutto con parole proprie e non riusa codice. Ultimo commit il 2026-10-14 su consenso
implicito MCP [codice: commit `eee0108`]. Issue aperte ancora oggi, segno di sviluppo quotidiano
[issue #3095]. Ultima release npm v0.15.0 del 2026-03-28, con precedenti v0.14.x e v0.13.0
ravvicinate [release v0.15.0]. Piattaforme: Node.js da 22.12 e Git, CLI, web UI e Docker Compose,
più Agor Cloud in open beta gestita [README]. Maturità media: un anno di vita, monorepo grande e
molto attivo, ma con release pacchettizzate ferme a marzo mentre `main` avanza ogni giorno [release
v0.15.0]. Comunità su Discord, Discussions e issue, con impegno pubblico a correggere una issue per
ogni stella ricevuta [README].

## Architettura

Monorepo pnpm con Turbo: backend FeathersJS in `apps/agor-daemon` con REST più WebSocket più
endpoint MCP, UI React in `apps/agor-ui` con Ant Design più React Flow, CLI oclif in
`apps/agor-cli`, sito docs Nextra in `apps/agor-docs`, tipi condivisi e schema Drizzle in
`packages/core`, runtime agenti isolato in `packages/executor` [README]. I servizi del daemon
coprono Sessions, Tasks, Messages, Boards, Branches e Repos [README]. Misure sul clone `eee0108`:
4430 file totali, di cui TypeScript 2669 file per 689141 righe, TSX 848 file per 220542 righe, MJS
86 file per 18108 righe, CSS 35 file per 10245 righe, SQL 234 file per 9079 righe [non verificato].
Zero file Rust, Go o Python: niente codice nativo per la velocità, tutto gira su Node [non
verificato]. Il daemon possiede database, servizi ed eventi realtime; l'executor lancia gli agenti
come sottoprocessi isolati in locale o via template esterno [README]. Confermato l'uso di
`child_process.spawn` e di PTY via `@lydell/node-pty` per il terminale web [codice:
packages/executor/src/commands/zellij.ts:20]. Client e daemon parlano via Feathers su REST più
WebSocket, con endpoint MCP su HTTP [README]. Storage duale: SQLite via LibSQL di default in
`~/.agor/agor.db`, oppure Postgres, con worktree sotto `~/.agor/worktrees` [README] [codice:
apps/agor-daemon/src/index.ts:385]. La qualità è presidiata da script di barriera su multitenancy,
filesystem del daemon e confini realtime, oltre a typecheck, lint e build [codice: package.json:29].
Con l'agente parla tramite gli SDK nativi di ogni harness, non via `claude -p` in stream-json
[codice: packages/executor/package.json:45].

## Sessioni e task

Ogni lavoro è un branch con working directory, ambiente e conversazioni proprie, in genere un branch
per feature e PR [README]. Le sessioni sono conversazioni agente vincolate a un branch, con
genealogia: `fork` copia il contesto per esplorare alternative, `spawn` crea sotto sessioni a
contesto fresco [README] [codice: apps/agor-daemon/src/services/sessions.ts:1107]. Sessioni
parallele come righe indipendenti sotto lo stesso branch, task accodati per sessione con lock,
heartbeat e retry [non verificato]. Il task è l'unità accodabile, cioè un prompt con la sua
esecuzione [non verificato]. Le identità usano short ID dagli 8 caratteri iniziali di UUIDv7,
risolti al confine API [codice: context/concepts/id-management.md:25]. La board kanban lancia prompt
templati quando un branch viene trascinato in una zona [README]. Esistono entità Card in beta per
workflow non di codice [README]. Review e merge risultano solo metadati di branch con URL di PR,
senza un servizio CI dedicato [non verificato]. Manca il keep-awake su Mac durante le sessioni,
richiesto in issue aperta [issue #2006].

## Usabilità

Superfici: web UI desktop, UI mobile dedicata, CLI; niente app desktop nativa e niente TUI [README]
[codice: apps/agor-ui/src/components/mobile/]. Flusso principale: installazione npm, wizard di
onboarding che crea board e primo teammate, poi lavoro su canvas 2D con cursori live, facepile,
commenti e sessioni seguibili in diretta [README]. Chat ricca con blocchi tool strutturati,
selettori di modello e sforzo, chime di completamento e contabilità token e dollari per prompt con
storico durevole [README]. Diff e anteprima file in modale dedicata [non verificato]. Notifiche via
toast ed eventi di aggiornamento sessione [non verificato]. Scorciatoie da tastiera non documentate
nella guida letta [non verificato]. Screenshot dedicati mostrano board, home e sessione su telefono
[codice: apps/agor-docs/public/screenshots/mobile-board-demo.png]. Frizioni aperte: titolo
automatico preso dalle istruzioni degli allegati invece che dal prompt [issue #3071], link short-ID
che ricadono sulla Home in caso di prefissi ambigui [issue #3070], menu di creazione da ripensare su
desktop e mobile [issue #2965], contrasto della facepile [issue #2910]. Richieste di contorno:
immagini nella knowledge base [issue #2879] e icone personalizzate per gli assistenti [issue #2876].

## Browser e anteprima

Nessun browser integrato pilotabile dall'agente: non esiste nulla di simile al WKWebView di Topics
né al co-browse fra dispositivi, la presence è solo cursori e facepile sulla board [README]. Le
anteprime seguono due strade: artifact live sulla board via Sandpack con pagina fullscreen dedicata,
e dev server reali per branch con URL cliccabili [non verificato]. Le porte sono deterministiche da
template, con `APP_PORT` derivata dall'identificativo univoco del branch così i branch paralleli non
collidono [codice: apps/agor-docs/content/guide/environment-configuration.mdx:64]. Chi ispeziona il
risultato apre l'URL esterno, non un pannello browser interno [non verificato]. Gli artifact basati
su template React possono fallire con overlay di errore poco diagnostico [issue #2640].

## Terminale, editor, file

Terminale web condiviso e multiplayer basato su xterm, dietro flag di ruolo `webTerminalEnabled`
[codice: apps/agor-ui/src/App.tsx:2048]. Editor CodeMirror caricato in lazy, limitato a json, yaml e
markdown [non verificato]. Knowledge base markdown condivisa e ricercabile per decisioni, runbook e
memoria agente [README]. Variabili d'ambiente e credenziali per branch e per utente [README].
Recupero dedicato per il filesystem del branch dopo incidenti [non verificato]. Punto dolente: il
terminale embedded ha rendering lento e si blocca alla riconnessione, senza backpressure né renderer
GPU [issue #1919].

## Remoto e mobile

Si avvia con `agor daemon start` e `agor open`, con comando `install` per cambiare o riparare gli
strumenti agentici senza reinizializzare [README]. Porte configurabili di default 3030 per il daemon
e 5173 per la UI [codice: apps/agor-daemon/src/index.ts:349]. Esiste una UI mobile dedicata con
pagine board e sessioni [codice: apps/agor-ui/src/components/mobile/]. Agor Cloud offre hosting
gestito in open beta per chi non vuole self-hostare [README]. Il Message Gateway raggiunge i
teammate da Slack, Discord, GitHub e altri canali senza aprire la board [README]. Trasporto solo in
uscita: Slack via Socket Mode, Discord via Gateway, GitHub via polling API, senza webhook pubblici
da esporre [codice: apps/agor-docs/content/guide/message-gateway.mdx:25]. I messaggi Slack sono
mappati agli utenti via email, con sessioni attribuite e audit trail [codice:
apps/agor-docs/content/guide/message-gateway.mdx:23]. Niente cifratura end to end documentata oltre
il TLS di trasporto [non verificato].

## Provider e protocolli

Sei harness intercambiabili per sessione: Claude Code, Codex, Gemini, Copilot, OpenCode e Cursor in
beta, con matrice comparativa pubblica [codice: apps/agor-docs/content/guide/sdk-comparison.mdx:72].
Streaming di testo e tool per tutti tranne Codex, che emette solo eventi tool [codice:
apps/agor-docs/content/guide/sdk-comparison.mdx:74]. SDK pinnati nel runtime: Claude Agent SDK
0.3.288 e Codex SDK 0.160.0 [codice: packages/executor/package.json:45]. Copilot gira via spawn del
binario CLI con ambiente sostituito, OpenCode in modalità client-server, Cursor con runtime locale
[non verificato]. ACP non risulta citato nella matrice pubblica [non verificato]. MCP in tre parti:
server interno che espone Agor stesso agli agenti, catalogo curato da YAML con audit dedicato,
gateway egress mediato con capability [README] [codice: package.json:24] [codice:
apps/agor-daemon/src/register-routes.ts:1019]. Il catalogo cresce su richiesta, con voci proposte
dagli utenti [issue #3068]. Porta il tuo provider e abbonamento, nessun modello proprio e nessun
lock-in [README]. Frizioni: modelli Claude da scoprire via SDK invece che con una PR per modello
[issue #2819], slash command solo CLI da nascondere nelle sessioni SDK [issue #2938], Gemini ancora
da stabilizzare [issue #2852].

## Performance

Nessun benchmark pubblico trovato [non verificato]. Le lamentele degli utenti sono pesanti sul
frontend: tab Safari che arriva a 11 o 12 GB dopo una notte aperta [issue #2757], con follow-up
dedicati su memoria di frontend e transcript [issue #3077] [issue #3000]. Time-to-interactive lento
al primo caricamento [issue #2213], homepage che si blocca e quasi manda in crash il browser [issue
#2171]. Query messaggi con timeout a 60 secondi sui daemon grandi [issue #2061], navigazione Home
lenta poi risolta [issue #1768]. Clone di grandi repository con timeout a 5 minuti e processo git
orfano che continua a girare [issue #2030]. Niente Rust né virtualizzazione liste dedicata a
mitigare, solo lazy loading e batching realtime [non verificato]. Lato positivo: scheduler con dedup
e senza backfill evita tempeste di run dopo un downtime [codice:
apps/agor-docs/content/guide/scheduler.mdx:33].

## Affidabilità e qualità

Misurati 1555 file di test `*.test.*` e `*.spec.*` su 4430 file totali, con forte concentrazione in
UI ed executor [non verificato]. Recupero filesystem del branch dedicato, riconciliazione dei task
terminali al focus, dedup delle run pianificate con sola ultima esecuzione dopo downtime [non
verificato] [codice: apps/agor-docs/content/guide/scheduler.mdx:33]. Ma le issue mostrano fragilità
di lifecycle: cancellazione branch che resta appesa in `deleting` con retry bloccato [issue #3079],
branch incastrati in `creating` senza via d'uscita [issue #3051], archiviazione che fallisce per
stati gestiti internamente [issue #2771]. Rimozione sessione che lascia copie residue nei bucket di
altri branch [issue #3076], archiviazione che nasconde sessioni con task incompiuti [issue #3095].
Executor che perde contatto o va in crash senza avvisare Slack [issue #2817] [issue #2052]. Falsi
negativi frequenti di conferma risposta, con retry suggerito che rischia la doppia esecuzione [issue
#2975] [issue #2976]. Fallimenti di run pianificate poco visibili sullo schedule [issue #2989].
Upgrade offline abortiti da migrazioni incoerenti [issue #2954] e indici SQLite persi nei rebuild di
tabella [issue #3094].

## Sicurezza e privacy

Porta il tuo provider: usa credenziali e abbonamenti esistenti, senza modello proprietario che veda
i prompt [README]. Credenziali ed env var per utente e per branch, con RBAC a scoping di branch
[README]. Modalità di esecuzione esplicite: locale fidata, sandbox fail-closed, o delegata esterna
[README]. Condivisione delle sessioni limitata ai branch di casa e con opt-in [non verificato]. CORS
con header dedicato al token MCP [codice: context/concepts/security.md:76]. Telemetria configurabile
via `AGOR_TELEMETRY` o config operatore [codice: apps/agor-daemon/src/index.ts:279]. Gateway con
credenziali cifrate a riposo e trasporto solo in uscita, quindi nessuna porta pubblica da aprire
[non verificato]. Rischi aperti: troncamento silenzioso dei messaggi Slack prima del prompt, di
gravità P1 [issue #2744], e segreti OAuth gestiti solo come basic auth contro provider che esigono
post [issue #2725].

## Estendibilità

Agor espone se stesso via MCP così gli agenti creano fork, spawn, schedule e report da soli
[README]. Catalogo MCP curato con audit dedicato e connessione guidata [codice: package.json:24].
Teammate persistenti con namespace di memoria, skill catturate dal lavoro ripetibile, canali gateway
e schedule cron [README]. Scheduler con builder visuale di cron e template di prompt, con heartbeat
via file dedicato [codice: apps/agor-docs/content/guide/scheduler.mdx:3]. Hook di sistema non
documentati nella guida letta [non verificato].

## Da prendere per Topics

1. Matrice SDK pubblica con streaming, permessi e costi per harness [codice:
apps/agor-docs/content/guide/sdk-comparison.mdx:72]: dire cosa funziona per provider evita sorprese
quando Topics aggiunge un motore.
2. Fork e spawn con genealogia esplicita [codice: apps/agor-daemon/src/services/sessions.ts:1107]:
esplorare alternative senza sporcare il topic corrente, con storia navigabile.
3. Zone che sparano prompt template al drop [README]: la kanban di Topics potrebbe lanciare review o
land al cambio colonna.
4. Scheduler cron con dedup e senza backfill [codice:
apps/agor-docs/content/guide/scheduler.mdx:33]: standup e audit ricorrenti senza tempeste di run.
5. Contabilità token e dollari per prompt con storico durevole [README]: controllo spesa che a
Topics manca.
6. Porte deterministiche per anteprima per branch [codice:
apps/agor-docs/content/guide/environment-configuration.mdx:64]: anteprime parallele per topic senza
collisioni.
7. Gateway solo in uscita via Socket Mode e polling [codice:
apps/agor-docs/content/guide/message-gateway.mdx:25]: pilotare Topics da telefono senza esporre
porte né relay.
8. Egress MCP mediato con capability opache [codice: apps/agor-daemon/src/register-routes.ts:1019]:
dare tool agli agenti senza far trapelare credenziali nel server MCP di Topics.
9. Short ID a 8 caratteri da UUIDv7 [codice: context/concepts/id-management.md:25]: deep link corti
ai topic.
10. Knowledge base markdown condivisa come memoria durevole [README]: decisioni e runbook riusabili
fra topic e fra agenti.

## Da evitare

1. Riuso di codice Agor: la BSL 1.1 vieta di offrirne l'orchestrazione a terzi come prodotto,
restare a descrizione e idee [README].
2. Frontend obeso: 11 o 12 GB di tab, TTI lento e homepage che si blocca [issue #2757] [issue #2213]
[issue #2171]; pesare ogni realtime e virtualizzare le liste lunghe.
3. Conferme ambigue con retry pericoloso: il falso negativo che invita a rieseguire rischia effetti
doppi [issue #2975]; servono risposte idempotenti.
4. Stati lifecycle senza uscita: branch incastrati in `creating` o `deleting` [issue #3051] [issue
#3079]; ogni stato deve avere una transizione terminale garantita.
5. Migrazioni testate solo su installazioni fresche: upgrade offline abortiti e indici persi [issue
#2954] [issue #3094]; provare sempre l'upgrade dalla release precedente.
6. Executor che muore in silenzio con processi orfani: crash mai recapitati e clone git abbandonati
[issue #2052] [issue #2030]; ogni morte di agente deve generare notifica con causa e cleanup.

## Fonti

- Repository: https://github.com/preset-io/agor
- SHA del clone: `eee010845e48120ad877e8f27bb0999d16c18eab`
- README e architettura:
https://github.com/preset-io/agor/blob/eee010845e48120ad877e8f27bb0999d16c18eab/README.md
- Porte e worktree:
https://github.com/preset-io/agor/blob/eee010845e48120ad877e8f27bb0999d16c18eab/apps/agor-daemon/src/index.ts#L349
- Fork sessioni:
https://github.com/preset-io/agor/blob/eee010845e48120ad877e8f27bb0999d16c18eab/apps/agor-daemon/src/services/sessions.ts#L1107
- SDK pinnati:
https://github.com/preset-io/agor/blob/eee010845e48120ad877e8f27bb0999d16c18eab/packages/executor/package.json#L45
- Spawn e PTY:
https://github.com/preset-io/agor/blob/eee010845e48120ad877e8f27bb0999d16c18eab/packages/executor/src/commands/zellij.ts#L20
- Egress MCP:
https://github.com/preset-io/agor/blob/eee010845e48120ad877e8f27bb0999d16c18eab/apps/agor-daemon/src/register-routes.ts#L1019
- Matrice SDK:
https://github.com/preset-io/agor/blob/eee010845e48120ad877e8f27bb0999d16c18eab/apps/agor-docs/content/guide/sdk-comparison.mdx#L72
- Scheduler:
https://github.com/preset-io/agor/blob/eee010845e48120ad877e8f27bb0999d16c18eab/apps/agor-docs/content/guide/scheduler.mdx#L33
- Gateway:
https://github.com/preset-io/agor/blob/eee010845e48120ad877e8f27bb0999d16c18eab/apps/agor-docs/content/guide/message-gateway.mdx#L25
- Guide: https://agor.live/guide/architecture, https://agor.live/guide/boards,
https://agor.live/guide/sessions
- Issue citate: #1919, #2006, #2030, #2052, #2061, #2171, #2213, #2640, #2725, #2744, #2757, #2771,
#2817, #2819, #2852, #2876, #2879, #2910, #2938, #2965, #2975, #2976, #2989, #3000, #3051, #3068,
#3070, #3071, #3076, #3077, #3079, #3094, #3095
