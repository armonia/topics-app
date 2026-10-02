# Design: commands-ui

Le scelte che cambiano cosa vedi stanno nel blocco «Da decidere» di
`proposal.md`; qui quelle tecniche, e il perché delle alternative scartate.
Codice letto su origin/main c3cf4765e. «Misurato» vuol dire un processo vero
(CLI 2.1.288 con i flag di Topics, o il server di test isolato); il resto è letto
nel codice.

## 1. La mappa: ogni nome, cosa diventa, per motore

Una tabella sola nel client, `Chat/commandMap.ts`, decide per ogni nome che può
comparire nel menu o essere scritto. Il tipo dice cosa fa Topics:

- `topics`: lo esegue Topics (`handleSlashCommand`), su ogni motore che lo regge;
- `control`: apre un controllo di Topics, o lo imposta se c'è un argomento valido;
- `engine`: parte nudo verso il motore, che lo esegue (CLI_BUILTINS sul server);
- `refused`: il motore lo rifiuta quando lo pilota Topics; risposta locale;
- `hidden`: non compare nel menu; scritto a mano parte come oggi.

`turn: true` segna i comandi che fanno lavorare il modello (le skill, i comandi
«prompt» della CLI). Un nome del motore che la mappa non conosce si tratta come
`engine` con `turn: true`: i comandi locali della CLI sono un elenco chiuso
(`scratchpad/cmdaudit/registry.md` §1a), tutto il resto è un prompt.

| Nome | Tipo | Claude Code | Motore Topics | Codex | jcode / Gemini | OpenClaw |
|---|---|---|---|---|---|---|
| /resume | topics | elenco (§3) | elenco | elenco | elenco | elenco |
| /model | control | selettore | selettore | selettore | selettore | selettore |
| /effort | control | cursore | cursore | cursore | cursore | non offerto (/reasoning) |
| /context | control | ispettore dell'anello | ispettore | ispettore | ispettore | ispettore |
| /permissions | control | selettore dell'autonomia | idem | idem | idem | idem |
| /fast | control | interruttore Fast | idem dove c'è | — | — | — |
| /usage, /cost | control | livello Provider AI (§5) | idem | idem | idem | idem |
| /mcp | control | livello Strumenti | idem | idem | idem | idem |
| /config | control | menu utente | idem | idem | idem | idem |
| /export | topics | esporta la chat (.md) | idem | idem | idem | idem |
| /compact | topics → engine | la CLI (`sendMessage('/compact')`, ChatPane.tsx:989-1002) | compattazione nativa ora (§6) | non offerto | non offerto | il gateway |
| /clear, /new, /reset | topics | `resetSession` | `resetSession` | `resetSession` | `resetSession` (nuovo) | in banda |
| /status, /help, /goal, /fork, /project, /browser, /rewind | topics | come oggi, risposta nella scheda (§4) | idem | idem | `/fork` rifiutato come oggi (`canFork`) | idem |
| /rename | topics | rinomina la chat di Topics | idem | idem | idem | idem |
| /reasoning | topics | non offerto | non offerto | non offerto | non offerto | `/reasoning [on\|off\|stream]` |
| /init, /review, /security-review, /simplify… | engine, turn | gruppo Claude Code | — | — | — | — |
| /output-style, /skill-doctor, /reload-skills, /autocompact | engine | gruppo Claude Code, risposta nella scheda | — | — | — | — |
| /memory, /init (Gemini); /models (jcode) | engine | — | — | — | gruppo del motore, dall'annuncio | — |
| skill e comandi tuoi | engine, turn | gruppo «Le tue skill» | — | — | — | — |
| /agents, /doctor, /color, /focus, /heapdump, /advisor, /import, /design* | hidden | scritti partono | — | — | — | — |
| /vim, /login, /logout, /hooks, /ide, /sandbox, /statusline, /terminal-setup, /release-notes, /bug, /privacy-settings, /upgrade, /add-dir, /exit, /quit | refused | risposta locale | idem | idem | idem | idem |

Perché /advisor è nascosto: cambia il modello con cui la CLI si consulta, dentro la
sessione, all'insaputa del selettore di Topics; due posti che decidono il modello
divergono. /doctor è il prompt «Claude Code Doctor» che riscrive CLAUDE.md e i file
di memoria (misurato: corpo da 44 kB): chi lo scrive lo vuole, il menu non lo
propone.

## 2. Da dove viene il menu (scelta 2)

