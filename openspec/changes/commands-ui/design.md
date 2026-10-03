# Design: commands-ui

Le scelte che cambiano cosa vedi stanno nel blocco «Da decidere» di
`proposal.md`; qui quelle tecniche, e il perché delle alternative scartate.
Codice letto su origin/main c3cf4765e; il ramo `feat/impostazioni-dove-si-usano-1003`
per `openHome` e i pannelli. «Misurato» vuol dire un processo vero (CLI 2.1.288 con
i flag di Topics, il server di test isolato, o i file di `~/.claude/projects` letti
il 03/10); il resto è letto nel codice.

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

**Gli alias.** `init.slash_commands` porta i nomi, non gli alias (misurato: `review`,
`cost`, `stats`, `new`, `reset`, `settings`, `checkup` non ci sono). La mappa tiene il
nome canonico e i suoi alias, dal registro del bundle: `usage` ← `cost`, `stats`;
`code-review` ← `review`; `clear` ← `new`, `reset`; `config` ← `settings`; `doctor` ←
`checkup`; `exit` ← `quit`. Il menu mostra il nome canonico; un alias scritto si
risolve sul suo nome prima di ogni altra regola, quindi /cost apre quello che apre
/usage e /review parte come /code-review.

| Nome | Tipo | Claude Code | Motore Topics | Codex | jcode / Gemini | OpenClaw |
|---|---|---|---|---|---|---|
| /resume | topics | elenco (§3) | elenco | elenco | elenco | elenco |
| /model | control | selettore | selettore | selettore | selettore | selettore |
| /effort | control | cursore | cursore | cursore | cursore | non offerto (/reasoning) |
| /context | control | ispettore dell'anello | ispettore | ispettore | ispettore | ispettore |
| /permissions | control | selettore dell'autonomia | idem | idem | idem | idem |
| /fast | control | interruttore Fast | idem dove c'è | — | — | — |
| /usage (/cost, /stats) | control | pannello Provider e chiavi (§5) | idem | idem | idem | idem |
| /mcp | control | pannello Strumenti del «+» | idem | idem | idem | idem |
| /config (/settings) | control | menu utente | idem | idem | idem | idem |
| /export | topics | esporta la chat (.md) | idem | idem | idem | idem |
| /compact | topics → engine | la CLI (`sendMessage('/compact')`, ChatPane.tsx:989-1002) | compattazione nativa ora (§6) | non offerto | non offerto | il gateway |
| /clear (/new, /reset) | topics | `resetSession` | `resetSession` | `resetSession` | `resetSession` (nuovo) | in banda |
| /status, /help, /goal, /fork, /project, /browser, /rewind | topics | come oggi, risposta nella scheda (§4) | idem | idem | `/fork` rifiutato come oggi (`canFork`) | idem |
| /rename | topics | rinomina la chat di Topics | idem | idem | idem | idem |
| /reasoning | topics | non offerto | non offerto | non offerto | non offerto | `/reasoning [on\|off\|stream]`, visibilità del ragionamento |
| /init, /code-review (/review), /security-review, /simplify… | engine, turn | gruppo Claude Code | — | — | — | — |
| /output-style, /skill-doctor, /reload-skills, /autocompact | engine | gruppo Claude Code, risposta nella scheda | — | — | — | — |
| /memory, /init (Gemini); /models (jcode) | engine | — | — | — | gruppo del motore, dall'annuncio | — |
| skill tue | engine, turn | gruppo «Le tue skill» | gruppo «Le tue skill» (tool `skill`) | — | — | — |
| comandi tuoi (`commands/*.md`) | engine, turn | gruppo «Le tue skill» | — (il tool `skill` carica solo skill, `tools.ts:786-791`) | — | — | — |
| /agents, /doctor (/checkup), /color, /focus, /heapdump, /advisor, /import, /design* | hidden | scritti partono | — | — | — | — |
| /vim, /login, /logout, /hooks, /ide, /sandbox, /statusline, /terminal-setup, /release-notes, /bug, /privacy-settings, /upgrade, /add-dir, /exit (/quit) | refused | risposta locale | idem | idem | idem | idem |

