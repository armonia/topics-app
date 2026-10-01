# Design: chat-inline-command-run

Le scelte che cambiano cosa vedi stanno nel blocco «Da decidere» di
`proposal.md`; qui quelle tecniche, e il perché delle alternative scartate.

## 1. Dove gira: il registro dei comandi, non un terminale

Tre forme possibili.

| | In linea sul registro (consigliata) | Pane terminale vera | xterm dentro il messaggio |
|---|---|---|---|
| Comando e output insieme nel thread | sì | no, output nella pane | sì |
| Dopo un ricarico / su un altro dispositivo | sì (`command_runs`) | scrollback della pane, finché vive | no, o PTY da riattaccare |
| Interattivi (`sudo`, login, prompt) | no, «Apri nel terminale» | sì | sì |
| Costo per esecuzione | un processo, un file di log | un PTY nel ponte + una pane | un PTY + un'istanza xterm per blocco |
| Pezzi nuovi sul server | route + tabella | route per «shell con input» | tutto |

La terza è scartata senza scelta: un'istanza xterm per blocco in una lista che
scorre è la classe di costi già pagata con le pane (memorie «tetto residenza»,
«usePaneAlive»), e un PTY per ogni blocco eseguito resterebbe da ritirare.

La prima riusa `startCommandProcess` (`server/routes/processes.ts:785`), che dà
già: `zsh -c` in una shell interna con il codice d'uscita scritto su file
(`server/lib/command-process.ts:39`), log su file seguito in coda, riadozione
dopo il SIGTERM del watcher (CMDRUN-03), Stop che ammazza il gruppo
(`processes.ts:1862-1871`), ambiente del CLI dell'agente e non del server
(`agentBaseEnv`, `processes.ts:794`), riga `cmd` nel pannello Processi
(CMDRUN-02). Mancano solo: l'origine «persona», il legame col blocco, e la
persistenza oltre i 10 recenti (`MAX_RECENT`, `processes.ts:143`) e i 7 giorni
dei log (`processes.ts:333`).

## 2. Il blocco sa di essere eseguibile da un contesto, non da una prop

`markdownComponents` è una costante di modulo (`MessageContent.tsx:574`) e deve
restarlo: `ChatMarkdown` memoizza sul suo riferimento
(`client/src/components/ChatMarkdown.tsx:164-184`), e cambiarlo per messaggio
rifarebbe il parse di ogni messaggio a ogni render. Quindi:

- `CommandRunContext` (accanto a `MarkdownBaseDirContext`,
  `MessageContent.tsx:43`) con `{ sessionKey, messageId }` oppure `null`.
- `MessageContent` lo fornisce solo se `runnable` (lo passa solo
  `MessageBubble`: la scheda del task sulla board usa lo stesso componente e
  resta senza), `role === 'assistant'`, `!partial`,
  `sessionKey` e `messageId` presenti, sessione di proprietario, e il server ha
  la shell (`hasCommandShell`, `server/lib/command-process.ts:20`: se nessuna
  risposta che il client legge già lo porta, `commandShell: boolean` si
  aggiunge a `/api/auth/session`).
- Il renderer `pre` (`MessageContent.tsx:628`) passa a `CodeBlock` la posizione
  del nodo (`node.position.start.offset`, che react-markdown dà a ogni
  componente): è la **chiave del blocco** dentro il messaggio, stabile finché
  il testo non cambia. Una risposta a timeline ha più segmenti di testo, ognuno
  parsato a sé (offset da 0 in ciascuno): la chiave è
  `segmento × 2^24 + offset` (`commandBlockKey`), il segmento lo dà un
  `CommandRunSegment` attorno a ogni blocco di testo.

`partial` è una guardia reale, non un caso di scuola: durante lo streaming
`completePartialMarkdown` (`MessageContent.tsx:59-60`) chiude i fence aperti,
quindi un blocco a metà si disegna come un blocco finito. `rm -rf ./build/cache`
arrivato fino a `rm -rf ./` sarebbe un blocco perfettamente eseguibile.

## 3. Estrazione e rischio: due funzioni pure

`runnableCommand(lang, text)` → `string | null`:
- `bash`, `sh`, `zsh`, `shell` → il testo, senza la riga vuota finale.
- `console`, `shellsession` → solo le righe che cominciano con `$ ` o `% `,
  senza il prompt, unite da `\n`; nessuna → `null`.
- Tutto il resto, compreso nessuna etichetta → `null`.