**Claude Code.** Il messaggio `system/init` porta `slash_commands`, i nomi che
funzionano in quel modo (misurato: 119, `scratchpad/cmdaudit/cli/init-slash-commands.json`;
le 10 skill spente in `skillOverrides` non ci sono). `system/commands_changed`
porta `commands: [{name, description, argumentHint}]` (misurato,
`scratchpad/cmdaudit/probe-review.jsonl`). Oggi tutti e due finiscono in `noise`
(`server/providers/claude/events.ts:67-69`).

- `events.ts` impara due tipi di riga, `commands` (init e commands_changed) e
  `command_outcome` (`system/status` con `compact_result`, già nella lista delle
  correzioni senza scelta).
- `claude-code.ts` tiene l'ultimo elenco per sessione e lo ricorda anche per
  progetto e per motore (in memoria, niente DB): prima che una chat nuova abbia
  avviato la sua CLI, il menu usa l'ultimo elenco visto per quel progetto, poi
  quello per il motore. Mai avviare una CLI solo per sapere i comandi: è un
  processo da centinaia di MB su una macchina che soffre di RAM.
- Con nessun elenco ancora visto (primo avvio del server): il gruppo Topics e le
  skill dalle cartelle, come oggi (`server/lib/slash-command-source.ts`).

**jcode e Gemini.** `available_commands_update` arriva come `session/update`
(misurato: jcode 3 comandi, Gemini 6) e oggi `acp/translate.ts:167` lo butta via.
Lo stesso deposito per sessione.

**Codex, API, motore di Topics.** Nessun gruppo del motore: `codex exec` non ha
comandi (misurato, `codex exec "/compact"` è un turno del modello), il motore di
Topics non ha un parser.

**La rotta.** `GET /api/slash-commands?topicId=` risponde con i tre gruppi già
filtrati dalla mappa lato server per motore (il client applica la mappa per i
controlli). Il motore è quello DICHIARATO dal topic (CMD-08), non quello risolto.

**Scartata, l'alternativa della scelta 2** (lista a mano per motore): è la causa
di oggi. 6 nomi di `CLI_BUILTINS` non esistono più nella CLI, 22 la CLI li
rifiuta, 84 funzionano e non sono offerti; ogni versione della CLI ne sposta
qualcuno (/agents tolto, /review diventato alias di /code-review).

**Il test che tiene.** `slashCommandRouting.test.ts` smette di controllare due
liste di testo: controlla la mappa contro l'elenco registrato della CLI (una
fixture presa da `init`), e fallisce se un nome `engine` non è nell'elenco o se un
nome `refused` lo è.

## 3. /resume (scelta 1)

**Fonte.** I transcript in `~/.claude/projects/<cartella codificata>/<id>.jsonl`.
Il censimento esiste già: `scanExternalClaudeSessions`
(`server/lib/external-claude-sessions.ts:219`) legge gli ultimi 64 KB di ogni file,
scarta quelli che Topics possiede (`knownSessionIds`, la radice dei worktree) e
attribuisce il resto a un progetto per prefisso del `cwd`. Cambia poco:

- la finestra di 8 ore (`DEFAULT_WINDOW_MS`) diventa un parametro; l'elenco di
  /resume guarda 30 giorni e tiene le 50 più recenti;
- `parseTranscriptFacts` legge anche il titolo: `customTitle` (record
  `custom-title`, da /rename), poi `aiTitle` (`ai-title`), poi `lastPrompt`
  (`last-prompt`) tagliato. Misurato sulla cartella di topics-app: 24 transcript,
  mediana 4,94 MB, il più grande 88 MB; i record del titolo stanno TUTTI negli
  ultimi 64 KB (custom-title 11 su 11, ai-title 3 su 3, last-prompt 24 su 24).
  Niente lettura del file intero; per questo la riga non dice quanti messaggi;
- `knownSessionIds` comprende le righe di `claude_code_sessions`: una sessione già
  adottata è una chat di Topics, e sta nella colonna.

**Rotta.** `GET /api/topics/:id/resumable-sessions` → `[{sessionId, title,
titleSource, branch, cwd, lastActivityAt, active}]` per il progetto del topic.
`active` = toccata negli ultimi 15 minuti (`DEFAULT_ACTIVE_MS`). Senza progetto,
404 con un codice, e la scheda lo dice. La lettura costa quanto il censimento che
gira già (cache per path e mtime, `external-claude-sessions.ts:202-212`).