Perché /advisor è nascosto: cambia il modello con cui la CLI si consulta, dentro la
sessione, all'insaputa del selettore di Topics; due posti che decidono il modello
divergono. /doctor è il prompt «Claude Code Doctor» che riscrive CLAUDE.md e i file
di memoria (misurato: corpo da 44 kB): chi lo scrive lo vuole, il menu non lo
propone.

**/reasoning su OpenClaw.** Oggi il ramo confronta il comando intero
(`cmd === '/reasoning'`), quindi `/reasoning off` scritto non ci arriva e va al motore.
Il ramo legge il primo token e passa l'argomento; su OpenClaw l'argomento decide se il
ragionamento si vede (documentazione di OpenClaw, slash-commands.md:247), non se c'è.

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

**Motore di Topics.** Nessun gruppo del motore (non ha comandi), ma il gruppo «Le tue
skill» sì: le stesse che il suo prompt elenca (`listSkills`,
`server/lib/native-parity.ts:86`), che il tool `skill` carica quando il modello lo
chiama (`server/providers/native/tools.ts:311-314`, «If the user types /<name>, that
is an explicit request to invoke it»). È una richiesta al modello, non un'espansione
prima del turno: la riga è segnata «turno». Solo le skill: il tool rifiuta i
`commands/*.md` (`tools.ts:786-791`, `src.kind !== "skill"`). `listSkills` oggi non
legge `skillOverrides` (nessun riferimento nel server): le spente escono dal suo
elenco, quindi dal prompt e dal menu insieme, una sola regola per i due.

**jcode e Gemini.** `available_commands_update` arriva come `session/update`
(misurato: jcode 3 comandi, Gemini 6) e oggi `acp/translate.ts:167` lo butta via.
Lo stesso deposito per sessione.

**Codex, API.** Nessun gruppo del motore né delle skill: `codex exec` non ha
comandi (misurato, `codex exec "/compact"` è un turno del modello), le API non hanno
un tool che carichi una skill.

**La rotta.** `GET /api/slash-commands?topicId=` risponde con i tre gruppi già
filtrati dalla mappa lato server per motore (il client applica la mappa per i
controlli). Il motore è quello DICHIARATO dal topic (CMD-08), non quello risolto.

**Scartata, l'alternativa della scelta 2** (lista a mano per motore): è la causa
di oggi. 6 nomi di `CLI_BUILTINS` non esistono più nella CLI, 22 la CLI li
rifiuta, 77 dei 119 dell'elenco non sono nel menu (misurato il 03/10: il menu ha 14
voci di Topics e 45 tue, di cui 7 e 35 nell'elenco); ogni versione della CLI ne
sposta qualcuno (/agents tolto, /review diventato alias di /code-review).

**Il test che tiene.** `slashCommandRouting.test.ts` smette di controllare due
liste di testo: controlla la mappa contro l'elenco registrato della CLI (una
fixture presa da `init`, con accanto gli alias del registro, §1), e fallisce se un
nome `engine` non è nell'elenco né alias di un nome che c'è, o se un nome `refused`
c'è. Senza gli alias il test sarebbe rosso su /cost e /review, che oggi funzionano
(misurato: /cost risponde a $0, /review avvia il code-review a $0,091), e chi lo
rendesse verde li cancellerebbe.

## 3. /resume (scelta 1)

**Fonte.** I transcript in `~/.claude/projects/<cartella codificata>/<id>.jsonl`. Il
censimento delle sessioni esterne (`scanExternalClaudeSessions`,
`server/lib/external-claude-sessions.ts:219`) li legge già, ma NON si riusa per
/resume, perché le due letture si disferebbero a vicenda:

- la sua cache (`factsCache`, `:212`) a fine giro butta ogni path che quel giro
  non ha visto (`:269`). Un censimento a 8 ore e un /resume a 30 giorni si
  svuoterebbero la cache l'uno con l'altro, e ogni /resume rileggerebbe tutto;
