# Copertura di Topics rispetto ai concorrenti

Confronto funzione per funzione fra Topics e quattro prodotti che fanno, in
tutto o in parte, lo stesso mestiere: far lavorare agenti di codice su un
repository e farti rivedere il risultato.

**Data della rilevazione: 2026-09-06.** Le documentazioni dei concorrenti si
muovono ogni settimana (durante questa rilevazione le docs di Claude Code sono
migrate su `code.claude.com` e quelle di Codex su `learn.chatgpt.com`): una riga
qui vale quanto la sua data.

## Metodo, e cosa questo documento non e'

- **Colonna Topics**: ogni casella cita una spec in `openspec/specs/*` o un file
  di questo repository. Nessuna riga si basa su un ricordo.
- **Colonne concorrenti**: solo documentazione ufficiale o changelog del
  prodotto, con l'URL. Dove la fonte non dice niente si legge
  `no (non doc.)`, che significa "non documentato", non "non esiste".
- Conductor pubblica poco: diverse righe si appoggiano ai **titoli** delle voci
  di changelog, che attestano l'esistenza della funzione e non il suo
  comportamento. Sono marcate `(titolo)`.
- Questo non e' un giudizio di qualita'. Dice chi ha una funzione, non chi la fa
  meglio: due prodotti con "si" sulla stessa riga possono essere lontanissimi.

Legenda: `si` presente e documentato · `parz.` presente ma limitato o solo su
una superficie · `no` assente · `no (non doc.)` nessuna fonte ufficiale trovata.

## La tabella