**Superficie.** Il guscio di `SuggestionMenu` sopra il composer, al posto del menu
«/», non un `Menu`: chi filtra sta scrivendo nel campo, e sotto 768 px `Menu`
diventa un foglio con lo sfondo che copre il campo (`SuggestionMenu.tsx:65-70`
lo spiega). La parola dopo `/resume ` filtra su titolo e ramo. Frecce, Invio, Esc
come il menu «/». Riga: icona terminale, titolo, quando; sotto il ramo e
«attiva adesso».

**Invio.** `POST /api/topics/adopt-claude` (`server/routes/topics.ts:1479-1579`,
provato da ADOPT-01): crea la chat Claude Code nel cwd della sessione, la lega al
`claude_session_id` (il turno dopo è `--resume`), importa la storia, e la apre con
`topics:open-topic` in modo permanente. È idempotente: una seconda adozione porta
alla chat già creata. Una sessione `active` chiede prima conferma («È ancora attiva
in un terminale: continuarla qui?»), perché due processi che scrivono la stessa
sessione la biforcano; l'importazione incrementale dell'adozione segue comunque i
turni del terminale.

**Su ogni motore.** L'elenco è del progetto, non della chat: da una chat Codex
dello stesso progetto /resume apre una chat Claude Code nuova. La riga del menu
lo dice («Riprendi una sessione Claude di questo progetto»).

**Scartata, l'alternativa** (togliere /resume): lascia l'adozione senza porta, ed
è il gesto che Claude Desktop ha aggiunto ad aprile proprio con /resume.

## 4. La scheda della risposta (scelta 3)

Oggi `commandResult` (`ChatPane.tsx:294`) disegna una fascia verde o rossa in
monospazio sopra i messaggi (`:1680-1686`) e un timer la chiude dopo 5 s
(`:1365`).

- Un componente, `Chat/CommandAnswerCard.tsx`, in coda alla lista dei messaggi
  della pane, dopo il messaggio del comando. Stato della pane, non del thread:
  non si salva, non entra in `build-provider-history`, al ricarico non c'è.
- Contenuto tipato, non testo: `{kind: 'facts' | 'text' | 'error' | 'running',
  title, rows?, body?, action?}`. /status diventa `facts` (le righe di CMD-07,
  senza emoji); /help non usa la scheda (apre il menu); /compact usa `running` e
  poi `facts` o `error`.
- Si chiude con la X (bersaglio da 44 px sul telefono), con il messaggio dopo, o
  con un altro comando che la sostituisce. Nessun timer.
- **Le risposte locali della CLI** arrivano oggi come messaggio dell'assistente con
  `model: "<synthetic>"` e `result.num_turns: 0` (misurato, ogni comando locale) e
  si salvano come risposte dell'agente. Il provider le riconosce in `events.ts`
  (assistant `<synthetic>` dentro un turno che finisce con `num_turns: 0`) e le
  manda come `stream:command-answer`; la chat le disegna nella scheda, in inglese
  com'è il testo della CLI, sotto il titolo in italiano del comando.
- `role="status"` per `running`, `role="region"` con nome per le altre.

**Scartata, l'alternativa** (salvarla come messaggio di sistema con
`/api/topics/:id/system-message`, già usata dalla testata morta di `ChatPanel`): una
fotografia dello stato salvata invecchia e si legge come vera alla riapertura, e
ogni riga in più nel thread è una riga che la storia del provider deve saper
saltare.

## 5. Il misuratore del piano (scelta 4)

Le cifre ci sono: `rate_limit_event` → `readRateLimitUsage`
(`server/providers/claude/events.ts:91-101`) → `provider:usage` → `state/planUsage.ts`
nel client (finestra di 5 ore e di 7 giorni, percentuale e azzeramento). Oggi si
vedono solo come avviso sopra `PLAN_USAGE_WARN_AT` (50%, `shared/provider-hold.ts:35`)
in `SidebarStatusBar.tsx:87-88`.

- Il livello Provider AI del menu utente (change `sidebar-menu-settings`,
  `openUserMenu('providers')`) guadagna in cima un blocco: titolo «Piano Claude ·
  <piano>» (l'etichetta `subscription` che quella change porta nello snapshot dei
  provider), due barre, accanto a ognuna la percentuale e quando si azzera. La
  barra passa all'ambra oltre `PLAN_USAGE_WARN_AT`, al rosso con un blocco attivo
  (`providerHold`).
- La coda della riga Provider AI aggiunge la percentuale delle 5 ore.
- Senza lettura: «nessuna lettura ancora: arriva col primo turno di Claude Code».
- /usage e /cost chiamano `openUserMenu('providers')`; sul telefono risponde il
  menu del titolo, come ogni `openUserMenu`.