- legge tutte le cartelle e tutte le code con `readSync` sul loop del server
  (`:192`). Misurato il 03/10 su questo Mac: 225 cartelle, 2.433 transcript; in 8
  ore 118, in 30 giorni 2.423, cioè 148,9 MB di code da 64 KB. Leggere e
  analizzare quelle 2.423 code: 1,2 s a freddo, 0,33 s a cache del disco calda,
  bloccanti.

`lib/resumable-claude-sessions.ts`, una lettura a parte, limitata in tre modi:

1. **Solo le cartelle del progetto.** La CLI chiama la cartella col `cwd`
   codificato (ogni carattere che non è lettera o cifra diventa `-`): si leggono
   solo le cartelle il cui nome inizia col percorso del progetto codificato. È un
   prefiltro; chi decide resta il `cwd` letto nella coda (`isInsideDir`), così
   `topics-app2` non passa per `topics-app`. Misurato su topics-app: 4 cartelle su
   225, 29 transcript invece di 2.433, 27 code in 30 giorni (1,7 MB), lette in 4 ms.
   Una sessione partita da una cartella sopra il progetto e spostata dentro dopo
   non c'è: si accetta, l'elenco è delle sessioni del progetto.
2. **Una pagina alla volta, non una finestra di giorni.** `stat` di ogni file
   delle cartelle scelte (13 ms per l'intero archivio), ordine per `mtime`, via i
   `sessionId` che Topics possiede già (dal nome del file, prima di leggere
   niente), poi le code si leggono in ordine solo finché la pagina ha 20 righe.
   «Carica più vecchie» chiede la pagina dopo, col `mtime` dell'ultima riga come
   cursore. Una finestra di giorni non limita niente su un progetto attivo (su
   `~/.openclaw` 1.725 transcript in 30 giorni, 242 ms a cache calda); 20 code sì.
3. **Fuori dal loop.** Le code si leggono con l'I/O asincrono
   (`Bun.file(path).slice(size - 64 KB).text()`), non `readSync`; l'analisi di 20
   code da 64 KB è nell'ordine dei millisecondi.

La cache è sua: per path, valida finché `mtime` e dimensione non cambiano, al
massimo 500 voci con uscita della meno usata. Non tocca `factsCache` e il
censimento non tocca lei. `DEFAULT_WINDOW_MS` resta 8 ore e resta del censimento;
la finestra era già un parametro (`opts.windowMs`, `:223`), quindi non c'è niente
da rendere parametro.

**Il titolo.** `parseTranscriptFacts` impara il titolo: `customTitle` (record
`custom-title`, da /rename), poi `aiTitle` (`ai-title`), poi `lastPrompt`
(`last-prompt`) tagliato. Misurato sulla cartella di topics-app: 24 transcript,
mediana 4,94 MB, il più grande 88 MB; i record del titolo stanno TUTTI negli
ultimi 64 KB (custom-title 11 su 11, ai-title 3 su 3, last-prompt 24 su 24). Niente
lettura del file intero; per questo la riga non dice quanti messaggi.

`knownSessionIds` comprende le righe di `claude_code_sessions`: una sessione già
adottata è una chat di Topics, e sta nella colonna.

**Rotta.** `GET /api/topics/:id/resumable-sessions?before=<mtime>` →
`{sessions: [{sessionId, title, titleSource, branch, cwd, lastActivityAt, active,
transcriptPath}], more}` per il progetto del topic. `active` = toccata negli ultimi
15 minuti (`DEFAULT_ACTIVE_MS`). Senza progetto, 404 con un codice, e la scheda lo
dice.

**Superficie.** Il guscio di `SuggestionMenu` sopra il composer, al posto del menu
«/», non un `Menu`: chi filtra sta scrivendo nel campo, e sotto 768 px `Menu`
diventa un foglio con lo sfondo che copre il campo (`SuggestionMenu.tsx:65-70`
lo spiega). La parola dopo `/resume ` filtra su titolo e ramo delle righe caricate;
l'ultima riga è «Carica più vecchie» finché `more` è vero. Frecce, Invio, Esc come
il menu «/». Riga: icona terminale, titolo, quando; sotto il ramo e «attiva adesso».

**Invio.** `POST /api/topics/adopt-claude` (`server/routes/topics.ts:1479-1579`,
provato da ADOPT-01), con il `transcriptPath` della riga, così l'adozione non
scorre le 225 cartelle: crea la chat Claude Code nel cwd della sessione, la lega al
`claude_session_id` (il turno dopo è `--resume`), importa la storia, e la apre con
`topics:open-topic` in modo permanente. È idempotente. L'adozione legge il file
intero con `readFileSync` (`:1513`): misurato sul più grande di topics-app (88 MB,
7.854 messaggi) 45-88 ms di lettura e 172-182 ms di analisi, poi l'inserimento delle
righe in una transazione (`:1535`, non misurato). È un gesto della persona, una
volta per sessione: la riga mostra «in corso» finché la rotta risponde, e l'adozione
non si riscrive qui. Una sessione `active` chiede prima conferma («È ancora attiva
in un terminale: continuarla qui?»), perché due processi che scrivono la stessa
sessione la biforcano; l'importazione incrementale dell'adozione segue comunque i
turni del terminale.

**Su ogni motore.** L'elenco è del progetto, non della chat: da una chat Codex
dello stesso progetto /resume apre una chat Claude Code nuova. La riga del menu
lo dice («Riprendi una sessione Claude di questo progetto»).

**Scartate.** Togliere /resume (l'alternativa della scelta 1): lascia l'adozione
senza porta, ed è il gesto che Claude Desktop ha aggiunto ad aprile proprio con
/resume. Condividere la cache del censimento: si svuotano a vicenda (sopra). Una
finestra di 30 giorni su tutte le cartelle: 2.423 code sul loop a ogni apertura.

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
  si salvano come risposte dell'agente: anche «Not enough messages to compact.»,
  che oggi si vede come bolla dell'agente mentre la fascia «in corso» non diventa
  mai un errore e `compactWatchRef` resta aperto (`ChatPane.tsx:485-507`). Il
  provider le riconosce in `events.ts` SOLO in un turno partito da un comando (il
  messaggio è un'invocazione, SKILL-03, di un nome dell'elenco del motore) che
  finisce con `num_turns: 0`, e le manda come `stream:command-answer`; la chat le
  disegna nella scheda, in inglese com'è il testo della CLI, sotto il titolo in
  italiano del comando. Un `<synthetic>` in un turno normale (un errore della CLI)
  resta un messaggio come oggi: quali altri `<synthetic>` la CLI manda con
  `num_turns: 0` non è verificato, e il test 1.3 fissa quelli registrati.
- `role="status"` per `running`, `role="region"` con nome per le altre.
- Le e2e cercano il testo DENTRO la scheda (il contenitore del bottone
  `chat.command.dismiss`), non nella pagina: «Not enough messages to compact.»
  sta già nella pagina oggi, come bolla.

**Scartata, l'alternativa** (salvarla come messaggio di sistema con
`/api/topics/:id/system-message`, già usata dalla testata morta di `ChatPanel`): una
fotografia dello stato salvata invecchia e si legge come vera alla riapertura, e
ogni riga in più nel thread è una riga che la storia del provider deve saper
saltare.

## 5. /usage e il piano (scelta 4)

Con la modifica del 03/10 di `sidebar-menu-settings` (SETHOME-01, USERMENU-10) i
provider non sono più un livello del menu utente: Provider e chiavi è un pannello
aperto dall'ultima riga di ogni selettore del modello, disegnato da
`Settings/HomePanelHost`, e in cima ha l'abbonamento Claude con la finestra di 5
ore; il selettore ha la riga compatta «Max 20x · 5 h al 42%» accanto ai modelli
Claude, in ambra oltre `PLAN_USAGE_WARN_AT` (50%, `shared/provider-hold.ts:35`).
Questo è deciso lì e qui si usa.

- **/usage e /cost** chiamano `openHome('providers', anchor)`
  (`client/src/lib/openHome.ts` su quel ramo), con per ancora il bottone del
  selettore del modello di questo composer: il pannello si apre accanto al
  selettore come dal suo piede. Sul telefono è il foglio dal basso, come ogni
  pannello di `HomePanelHost`.
- **La scelta 4** aggiunge solo la settimana: sotto la finestra di 5 ore una
  seconda barra con percentuale e azzeramento (giorno e ora: un azzeramento
  settimanale non si dice con l'ora sola, come già fa `ProviderLimitNotice`), e
  in coda alla riga compatta «· sett. 78%». Le cifre ci sono:
  `rate_limit_event` → `readRateLimitUsage` (`server/providers/claude/events.ts:91-101`)
  → `provider:usage` → `state/planUsage.ts`, che tiene già `sevenDay`. Stesso
  colore delle 5 ore: ambra oltre la soglia, rosso con un blocco attivo
  (`providerHold`).
- Senza lettura: «nessuna lettura ancora: arriva col primo turno di Claude Code».
- USERMENU-10 è in una change non ancora archiviata: CMDUI-05 la estende senza
  riscriverla. Se `sidebar-menu-settings` si archivia prima di questa, CMDUI-05
  diventa un MODIFIED di USERMENU-10 nella delta di `settings`.

## 6. I controlli che si aprono da un comando

Ogni controllo del composer ascolta un evento di finestra con il `composerId`
della pane (lo stesso schema di `chat:attach-image`, `ChatInput.tsx:822-823`):
`composer:open-control` con `detail.control` in `model | effort | autonomy |
context`. Il composer apre il suo popover come al clic e porta il fuoco dentro.
Con un argomento valido il comando imposta senza aprire (`/model opus` →
`commandApi.setModel` come oggi; `/fast off` → `toggleFastMode` solo se serve).

- /usage e /cost: `openHome('providers', <selettore di questo composer>)` (§5).
- /mcp: `openHome('tools', <«+» di questo composer>)`, il pannello Strumenti
  ancorato al «+» come dalla sua riga; aprirlo non monta la flotta (SETHOME-01).
- /config: `openUserMenu()`, il menu utente (Aspetto, Notifiche, Vista); sul
  telefono risponde il menu del titolo, come ogni `openUserMenu`.

**/compact sul motore di Topics.** La compattazione esiste
(`server/providers/native/context-window.ts:80-96`, `compactIfNeeded`) ma parte
solo vicino al tetto, e chiede un `StreamHandler` per `onCompaction` (`:85`), che
fuori da un turno non c'è. Il provider espone `compactNow(sessionKey)`: chiama
`compact()` sulla storia della sessione senza la soglia e RESTITUISCE
`{before, after}`, senza handler. La rotta `/api/command` `compact` scrive il
marcatore e manda `stream:compaction` con `trigger: "manual"` come fa il turno
(`insertCompactionMarkerIfNew` e `broadcastToTopicSubscribers`,
`server/routes/chat.ts:3174-3190`): lo stesso separatore che la chat disegna già.
Con un turno in volo risponde 409 e la scheda dice di riprovare a turno finito.

## 7. Il cassetto della board

Deciso, non più una scelta: la riga che rimanda alla chat dell'agente. Il menu «/»
dentro il cassetto, con una rotta che esegua /compact, /model, /effort, /clear e
/status sulla sessione della card, è un pezzo del cassetto nuovo e si decide nella
change `conversazione-unica-della-card`, che lo rifà.

Il composer del cassetto (`Board/TaskDetail.tsx:3100-3160`) e il commento della
card (`Board/Card.tsx:627-689`) mandano il testo a
`POST /api/boards/:p/tasks/:t/comments`; con un agente diventa «Human update on
task …» (`server/services/task-dispatcher.ts:4277-4290`, `buildResume`), senza è una nota
(misurato: `delivery: "note"`).

- Se il testo inizia con un nome della mappa (non una skill), sopra il campo
  compare la riga «I comandi vanno dati nella chat dell'agente» con «Apri la
  sessione», lo stesso gesto di «Apri la sessione» del menu della card
  (`Card.tsx:1930-1937`, `board.task.openSession`); senza sessione viva la riga dice
  solo che lì un comando è testo. Invio manda come oggi.

## 8. Telefono, tastiera, citazione, segno

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
- **La citazione.** Con una risposta armata, un comando che `handleSlashCommand`
  non intercetta passa dal ramo che compone (`ChatPane.tsx:1444` e sotto) e prende
  la citazione davanti: misurato, /new è arrivato alla CLI come
  `> primo messaggio\n\n/new`, cioè prosa. Un messaggio che è un'invocazione
  (SKILL-03) salta la citazione, che resta armata per il messaggio dopo.
- **Il segno del comando.** SKILL-03 riconosce la forma; il segno (SKILL-04) si
  disegna solo se il nome è fra quelli che il menu conosce per quella chat (la
  mappa, l'ultimo elenco del motore, le cartelle delle skill). Un messaggio vecchio
  la cui skill è stata cancellata perde il segno, non il testo: si accetta, il
  segno dice cosa è partito e quel nome oggi non partirebbe.

## 9. Le skill al primo turno e in plan mode

Oggi il blocco del contesto va DAVANTI al messaggio
(`server/context/adapt.ts:256`, `` `<context>…</context>\n\n${userContent}` ``)
quando ci sono slot da emettere: sempre al primo turno, e in plan mode a ogni turno,
perché `plan-mode` e `global-board` non si deduplicano mai (`VOLATILE_SLOTS`, `:77`).
La CLI riconosce un comando solo all'inizio del messaggio, quindi `/vai x` al primo
turno arriva al modello come prosa (misurato sulla CLI vera,
`scratchpad/cmdprop-probe/SUMMARY.txt`, caso 3).

Il contesto DOPO il comando (caso 2) espande la skill, ma il blocco diventa i suoi
argomenti (`<command-args>`), e la CLI sostituisce `$ARGUMENTS` dentro il corpo:
nelle tue skill sta a metà frase (`~/.agents/skills/vai/SKILL.md:7`, «sul lavoro
pendente o implicito $ARGUMENTS. Regole:»; `~/.agents/skills/spec/SKILL.md:31`,
`/gsd:do $ARGUMENTS`). Scartato.

Quando il messaggio è un'invocazione (SKILL-03) di un nome che non è un built-in
della CLI, il messaggio parte NUDO e il contesto va fuori:

- **primo turno**: la CLI parte proprio con quel turno, e il prompt di sistema si
  scrive alla partenza (`--append-system-prompt`, `server/providers/claude/args.ts:385`,
  da `claude-code.ts:2642`). Gli slot di quel turno si aggiungono lì, e
  `inlineSlots` li registra come già mandati, così il turno dopo non li ripete;
- **processo già vivo** (plan mode, board globale): il prompt di sistema non si
  riscrive senza riavviare la CLI, e riavviarla per un comando costa più del
  blocco. Gli slot volatili saltano quel turno e tornano al successivo, che li
  ripete comunque; il plan mode lo fa rispettare la CLI stessa
  (`permissionModeForAutonomy`, `server/lib/autonomy-mode.ts:71-73`, `ask` →
  `--permission-mode plan`). Gli slot non volatili ancora da mandare restano in
  attesa del turno dopo come quelli saltati (`skipped` non li segna come inviati).

Non misurato: che la CLI espanda `/vai x` col blocco nel prompt di sistema e
`$ARGUMENTS` uguale a `x`. Il compito 1.12 lo misura sulla CLI vera prima del codice.

## 10. Appunta (scelta 5), il colore, il Finder

**Appunta.** Il gesto salva (tabella `topic_pinned_messages`, letta a `server/utils.ts:519-520`) e
mette i messaggi nel contesto dell'agente (slot `pinned`,
`server/context/assemble.ts:843-845`), ma niente lo mostra: `const [showPinned] =
useState(false)` non ha setter (`ChatPane.tsx:291`), e l'altra porta
(`Layout/ChatPanel.tsx:222`) non si disegna mai perché le due pane passano
`bodyOnly`. Con la scelta consigliata:

- il messaggio appuntato porta il segno (l'icona già gialla del gesto) anche fuori
  dall'hover;
- con almeno un appunto, una riga sopra i messaggi «N appuntati · restano nel
  contesto dell'agente», che apre l'elenco `PinnedMessages` già scritto; ogni voce
  porta al suo messaggio (`requestScrollToMessage`) e si stacca da lì.

L'alternativa toglie il gesto, il suo bottone e lo slot `pinned`; gli appunti già
salvati escono dal contesto al turno dopo («Context no longer in effect: pinned
messages», il ritiro che `adapt.ts` dice già).

**Il colore.** «Cambia colore» (menu della riga, `Modals/ContextMenu.tsx:165-182`) e
il colore nelle impostazioni della chat (`TopicSettingsModal.tsx:364-376`) salvano
`topic.color`, che la riga non dipinge apposta (`Sidebar/TopicItem.tsx:240-243`:
«un default inventato»). Ogni topic ha infatti un colore salvato anche se nessuno
l'ha scelto: `#5865f2` alla creazione (`server/routes/topics.ts:1329,1435,1540`),
`#6366f1` come default della colonna (`server/db/migrations/001-initial.sql:15`), e
nessuno dei due è fra i dieci della tavolozza (`Modals/ContextMenu.tsx:43-45`). Il
colore si dipinge quindi solo quando è uno della tavolozza o comunque diverso dai
due default: un pallino di 6 px prima del nome sulla riga e sulla tab. La colonna di
chi non ha mai scelto un colore resta com'è, e non serve una migration.

**Il Finder.** «Mostra nel Finder» (`Project/FileExplorer.tsx:1416-1422`) chiama
`POST /api/files/reveal`, che lancia `open -R` sul server
(`server/routes/files.ts:1182`): da un telefono o da un altro computer apre il
Finder sul Mac, su un server Windows risponde 500. La riga compare solo nel guscio
desktop collegato a un server su loopback, cioè sulla stessa macchina; un errore lo
dice. Sul Mac l'etichetta resta «Mostra nel Finder».

## 11. Rischi e ordine

- **`slash_commands` e `commands_changed` non sono un'API pubblicata.** Sono campi
  di una CLI di terzi (la stessa classe di `compact_boundary`). Se spariscono il
  menu ricade sulla fixture registrata e sulle cartelle, non si svuota; il test
  della fixture lo dice al primo aggiornamento.
- **Due change prima di questa.** `sidebar-menu-settings` con la modifica del 03/10
  (`openHome`, i pannelli Provider e chiavi e Strumenti, `openUserMenu`; ramo
  `feat/impostazioni-dove-si-usano-1003`) e `model-selector` (⇧⌘M e il selettore,
  proposta non approvata). Senza la seconda /model apre il selettore di oggi,
  `ProviderModelPicker`, con lo stesso evento.
- **Le correzioni senza scelta** (elenco dell'audit del 03/10) atterrano prima;
  tre toccano gli stessi file (`ChatPane.tsx`, `slashCommands.ts`, `adapt.ts`):
  questa change parte dal loro stato. Appunta, il colore, il Finder e il contesto
  delle skill sono usciti da quell'elenco e stanno qui (§9, §10).
- **Il CLI finto delle e2e** (`tests/e2e/helpers/fake-claude-*.ts`) emette un
  `init` scritto a mano senza `slash_commands`. Per le prove serve un finto che
  ripeta righe registrate dalla CLI vera (`init`, `commands_changed`, i
  `<synthetic>`, `compact_result`), detto nel suo header. Non può mostrare una
  compattazione vera, un `/clear` vero, un'espansione vera di una skill, la
  sostituzione di `$ARGUMENTS` né cosa risponde il modello: per il §9 c'è la
  misura del compito 1.12 sulla CLI vera.