`commandRisk(command)` → `{ block: 'hidden-chars' | null, confirm: Reason[] }`:
- `block: 'hidden-chars'` se il testo contiene controlli bidi
  (U+202A–U+202E, U+2066–U+2069), caratteri a larghezza zero (U+200B–U+200D,
  U+2060, U+FEFF) o byte di controllo C0 diversi da `\t` e `\n`: quello che
  vedi non è quello che girerebbe. Esegui non c'è; Copia e Apri nel terminale
  sì, perché lì lo vedi carattere per carattere.
- `confirm` elenca le ragioni del secondo passo: `rm` con `-r`/`-f`/`-R`,
  `sudo`, `git push` con `--force`/`-f`/`--force-with-lease`, `git reset
  --hard`, `git clean -f`, `git checkout -- .` / `git restore .`, `dd`,
  `mkfs`, `diskutil erase`, `chmod -R` / `chown -R`, `find … -delete`,
  `xargs rm`, `curl`/`wget` in pipe verso una shell, `kill -9` / `killall` /
  `pkill`, `launchctl bootout` e `launchctl kickstart -k` (questo progetto li
  chiama per nome: svuotano le pane / SIGKILL a metà turno, `CLAUDE.md`).
  Più `placeholder`: un `<parola>` che non è `<<` né `< file`. Una
  redirezione `>` non si valuta: dal testo non si sa se il file esiste.
- Si scandisce **tutto** il testo, anche quando il blocco è collassato a 10
  righe (`CodeBlock`, `isLong && collapsed`, `MessageContent.tsx:435`).

L'elenco è corto apposta: è un promemoria prima del clic, non un
sandbox. Un falso negativo costa quanto costa oggi incollare lo stesso
comando nel terminale.

## 4. Server: una route, una tabella, l'origine sulla riga

`POST /api/sessions/:sessionKey/command-runs` `{ messageId, blockKey, command }`:
1. La sessione esiste; `messageId` è di quella sessione, `role = 'assistant'`,
   `partial = 0`; altrimenti 404 / 409.
2. Cartella: la stessa del Bash dell'agente, `getTopicWorkspaceForSession`
   (`server/providers/claude-code.ts:592`, worktree pronta › progetto) e
   altrimenti `defaultWorkspace` / `HOME` (`claude-code.ts:2150`). Non
   `resolveSessionCwd` (`processes.ts:1775`): quella rifiuta le chat senza
   progetto (13 su 446 attive negli ultimi 30 giorni), che per l'agente
   hanno comunque una cartella. Si sposta la funzione in `lib/` per non far
   importare un provider a una route.
3. `startCommandProcess` con `wake: false`, `cmd.origin = 'person'`, e
   ambiente `FORCE_COLOR=1`, `CLICOLOR_FORCE=1` al posto di `NO_COLOR`:
   `run_command` spegne i colori perché il suo output va a un modello; questo
   va a una persona.
4. `INSERT INTO command_runs`, risposta `{ runId, processId, cwd, startedAt }`,
   frame `command-run:updated` a chi guarda la sessione.

`finishCommand` (`processes.ts:692`) per una riga con `origin = 'person'`
aggiorna `command_runs`: `ended_at`, `exit_code`, `status` (`done` / `error` /
`stopped` / `unknown`, come CMDRUN-03), `output` = ultimi 256 KB del log
tagliati a inizio riga, `dropped_lines`. Poi il frame.

Tabella (migration nuova):

```
command_runs(
  id TEXT PRIMARY KEY,            -- = processId
  session_key TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  block_key INTEGER NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,           -- running|done|error|stopped|unknown
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  output TEXT,                    -- NULL finché gira: vive nel registro
  dropped_lines INTEGER NOT NULL DEFAULT 0,
  author_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL  -- dimenticare un dispositivo non cancella né blocca le sue esecuzioni
)
INDEX (message_id, block_key, started_at)
```

`GET /api/sessions/:sessionKey/command-runs?messageId=…` → per ogni `block_key`
l'ultima esecuzione. Mentre gira l'output si legge dal registro, con il
cursore che esiste già (`GET /api/scripts/:id/output?offset=`,
`processes.ts:2058`, stesso ciclo di `ProcessLogPane.tsx:100-160`).

Il client lega un'esecuzione al blocco solo se `block_key` **e** `command`
coincidono con il blocco disegnato: dopo una rigenerazione o una modifica,
un'esecuzione vecchia non finisce sotto un comando diverso.

