## Da decidere

Esegui sui comandi che l'agente scrive in chat: 3 scelte prima del codice.
1. Esegui fa girare il comando lì, sotto il blocco: output che scorre, esito, durata e Stop, e tutto resta nel thread dopo un ricarico; per `sudo`, login e prompt c'è «Apri nel terminale». Perché: comando e risultato si rileggono insieme, e il motore c'è già (`run_command`: log su file, Stop, pannello Processi, regge al riavvio del server) (o: ogni Esegui apre una pane terminale vera nella cartella della chat, e in chat resta solo una riga che la linka).
2. Il clic su Esegui basta; un secondo passo solo se il comando cancella o forza (`rm -r`, `sudo`, `push --force`, `reset --hard`, `| sh`, `launchctl bootout`…) o ha un segnaposto tipo `<file>`; con caratteri invisibili Esegui non c'è proprio. Perché: una conferma su ogni `ls` insegna a cliccare senza leggere (o: conferma col comando in chiaro a ogni esecuzione).
3. L'agente non vede niente finché non premi «Manda all'agente», che mette comando, esito e ultime 50 righe nella bozza, dove le leggi prima di inviare. Perché: nessun turno pagato né contesto riempito a tua insaputa, e un output con dentro una password non parte da solo (o: entra da solo nel turno dopo, come il `!` di Claude Code).
Compreso, senza scelta: solo blocchi `bash`/`sh`/`zsh`/`shell`/`console` delle risposte dell'agente già finite (mai mentre scrive, mai nei tuoi messaggi, nell'anteprima dei file o sulla board fuori dalla chat); mai eseguito da solo, né al ricarico né da scorciatoia; il blocco intero gira come un solo script, nella cartella in cui lavora l'agente della chat (worktree, poi progetto, poi la home per le 13 chat attive su 446 senza progetto); colori ANSI resi, output lungo mostrato dalla coda con «Mostra tutto»; ospiti fuori, sul telefono sì come il terminale; su Windows il bottone non c'è.
Col sì: nasce la tabella `command_runs` (fino a 256 KB di output per esecuzione) e un ingresso nuovo nel registro dei comandi, con `wake` sempre spento. Costo: una migration sul DB vivo, e ogni output eseguito resta salvato come lo sono già i `bash` dell'agente.
ok / ok ma 2 no

| # | Dove cambiarla |
|---|----------------|
| 1 | `CHAT-RUN-03`, `CMDRUN-05`, `CMDRUN-06`; design §1 |
| 2 | `CHAT-RUN-02`; design §3 |
| 3 | `CHAT-RUN-04`; design §5 |

Mockup dei cinque stati del blocco (fermo, secondo passo, in corso, riuscito, fallito): `mockup.html`.

---

# Esegui un comando dalla chat, e leggi il risultato lì

Richiesta di Attilio del 29/09 (testo in `.openspec.yaml`). La seconda metà della
stessa richiesta, il segno in chat quando l'agente apre il browser, è la change
`chat-browser-open-marker`, non questa.

## Why

Quando l'agente scrive un comando per te (perché serve la tua password, perché
gira su un'altra macchina, perché te lo propone invece di farlo) oggi il giro
è: Copia (`client/src/components/MessageContent.tsx:426`), `+ → Shell`
(`client/src/hooks/usePanelLifecycle.ts:2255`, che crea la shell **senza
cwd**, quindi in `$HOME`: `server/routes/terminal.ts:3009`), `cd` a mano nella
cartella del progetto, incolla, Invio, e se l'agente deve sapere com'è andata,
seleziona l'output e incollalo in chat. Il blocco di codice ha lingua,
numero di righe, `#`, a capo e Copia (`MessageContent.tsx:410-548`); niente
che lo esegua.

Quanto capita, misurato su `data/topics.db` in sola lettura (29/09):

- 92 blocchi etichettati `bash` in 61 risposte di 25 chat da gennaio, 5
  risposte negli ultimi 30 giorni; più 25 blocchi senza etichetta la cui
  prima riga è un comando (`sudo wg-quick up …`, `cd … && bun --bun next dev`).
- Nei blocchi shell la prima parola più frequente è `cd` (35): i comandi si
  portano dietro la loro cartella, quindi girano come script unico.
- 7 cominciano con `sudo`: non possono girare senza terminale, e l'uscita di
  sicurezza «Apri nel terminale» serve davvero.
- Nei blocchi `bash` compaiono `from` (28) e `import` (13) come prima parola:
  l'etichetta a volte mente. Il prezzo di un'etichetta sbagliata è un
  `command not found` letto sotto il blocco, non un danno; per questo non si
  indovina dalle righe senza etichetta.
- Il 29/09 una risposta proponeva `security find-generic-password … -w`, che
  stampa una password: un output del genere non deve arrivare al modello né a
  un ospite senza che tu lo veda (scelta 3, `CMDRUN-05`).
- Un blocco con un segnaposto (`python3 analyze_song.py <take>.mp3`, 22/09):
  eseguito così com'è, zsh lo legge come redirezione. Da qui il secondo passo
  sui segnaposto.

Lo standard che Attilio chiede («leggerli secondo gli standard, al top»),
verificato dove indicato:

- **Claude Code**, `!` in modalità shell: «Adds the command and its output to
  the conversation context», «Shows real-time progress and output», nessuna
  approvazione (code.claude.com/docs/en/interactive-mode, letto il 29/09).