| Funzione | Topics (prova) | Claude Code | Codex | Cursor | Conductor |
|---|---|---|---|---|---|
| Topic/workspace persistente | **si** `openspec/specs/topics/spec.md` TOPIC-01, TOPIC-WT-01; ripresa a freddo `openspec/specs/resume-on-boot/spec.md` | si (sessioni per directory, `--continue/--resume`) | si (`codex resume`, `codex fork`) | si (`agent ls/resume`) | si (workspace per task) |
| Board kanban dei task | **si** `openspec/specs/kanban/spec.md` KANBAN-01..40, `server/routes/tasks.ts` | parz. (agent view a stati, non colonne) | no (non doc.) (Activity view) | no (non doc.) (Agents Window) | parz. (titolo: Workspaces Page, Workspace Status) |
| Dispatch automatico su una coda | **si** KANBAN-07, KANBAN-10, KANBAN-16, `server/services/dispatch-capacity.ts` | parz. (routines, background sessions) | parz. (automations schedulate) | parz. (trigger Slack/Linear/GitHub) | parz. (titolo: Dispatcher) |
| Goal dichiarato che sopravvive al turno | **si** `openspec/specs/context/spec.md` CTX-GOAL-01..03, `server/services/goal-loop.ts` (giudice + freni), MISSION-01 | si (`/goal`, giudice a ogni turno) | si (`/goal` in app, CLI, IDE) | si (`/goal`, in rollout) | parz. (titolo: Codex goal support) |
| Todo list dell'agente a schermo | **si** `openspec/specs/chat/spec.md` TODO-01..03; anche il runtime nativo la scrive (`server/providers/native/tools.ts`, `todo_write`) | si (task list, `Ctrl+T`) | parz. (`update_plan` spento di default) | no (non doc.) (piano markdown) | si (titolo: Todos) |
| Sotto-agenti | **si** `openspec/specs/chat/spec.md` SUBAGENT-01..07, `openspec/specs/processes/spec.md` SUBAGENT-03, tool `spawn_agent` in `server/mcp/topics-mcp-server.ts` | si (`.claude/agents`, tetto 20, `isolation: worktree`) | si (built-in + TOML in `.codex/agents`) | si (`.cursor/agents`, worktree o VM) | parz. (quelli della CLI ospitata) |
| Sotto-agente isolato in un worktree suo | **no**: il figlio eredita la cartella del padre (`spawn_agent`, campo `cwd`) | si (`isolation: worktree`) | parz. (worktree per chat nell'app) | si (subagent su worktree/VM) | no (non doc.) |
| Checkpoint della conversazione | **si** `openspec/specs/chat/spec.md` CHAT-05, `server/routes/checkpoints.ts` | si (`/rewind`, 100 punti) | parz. (undo per edit) | no (il restore tocca solo i file) | si (titolo: Checkpoints) |
| Checkpoint dell'albero di lavoro | **si** `server/routes/checkpoints.ts` (`git restore --source`, auto-stash) + automatici per turno (`server/services/turn-checkpoints.ts`) | si (ma non le modifiche fatte da bash) | parz. (snapshot del worktree prima della cancellazione) | si (snapshot dei file) | si (titolo: Codex Checkpoints) |
| Hook di ciclo di vita configurabili dall'utente | **parz.**: Topics *riceve* gli hook di Claude Code (`openspec/specs/claude-sessions/spec.md` CCS-02, CCS-06, `server/routes/claude-hooks.ts`), ma non espone eventi propri sul runtime nativo ne' sul dispatch | si (oltre 30 eventi, `settings.json`) | si (`hooks.json`, con trust) | si (18 eventi, `hooks.json`) | si (titolo: Run script, hooks) |
| Worktree git per agente | **si** `openspec/specs/worktrees/spec.md` WORKTREE-01..13, `server/routes/worktrees.ts` | si (`--worktree`) | si (uno per chat nell'app) | si (`/worktree`, tetto 25) | si (workspace isolato per task) |
| Browser integrato pilotabile dall'agente | **si** `openspec/specs/remote-browser/spec.md` BROWSER-01, BROWSER-02, BROWSER-CHAT-03, BROWSER-CHAT-04 | si (estensione Chrome, pane sul desktop) | si (app e web, non in CLI) | si (browser integrato per workspace) | parz. (titolo: browser preview) |
| Terminale persistente che sopravvive al riavvio | **si** `openspec/specs/terminal/spec.md` TERM-01, TERM-04, TERM-05, TERM-06 | parz. (pane sul desktop; in CLI muore con la sessione) | parz. (voce di menu, non documentata) | no (non doc.) | si (terminale per workspace) |
| Notifiche e push | **si** `openspec/specs/notifications/spec.md` PUSH-01..04, QUIET-01, `server/routes/push.ts` | si (push mobile, notifica OS) | si (desktop, TUI `notify`, web) | si (push iOS, Live Activities) | parz. (suoni, stato, non letto) |
| Condivisione con altri (ospiti/team) | **si** `openspec/specs/sharing-guests/spec.md` GUEST-01..08, PRJSHARE-01 | si (sessioni web Private/Team/Public) | parz. (ambienti cloud con sharing) | si (link al cloud agent, trascritti condivisi) | parz. (titolo: multiplayer, chat links) |
| Review umana con gate prima del merge | **si** `openspec/specs/kanban/spec.md` KANBAN-05, KANBAN-11, KANBAN-15; land locale `openspec/specs/landing/spec.md` LAND-01..10 | parz. (Code Review commenta, non blocca) | parz. (review prima della PR, non blocca) | parz. (Bugbot, check configurabile) | si (diff, PR, merge, checks) |
| Aggancio a GitHub: PR, commenti, check | **no**: nessuna rotta o servizio tocca le PR (grep su `server/`, `client/src`) | si (Actions, `@claude`, code review) | si (`@codex review` sulle PR) | si (Bugbot con check run) | si (titolo: PR Checks, Stacks) |
| Esecuzione cloud o handoff su altra macchina | **no**: il relay da' accesso *alla tua* macchina (`openspec/specs/relay/spec.md`, `openspec/specs/remote-access/spec.md` PAIRING-01..04), non calcolo altrove | si (`--cloud`, `--teleport`) | si (container OpenAI, `codex apply`) | si (Cloud Agents in VM) | parz. (titolo: Conductor Cloud) |
| MCP come client | **si** `openspec/specs/commands/spec.md` MCPSRV-01..04 (stdio vero, OAuth, elenco vivo) | si (stdio/http/sse, OAuth) | si (stdio, HTTP, OAuth) | si (stdio/SSE/HTTP, marketplace) | si (titolo: MCPs) |
| Il prodotto stesso come server MCP | **si** `server/mcp/topics-mcp-server.ts` (board, topic, browser, processi, domande), KANBAN-06 | si (`claude mcp serve`) | parz. (app-server, `mcp-server` deprecato) | no (non doc.) | si (titolo: Conductor MCP) |
| Permessi e approvazioni sui tool | **si** `openspec/specs/questions/spec.md` PERM-01..08, `openspec/specs/agent-runtime/spec.md` RT-07, `server/providers/native/permissions.ts` | si (modi, regole allow/deny) | si (policy di approvazione granulari) | si (Run Modes con classificatore) | parz. (titolo: Tool Approval) |
| Sandbox a livello di sistema operativo | **no**, ed e' dichiarato: `server/providers/native/permissions.ts` dice "NON E' UNA SANDBOX"; per Codex si passa `--sandbox workspace-write` alla sua CLI (`server/providers/codex/args.ts`) | si (Seatbelt, bubblewrap) | si (Seatbelt, Landlock+seccomp, rete chiusa) | si (Seatbelt, Landlock+seccomp) | no (non doc.) |
| Piu' motori diversi, anche di altri fornitori | **si** `openspec/specs/agent-runtime/spec.md` RT-06, RT-10, ACP-01..05, `server/providers/` (claude-code, codex, nativo, ACP) | no (solo modelli Claude) | no (solo modelli OpenAI) | parz. (multi-modello dentro Cursor) | si (Claude Code, Codex, Cursor, OpenCode) |
| Piu' tentativi in parallelo sullo stesso task | **si** KANBAN-13, KANBAN-14 (fan-out con scelta umana del vincitore) | parz. (sessioni parallele, scelta a mano) | parz. (task cloud paralleli) | si (`/best-of-n`) | no (non doc.) |
| Costo e consumo per sessione | **si** `openspec/specs/usage/spec.md` USAGE-01..08, tetti di spesa per task (`server/routes/task-spend-caps.ts`), cruscotto DASH-01 | si (`/usage`, `--max-budget-usd`, dashboard team) | parz. (limiti residui, non dollari) | parz. (dashboard team, non per sessione) | parz. (titolo: AI Response Metadata) |
| Finestra di rate limit dell'abbonamento a schermo | **no**: l'evento della CLI e' classificato rumore (`server/providers/claude/events.test.ts`, `classifyStreamLine(RATE_LIMIT).kind === "noise"`) | si (`/usage` con finestre) | si (`/status` con finestre 5h e settimana) | no (non doc.) | no (non doc.) |
| Accesso da fuori e da telefono | **parz.**: web app raggiungibile via relay e pairing, gesti touch (`openspec/specs/touch-gestures/spec.md`), push web; nessuna app nativa | si (app iOS/Android, Remote Control) | si (app ChatGPT pilota il Mac) | si (app iOS nativa, PWA) | no (non doc.) |
| Regole del progetto lette dai file | **si** `server/context/assemble.ts` (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `README.md`) | si (`CLAUDE.md`) | si (`AGENTS.md`) | si (`.cursor/rules`, `AGENTS.md`) | si (via CLI ospitata) |
| Comandi e skill dell'utente | **si** `openspec/specs/commands/spec.md` SKILL-01..04 (scoperti dalle cartelle note, corpo letto dietro un cancello di percorso) | si (skill, slash command) | si (skill, developer commands) | si (comandi, regole) | no (non doc.) |
| Lavori schedulati | **si** `openspec/specs/cron-jobs/spec.md` CRON-01, `server/routes/cron.ts`; piu' il turno di notte NIGHT-01..04 | si (routines) | si (automations) | parz. (trigger esterni) | no (non doc.) |
| Piattaforme | **si** macOS, Windows, Linux (`desktop-tauri/`, `playwright.windows.config.ts`) | si (macOS, Linux, Windows) | si | si | no: solo macOS |

## Dove Topics e' avanti, e conviene saperlo

Non e' il tema della card, ma serve a pesare i buchi: quattro cose che i
concorrenti non hanno, o hanno a meta'.

1. **La board e' il prodotto, non una vista.** Coda, dispatch, capacita', gate
   umano di consegna, verifica delle rivendicazioni prima della review
   (KANBAN-11, KANBAN-15). Gli altri hanno liste di sessioni.
2. **Approva, atterra, pubblica sono tre gesti distinti** (LAND-01..10). Altrove
   "review" finisce in una PR aperta dall'agente, o in un auto-merge.
3. **Terminale e browser vivono nel prodotto e sopravvivono al riavvio**
   (TERM-05, BROWSER-CHAT-01), con lo scrollback intero.
4. **Piu' motori diversi in casa** (RT-06, ACP): Claude Code e Codex vendono se'
   stessi, Cursor vende il proprio agente. Solo Conductor gioca la stessa
   partita, e solo su Mac.

## I dieci buchi, in ordine di valore

Il valore e' quanto costa oggi la mancanza a chi usa Topics tutti i giorni, non
quanto e' di moda la funzione. Fra parentesi la taglia stimata.

1. **Hook di ciclo di vita propri** (M). Oggi l'unico modo di infilare una
   propria regola fra l'agente e il repository e' modificare Topics. Tutti e tre
   i concorrenti maggiori hanno un elenco di eventi documentato con la capacita'
   di bloccare (`exit 2` in Claude Code, `deny` in Cursor). E' la funzione che
   trasforma un prodotto in una piattaforma, e Topics ha gia' i punti di
   aggancio interni (fine turno, pre-tool, consegna) sparsi nel codice.
2. **Il tetto della finestra di abbonamento a schermo** (S). Con le CLI in
   abbonamento il vincolo vero non e' il dollaro, e' la finestra a cinque ore.
   Topics conta i dollari benissimo (USAGE-01..08) e butta via l'unico dato che
   dice quando ti fermerai: `rate_limit_event` e' classificato rumore. Con
   quattordici card in volo, sapere che la finestra e' all'80% cambia cosa
   dispacci adesso.
3. **Sandbox a livello di sistema operativo** (L). Il file dei permessi lo
   scrive gia': "NON E' UNA SANDBOX". Va bene contro l'errore, non contro un
   `curl | sh` in un repository che non hai scritto tu. Gli altri tre usano
   Seatbelt e Landlock, e Codex chiude la rete di default. Su una macchina dove
   girano agenti dispacciati di notte, e' la differenza fra un danno e un
   incidente.
4. **Sotto-agenti nel proprio worktree** (M). Un figlio oggi scrive nella
   cartella del padre: due figli sullo stesso task si pestano i piedi, e il
   fan-out (KANBAN-13) non arriva sotto il livello del task. Claude Code lo ha
   risolto con `isolation: worktree`, Cursor mandando i subagent su worktree o
   VM.
5. **Aggancio a GitHub: PR, commenti, check** (L). Topics atterra in locale, e
   per una persona sola e' meglio. Ma chi lavora in team vive sulle PR: nessuna
   review di Topics arriva dove il team guarda, e nessun check di Topics puo'
   entrare in una branch protection. E' il buco che impedisce di venderlo a un
   gruppo.
6. **Esecuzione fuori da questa macchina** (XL). Chiudere il portatile ferma
   tutto. I tre concorrenti maggiori hanno il cloud; qui non serve il cloud,
   serve **una seconda macchina**: dispacciare una card su un altro nodo gia'
   accoppiato (`openspec/specs/machines/spec.md` esiste gia') e' un decimo del
   lavoro e copre il caso vero.
7. **Un giudizio sul comando rischioso, non solo una lista** (M). RT-07 ha una
   lista statica di irreversibili. Cursor fa valutare ogni comando da un modello
   piccolo prima di eseguirlo in modalita' automatica. Una lista non riconosce
   `find . -delete`, ne' un `git push --force` scritto con altre parole.
8. **App per telefono, o almeno le decisioni dal telefono** (M). Il pairing e il
   push web ci sono; quello che manca e' arrivare da una notifica alla risposta
   di una domanda in due tocchi (PERM-07 su schermo corto). Gli altri hanno
   applicazioni native, e Cursor mette gli agenti in corso sulla lock screen.
9. **Piano modificabile prima di approvarlo** (S). PERM-03 fa approvare o
   rifiutare un piano. Cursor lo scrive in un file markdown che puoi correggere
   prima di dire vai: correggere due righe costa meno che rifiutare e rispiegare.
10. **Ripresa di una sessione altrui e portabilita'** (S). EXTSESS-04 adotta le
    sessioni esterne, ma non esiste l'inverso: portare fuori un topic (storia,
    goal, checkpoint) in un formato che un'altra macchina possa riprendere. Vibe
    Kanban ha chiuso e ha dovuto dare l'export dei dati; e' la funzione che
    rende accettabile provare il prodotto.

## Le cinque card proposte

Le prime cinque, gia' create in **backlog** (non in todo: la promozione la fa una
persona).

### 1. Hook di ciclo di vita configurabili
- **Card**: `1fb2de01-5dfa-42b6-8458-43efc807724b`
- **Cosa succede**: un file di configurazione dichiara comandi da eseguire su
  eventi nominati (prima di un tool, fine turno, consegna di un task, creazione
  di un worktree). Un'uscita diversa da zero blocca l'azione e il motivo arriva
  in chat. Vocabolario di eventi chiuso, come CTRLTOOL-01 fa per i tool.
- **Dove guardare**: `server/providers/native/permissions.ts` (il punto dove si
  decide), `server/services/goal-continuation.ts` (fine turno),
  `server/routes/claude-hooks.ts` (la forma del payload esiste gia' per gli hook
  in arrivo da Claude Code).
- **Come si verifica**: un hook che rifiuta `bash` con un messaggio, e quel
  messaggio si legge nella chat; un hook lento non blocca il turno oltre il suo
  tetto; un hook malformato non impedisce l'avvio.

### 2. La finestra di rate limit dell'abbonamento, a schermo
- **Card**: `1ce95c19-0cfe-4359-8836-97a3dd323880`
- **Cosa succede**: `rate_limit_event` smette di essere rumore. Percentuale usata
  e istante di reset finiscono sulla fascia di stato e nella decisione di
  dispatch: sopra una soglia la coda rallenta invece di bruciare la finestra.
- **Dove guardare**: `server/providers/claude/events.ts` e la sua fixture
  `events.fixture.ts` (il campo e' `rate_limit_info`), `openspec/specs/usage/spec.md`,
  `server/services/dispatch-capacity.ts`.
- **Come si verifica**: una prova che dia in pasto l'evento vero e legga la
  percentuale sulla fascia; una che, con la finestra quasi piena, fa aspettare
  il dispatch invece di partire.

### 3. Sotto-agenti con il loro worktree
- **Card**: `bcbdb959-2d86-45b2-8dbb-e2e9fcdc77c2`
- **Cosa succede**: `spawn_agent` accetta di nascere su un worktree proprio,
  generato con lo stesso meccanismo delle card (WORKTREE-01, WORKTREE-08), e
  alla fine il padre vede il ramo del figlio invece di trovarsi i file mescolati.
- **Dove guardare**: `server/mcp/topics-mcp-server.ts` (parametro `cwd`),
  `server/routes/worktrees.ts`, `openspec/specs/worktrees/spec.md`.
- **Come si verifica**: due figli che scrivono lo stesso file non si sovrascrivono;
  chiudendo il figlio il worktree si pulisce secondo WORKTREE-09; il padre legge
  il ramo del figlio.

### 4. Dispatch di una card su una seconda macchina
- **Card**: `195d00e5-e05c-4bcf-ae3f-e6e623adac07`
- **Cosa succede**: una card puo' partire su un nodo gia' accoppiato invece che
  su questa macchina. Il portatile chiuso non ferma il lavoro, e la board
  continua a mostrare stato, commenti e consegna come per una card locale.
- **Dove guardare**: `openspec/specs/machines/spec.md` (MACHINE-01, CORES-01),
  `openspec/specs/relay/spec.md`, `server/services/dispatch-capacity.ts`,
  `openspec/specs/kanban/spec.md` KANBAN-16 (attesa del carico).
- **Come si verifica**: una card che gira su un secondo nodo arriva in review con
  il suo ramo; il nodo che sparisce a meta' non lascia la card appesa; il carico
  che decide e' quello del nodo che esegue.

### 5. Il piano si corregge prima di approvarlo
- **Card**: `897f256b-4555-448e-9c69-7d9b2ec2b011`
- **Cosa succede**: il piano prodotto in modalita' di pianificazione diventa un
  testo modificabile nel pannello di approvazione. Approvare il piano corretto
  invia quello, non quello che il modello aveva scritto.
- **Dove guardare**: `openspec/specs/questions/spec.md` PERM-03 e PERM-05,
  ASK-07 (la bozza per domanda esiste gia', con scadenza).
- **Come si verifica**: piano modificato e approvato, e il turno successivo cita
  il testo corretto; nessuna preselezione dell'approvazione (PERM-03 resta);
  chiudendo il pannello la modifica non si perde.

## Nota su Vibe Kanban

Era il concorrente piu' vicino per forma (board kanban, un worktree per task,
dieci CLI diverse) ed e' stato sostituito da Conductor in questa tabella perche'
il 2026-04-10 ha annunciato la chiusura: i servizi remoti restano trenta giorni,
poi resta un'architettura solo locale, e le funzioni di squadra (issue kanban,
commenti, organizzazioni) vengono rimosse.
<https://www.vibekanban.com/blog/shutdown>. Le pagine cloud delle sue docs sono
ancora online senza avviso: non fanno testo. Vale la pena rileggerlo per due
motivi: e' la prova che la parte kanban da sola non tiene in piedi un prodotto,
e ha dovuto consegnare l'export dei dati (buco numero 10).

## Fonti

- Claude Code: <https://code.claude.com/docs/en/overview> (checkpointing, hooks,
  sub-agents, worktrees, goal, tasks, sessions, permissions, sandboxing, costs,
  claude-code-on-the-web, remote-control, mobile, code-review, agent-view).
- Codex: <https://learn.chatgpt.com/docs> (long-running-work, hooks, subagents,
  environments/git-worktrees, browser, notifications, remote, cloud,
  agent-approvals-security, extend/mcp, third-party/github, pricing, app).
- Cursor: <https://cursor.com/docs> (agent/overview, agent/subagents,
  agent/chat/checkpoints, hooks, configuration/worktrees, agent/tools/browser,
  agent/tools/terminal, agent/security/run-modes, cloud-agent, cloud-agent/mobile,
  bugbot, context/mcp, account/teams/analytics).
- Conductor: <https://www.conductor.build/docs> e
  <https://www.conductor.build/changelog>.
- Vibe Kanban: <https://www.vibekanban.com/blog/shutdown>,
  <https://github.com/BloopAI/vibe-kanban>.
