## Da decidere

Comandi ad hoc nel pannello Processi e sveglia: 4 scelte prima del codice.
1. A fine comando l'agente della topic che l'ha lanciato riceve exit code e ultime 20 righe, dopo il turno in volo. Perché: è la sveglia mancata il 24/09 (o: nota in chat, senza turno)
2. Tool nuovo `run_command`. Perché: il cancello di `run_script` sugli script dichiarati resta intatto (o: `command` opzionale su `run_script`)
3. Le shell in background del CLI si sistemano qui, sola lettura: id senza punto finale, log dal vivo dal file. Perché: la riga c'è ma è muta, e `wait_for_process` sul loro id dà 404 (o: card a parte)
4. Stop dal pannello non sveglia l'agente. Perché: chi ferma ha deciso, e svegliato potrebbe rilanciarlo (o: sveglia con «fermato»)
Compreso, senza scelta: riga «cmd» con log, stato, Stop ed esito; regge al riavvio di CLI e server; un messaggio per processo; niente sveglia su topic archiviata o in `wait_for_process`; ospiti fuori.
Col sì: ogni agente riceve `run_command` e il prompt gli manda le attese lunghe ad hoc invece di Bash in background. Costo: ogni comando finito compra un turno, anche se nessuno guardava.
«ok» = tutte le consigliate · «ok ma 2 no» = cambio la 2.

Se arriva un «no», il requisito da cambiare sta nella colonna «Dove cambiarla»
della tabella in fondo a `design.md`: si cambia lì e nel delta spec, non solo qui.

# Proposal: adhoc-processes-visibility

> Bozza del 2026-09-27, **non approvata**: niente codice finché
> `openspec/changes/adhoc-processes-visibility/.openspec.yaml` non dice
> `status: approved`. Card Topics `25ad016c-2588-43da-b33e-d7889cebdd6a`.

## Why

Il 24/09, nella topic «C'è un task sulla board» (darkroom), un agente ha lanciato
un retry di generazione ogni 15 minuti per 2 ore con `Bash(run_in_background)`.
Nel pannello Processi non c'era niente, e alla chiusura della sessione del CLI
l'attesa è morta con lei: notifica «stopped, nessun record di completamento»,
nessuno svegliato, generazione mai partita.

L'agente non aveva alternative dentro Topics:

- **`run_script` accetta solo script dichiarati.** Il tool prende solo `script`
  (`server/mcp/topics-mcp-server.ts:192-203`, `callRunScript` `:1252-1264`) e
  la route di sessione rifiuta qualunque nome fuori dal manifest
  (`server/routes/processes.ts:1732-1771`). Uno script ad hoc come
  `/tmp/kv/nuovo_v02.sh` non ci può andare.
- **Nessuno riporta l'esito nella topic.** L'handler di uscita
  (`processes.ts:1519-1528`) aggiorna lo stato e trasmette al pannello, basta.
  La sveglia a fine shell è del CLI (`topics-agent-prompt.ts:107-114` lo dice
  già: «it dies with the CLI»).
- **Le shell in background sono già nel pannello (`registerBackgroundShell`,
  `processes.ts:780`), ma col CLI attuale restano mute.** `parseBackgroundShellId`
  (`server/providers/claude/background-shell.ts:83`) legge
  `…with ID: b68urh4wy. Output is being…` come `b68urh4wy.`, quindi
  `wait_for_process` sull'id che l'agente vede non trova la riga
  (`processes.ts:1854`). E l'output arriva solo da `BashOutput`
  (`tool-detail.ts:351`), che il CLI non usa più: `TaskOutput` è mappato come
  controllo di sotto-agente (`tool-detail.ts:275`) e non tocca il registro.

## What changes

- Nasce il tool MCP `run_command {command, cwd?, wake?}` e la route
  `POST /api/sessions/:sessionKey/commands/run`: un comando qualsiasi, nel
  progetto della topic, registrato come un processo di Topics (`source:
  "command"`). `run_script` e il suo cancello restano come sono.
- L'output del comando va **su file** e il codice d'uscita in un file accanto:
  il server lo segue in coda. Così la riga sopravvive anche al reload SIGTERM del
  server, che su questa macchina scatta a ogni salvataggio in `server/`.
- A fine comando la topic che l'ha lanciato riceve **un** messaggio (riga `user`
  marcata come della macchina, blocco `process-exit`) con exit code e ultime 20
  righe, spedito dalla route della chat come fa già la continuazione dei goal,
  dopo il turno in volo.
- Il pannello (`ScriptRunner.tsx`) disegna le righe `command` accanto alle
  shell: oggi un processo con un nome fuori dal manifest non compare da nessuna
  parte (`ScriptRunner.tsx:145-159`).
- Shell in background: id senza il punto finale, log dal vivo seguendo il file
  che il CLI nomina nel risultato di avvio. Sola lettura, nessuna sveglia.
- Il prompt degli agenti (`topics-agent-prompt.ts:59-60`, `:115-116`) indica
  `run_command` per le attese lunghe ad hoc.

## Non-goals

Il lucchetto di OpenBrowser condiviso fra topic («COLLEGATO» nella card): card a
parte. Svegliare l'agente a fine shell in background (resta del CLI). Dare a
`run_script` comandi arbitrari. Aprire la route agli ospiti: `/api/sessions/*`
non è nell'allowlist di `isGuestAllowedPath` (`server/lib/grants.ts:101`) e ci
resta. Cambiare `readoptVerdict` o il ciclo di vita degli script dichiarati.