## 6. I controlli che si aprono da un comando

Ogni controllo del composer ascolta un evento di finestra con il `composerId`
della pane (lo stesso schema di `chat:attach-image`, `ChatInput.tsx:822-823`):
`composer:open-control` con `detail.control` in `model | effort | autonomy |
context`. Il composer apre il suo popover come al clic e porta il fuoco dentro.
Con un argomento valido il comando imposta senza aprire (`/model opus` →
`commandApi.setModel` come oggi; `/fast off` → `toggleFastMode` solo se serve).
/mcp e /config chiamano `openUserMenu('tools')` e `openUserMenu()`.

**/compact sul motore di Topics.** La compattazione esiste
(`server/providers/native/context-window.ts:80-96`, `compactIfNeeded`) ma parte
solo vicino al tetto. Il provider espone `compactNow(sessionKey)`, che chiama
`compact()` sulla storia della sessione senza la soglia e manda `onCompaction`
con `trigger: "manual"`: lo stesso separatore che disegna già la chat.

## 7. Il cassetto della board (scelta 5)

Il composer del cassetto (`Board/TaskDetail.tsx:3100-3160`) e il commento della
card (`Board/Card.tsx:627-689`) mandano il testo a
`POST /api/boards/:p/tasks/:t/comments`; con un agente diventa «Human update on
task …» (`server/services/task-dispatcher.ts:4277-4290`, `buildResume`), senza è una nota
(misurato: `delivery: "note"`).

- Con la scelta consigliata: se il testo inizia con un nome della mappa (non una
  skill), sopra il campo compare la riga «I comandi vanno dati nella chat
  dell'agente» con «Apri la sessione», lo stesso gesto di «Apri la sessione» del
  menu della card (`Card.tsx:1930-1937`, `board.task.openSession`); senza sessione viva la riga dice solo
  che lì un comando è testo. Invio manda come oggi.
- L'alternativa costa: il menu «/» nel cassetto, una rotta che esegue
  /compact, /model, /effort, /clear e /status sulla sessione dell'agente della
  card invece che su quella del topic, e la stessa scheda della risposta nel
  cassetto.

## 8. Telefono e tastiera

- Menu «/» e elenco di /resume: attaccati al composer, larghi quanto la colonna,
  righe da 44 px, le etichette di destra («apre il selettore», «turno») spariscono
  e resta il colore del nome; la riga del gruppo resta.
- Tastiera: ↑↓ attraversano i gruppi senza fermarsi alle intestazioni
  (`useMenuKeyboard` salta ciò che non si naviga), Tab e Invio scelgono, Esc
  chiude. `role="listbox"` con `role="group"` e `aria-label` per gruppo.
- Una scelta dal menu di un comando `control` o `topics` senza argomenti lo
  ESEGUE (oggi inserisce `"/x "` e aspetta un secondo Invio,
  `ChatInput.tsx:996`); uno che vuole un argomento (`/goal`, `/browser`, `/fork`)
  lo inserisce con lo spazio come oggi.

## 9. Rischi e ordine

- **`slash_commands` e `commands_changed` non sono un'API pubblicata.** Sono campi
  di una CLI di terzi (la stessa classe di `compact_boundary`). Se spariscono il
  menu ricade sulla fixture registrata e sulle cartelle, non si svuota; il test
  della fixture lo dice al primo aggiornamento.
- **Due change prima di questa.** `sidebar-menu-settings` (il livello Provider AI,
  `openUserMenu`, oggi sul ramo `feat/menu-utente-tutto-1002`) e `model-selector`
  (⇧⌘M e il selettore, proposta non approvata). Senza la seconda /model apre il
  selettore di oggi, `ProviderModelPicker`, con lo stesso evento.
- **Le correzioni senza scelta** (28, elenco dell'audit del 03/10) atterrano
  prima; tre toccano gli stessi file (`ChatPane.tsx`, `slashCommands.ts`,
  `adapt.ts`): questa change parte dal loro stato.
- **Il CLI finto delle e2e** (`tests/e2e/helpers/fake-claude-*.ts`) emette un
  `init` scritto a mano senza `slash_commands`. Per le prove serve un finto che
  ripeta righe registrate dalla CLI vera (`init`, `commands_changed`, i
  `<synthetic>`, `compact_result`), detto nel suo header. Non può mostrare una
  compattazione vera, un'espansione vera di una skill né cosa risponde il modello.