- **VS Code chat**, `!`: il comando «runs immediately… without… asking for
  approval», e «The command output and exit status appear in the chat
  transcript»; nel terminale le decorazioni blu/rosse per l'esito e il menu
  «Copy Output, Rerun Command» (code.visualstudio.com, docs chat-agent-mode e
  terminal/shell-integration, lette il 29/09).
- **Warp**: blocco = comando + output, «non-zero exit code have a red
  background and red sidebar», intestazione col comando che resta in cima
  quando l'output è lungo (docs.warp.dev block-basics, letto il 29/09).
- **Jupyter** (non riletto oggi): la cella gira al clic, output sotto la
  cella, interrompi, riesegui, output lungo in un riquadro scorrevole, colori
  ANSI resi; resta salvato col documento. **Cursor / Copilot in modalità
  agente** (non riletti oggi): il comando proposto dall'agente aspetta
  un'approvazione e l'output torna al modello perché lo ha chiesto l'agente;
  qui chi clicca sei tu, ed è il caso della riga di Claude Code sopra.
  **ChatGPT canvas** (non riletto oggi): Esegui solo su Python/JS in una
  sandbox del browser, console sotto il codice; non esegue shell.

Da qui la forma: al clic gira (Jupyter, Warp, `!`), output sotto il comando
con esito colorato e durata (Warp, VS Code), Stop / Riesegui / Copia output
(VS Code, Jupyter), coda con «Mostra tutto» per l'output lungo, terminale vero
come uscita per ciò che è interattivo.

## What changes

- **Il blocco di codice** (`CodeBlock`, `MessageContent.tsx:411`) guadagna
  «Esegui» e «Apri nel terminale» accanto a Copia, solo quando un contesto
  nuovo glielo dice: `MessageContent` lo fornisce per le risposte `assistant`
  complete con `sessionKey` e `messageId`, a un proprietario, su un server con
  shell POSIX. `markdownComponents` (`:574`) resta una costante: l'anteprima
  dei file (`Editor/MarkdownPreview.tsx:20`) e l'editor (`EditorTabs.tsx:8`),
  che la importano, non vedranno mai il bottone.
- **Il comando** è il testo del blocco così com'è disegnato; per `console` solo
  le righe con il prompt `$ ` o `% `, senza il prompt. Una funzione pura lo
  estrae e ne valuta il rischio (distruttivo, segnaposto, caratteri
  invisibili).
- **Il server**: `POST /api/sessions/:sessionKey/command-runs` lancia il comando
  dal registro dei comandi (`startCommandProcess`,
  `server/routes/processes.ts:785`) con `wake: false` e origine «persona», e
  scrive una riga in `command_runs`. A fine comando la riga prende esito,
  durata e la coda dell'output (256 KB). `GET` sulla stessa route dà l'ultima
  esecuzione per blocco di un messaggio.
- **Sotto il blocco**: l'esito come lo fa Warp/VS Code (stato, `exit N`, durata,
  cartella), output con colori, Stop mentre gira, poi Riesegui, Copia output,
  Manda all'agente, Apri nel terminale, Nascondi.
- **Apri nel terminale**: shell nuova nella stessa cartella, pane accanto alla
  chat, comando incollato **senza Invio** (incolla tra parentesi, così un
  blocco di più righe non parte a metà).
- **Manda all'agente**: comando, esito e ultime 50 righe senza ANSI aggiunti in
  fondo alla bozza della chat (`topics:seed-composer`, `ChatPane.tsx:208-218`,
  che oggi sostituisce: guadagna `mode: 'append'`).

## Non-goals

- Esegui sulle righe `bash` dell'**agente** (la `ShellCard`,
  `client/src/components/Chat/ToolCards.tsx:109`): le ha già eseguite lui.
  «Riesegui» lì è una change a parte, se serve.
- Modificare il comando prima di eseguirlo dentro la chat: si fa in «Apri nel
  terminale», che è anche lo standard (Copilot «Insert into terminal»).
- Standard input e TTY per l'esecuzione in linea: niente password, niente
  prompt, niente `vim`. `sudo` fallisce subito con «a terminal is required» e
  l'uscita è il terminale.
- PowerShell e Windows (2 blocchi `powershell` in 9 mesi): il registro dei
  comandi non ha una shell lì (`server/lib/command-process.ts:20`).
- Indovinare i comandi nei blocchi senza etichetta.
- Storia delle esecuzioni precedenti dello stesso blocco nella UI: si vede
  l'ultima, come in Jupyter. Le altre restano nella tabella.
- Terminale vivo (xterm) dentro il messaggio: vedi design §1.

## Impact

Client: `client/src/components/MessageContent.tsx` (contesto, `CodeBlock`),
nuovo `client/src/components/Chat/CommandRunBlock.tsx` e i moduli puri
`client/src/components/Chat/runnableCommand.ts`, `commandRisk.ts`,
`ansiSpans.ts`; `client/src/components/Chat/ChatPane.tsx` (append alla
bozza); `client/src/components/Terminal/SingleTerminalPane.tsx` (incolla in
attesa); `client/src/lib/api.ts`; i18n `client/src/lib/i18n-it.ts`,
`i18n-en.ts`.

Server: `server/routes/processes.ts` (route, origine persona, chiusura della
riga), `server/lib/command-process.ts` (cartella dell'agente), migration
`server/db/migrations/<timestamp>-command-runs.sql`,
`server/routes/terminal.ts` (`cwdOf` sulla creazione della shell),
`shared/ws-outbound.ts` (frame `command-run:updated`).

Specs: `chat` (CHAT-RUN-01…05), `processes` (CMDRUN-05, CMDRUN-06).