**Ospiti.** Le route stanno sotto `/api/sessions/`, fuori dall'allowlist
dell'ospite (`server/lib/grants.ts:101-143`: `/api/messages/` c'è, ed è per
questo che le esecuzioni NON stanno lì); il frame nuovo non entra in
`GUEST_SAFE_FRAMES` (`grants.ts:203`), che è un'allowlist. Il CSRF da una
pagina qualunque lo ferma già il cancello d'origine sulle POST di `/api/`
(`server/lib/auth-gate.ts:81,106`).

**Nessun potere nuovo.** Un proprietario ha già una shell (terminale via WS) e
l'agente ha già `run_command` sulla stessa strada; questa route lancia la
stessa cosa con un'origine diversa. Non si aggiunge un controllo «il comando
deve comparire nel messaggio»: chi può chiamare la route può aprire un
terminale.

## 5. Manda all'agente: nella bozza, non nel turno

Il testo aggiunto in fondo alla bozza:

```
$ <comando>
(exit <N>, <durata>, in <cartella>)
<ultime 50 righe, senza ANSI>
```

in un fence `console`. Via `topics:seed-composer` con `mode: 'append'`
(`ChatPane.tsx:208-218`, oggi sostituisce). Niente turno, niente riga di
sistema: lo mandi tu, e lo leggi prima. 50 righe e non 20 (`WAKE_TAIL_LINES`,
`server/lib/process-exit-wake.ts:137`) perché qui l'hai scelto tu e vedi quanto
pesa; il resto lo tagli a mano.

L'alternativa (entra da solo, come `!` di Claude Code) vorrebbe una riga
`user` della macchina come `ProcessExitRow` (`client/src/components/Chat/ProcessExitRow.tsx`)
aggiunta al contesto del turno successivo: più codice sul server, e nessuna
occasione di vedere cosa parte.

## 6. Apri nel terminale

- `POST /api/terminal/sessions` accetta `cwdOf: <sessionKey>`: il server
  risolve la cartella con la funzione del §4.2, così il client non deve
  conoscere il percorso della worktree. Il cancello su `cwd` dei dispositivi
  appaiati (`terminal.ts:3000-3008`) vale sulla cartella risolta.
- La pane si apre come `handleQuickCreateTerminal`
  (`usePanelLifecycle.ts:2255-2295`), nel gruppo della chat.
- Il comando non passa da `command` (cancellato dal token dell'agente,
  `terminal.ts:3034`) né da `/send` (`terminal.ts:3108`): lo incolla il client
  con `term.paste()` di xterm alla prima schermata della shell. Con il bracketed
  paste acceso (zsh lo accende di default) un testo di più righe entra come
  incollato e non parte; se la modalità è spenta e il testo ha più righe, non
  si incolla niente, il comando va negli appunti e un avviso lo dice.

## 7. La resa dell'output

- **ANSI**: una funzione pura `ansiSpans(text)` rende SGR (16, 256 e
  truecolor, grassetto, corsivo, sottolineato, dim) come `<span>` con classi
  e stile inline di solo colore; ogni altra sequenza CSI/OSC si toglie, come
  `ProcessLogPane.tsx:17-23` ma senza la sua regex dei frammenti orfani
  (`[32m` senza ESC): qui il log è un file, l'ESC non si perde, e quella regex
  mangerebbe testo vero come `[A` di `[ACME]`. Nessun `innerHTML`.
- **`\r`**: di ogni riga resta il segmento dopo l'ultimo `\r`, come
  `liveShellTail` (`client/src/components/Chat/runningShellTail.ts`).
- **Mentre gira**: riquadro alto 16 righe che segue il fondo; se scorri su,
  smette di seguire finché non torni giù (comportamento di ogni terminale).
- **Finito**: fino a 20 righe tutto; oltre, le **ultime** 20 con «Mostra tutte
  le N righe» sopra. L'errore di un comando sta in fondo; il blocco di codice
  mostra le prime 10 perché lì si legge dall'alto.
- **Esito**: pallino verde + durata per `exit 0`, barra rossa a sinistra +
  `exit N` per il fallimento (Warp, VS Code), «fermato» e «esito sconosciuto»
  in grigio.

## Dove cambiarla

| Scelta | Requisito | Sezione |
|---|---|---|
| 1 dove gira | CHAT-RUN-03, CMDRUN-05, CMDRUN-06 | §1, §4 |
| 2 conferma | CHAT-RUN-02 | §3 |
| 3 cosa vede l'agente | CHAT-RUN-04 | §5 |
