## Da decidere

Sotto-agenti di Topics allo standard del tool Agent di Claude Code: 5 scelte prima del codice.
1. Modello quando nessuno lo chiede: quello della chat che delega, come fa Claude Code. Così una chat su sonnet non apre figli su opus (o: il default della CLI, oggi opus[1m] a xhigh, più caro).
2. Profili (scout, verifier, oracle…) letti dai file che Claude Code usa già, `~/.claude/agents` e `.claude/agents` del progetto: una fonte sola, e i tuoi tre arrivano senza lavoro (o: un elenco di Topics in Impostazioni, modificabile da UI ma doppio).
3. Quando il figlio finisce, la chat che l'ha lanciato riparte da sola con un turno che legge l'esito, come le notifiche di Claude Code; se sta già rispondendo, l'esito aspetta la fine del turno (o: solo la card dell'esito in chat, e la chat riparte al tuo prossimo messaggio: zero token in più).
4. Tetto di 6 sotto-agenti vivi su tutto il Mac, oltre ai 5 per chat: ogni figlio è una CLI Claude in più in RAM, e oggi un albero nato da una chat non ha tetto (o: nessun tetto globale, come oggi).
5. Un figlio che ha finito resta acceso 15 minuti per le domande di seguito, poi si spegne e riparte dalla sua storia (`--resume`) quando gli riscrivi: RAM libera, niente perso (o: acceso finché il padre non lo ferma; oggi uno è rimasto su 19 ore).

Compreso, senza scelta: modello, profilo ed effort per chiamata; figlio in primo piano o in background; esito con uno stato vero (finito, fermato a metà, prompt mai arrivato, errore, perso) al posto di «terminato senza output»; card del sotto-agente in chat come quella di Agent, senza emoji; continuare un figlio finito anche dopo un riavvio; worktree resta opzionale com'è.
Fuori: tetto di turni e di spesa per figlio (la CLI interattiva non li ha), figli Codex, e la tua richiesta su bash in linea e browser in chat, che è un'altra change.
«ok» = tutte le consigliate · «ok ma 2 no» = cambio la 2.

---

# Proposal: subagent-tool-standard

> Bozza del 2026-09-29, **non approvata**: niente codice finché
> `openspec/changes/subagent-tool-standard/.openspec.yaml` non dice `status: approved`.

Dove cambiare una scelta del blocco sopra:

| # | Dove cambiarla |
|---|----------------|
| 1 | `SUBAGENT-08` (catena del modello); design §2 |
| 2 | `SUBAGENT-09` (fonte dei profili); design §3 |
| 3 | `SUBAGENT-12` (risveglio del padre); design §5 |
| 4 | `SUBAGENT-15` (tetti); design §8 |
| 5 | `SUBAGENT-14` (ritiro e ripresa); design §7 |

## Why

Attilio, 29/09, sulla chat `topic:5a738995`: aveva scritto «usa sonnet mi
raccomando» e l'assistente ha risposto «Non posso scegliere il modello da qui.
`spawn_agent` non ha un parametro per il modello». Il suo giudizio: «lo
strumento di sotto agenti non è fatto top secondo gli standard».

Lo standard è il tool `Agent` di Claude Code: modello per chiamata, tipi di
agente (profili), background con notifica al padre, ripresa di un agente
finito, worktree opzionale, esito con stato, limiti di profondità e di
concorrenza. `spawn_agent` (`server/mcp/topics-mcp-server.ts:621-640`) ha solo
`prompt`, `name`, `cwd` e `isolation`. Le misure sui 21 giorni dal 08/09 al
29/09 (`data/topics.db`, 4.832 transcript della CLI):

- **Modello.** Tutti i 37 figli con modello leggibile girano su opus-5 o
  opus-5-5, compresi gli 8 nati da un padre su sonnet. `createSession`
  (`server/routes/terminal.ts:3429`) non passa `--model`, quindi vince
  `~/.claude/settings.json` (`opus[1m]`). L'effort salta l'override del topic,
  perché `topicEffortFor(db, undefined)` riceve un topic indefinito, e finisce
  a `xhigh`.
- **Profili.** Nessuno. Il tool `Agent` della CLI ha `subagent_type`, e sui
  transcript CLI 106 chiamate su 1.030 passano un `model`. Nelle chat di
  Topics il runtime nativo non ha `Agent`, e `spawn_agent` è l'unica delega.
- **Esito.** Su 50 figli partiti arrivano in chat 10 messaggi di esito: 3 veri,
  3 frasi a metà lavoro spacciate per esito, 4 «_(terminato senza output)_»
  (`server/routes/subagent-exit.ts:30-37`). La causa vera è quasi sempre un
  prompt mai inviato o uno stop precoce, che il testo non dice. Il titolo usa il
  nome riscritto dall'auto-naming, non quello scelto dal padre, e si apre con 🤖,
  contro la regola «mai emoji».
- **Notifica.** `deliverExit` (`server/lib/subagent-watch.ts:348-378`) scrive
  una riga e basta, e non fa partire nessun turno del padre. E scatta solo
  all'**uscita** del processo, che non arriva mai da sola: la TUI resta in
  attesa e il parcheggio salta chi ha un padre (`terminal.ts:2689`). Il padre
  quindi fa polling: 1.416 `read_agent` nelle chat, mediana 8,5 per figlio,
  massimo 289.
- **Ripresa.** Un figlio fermato, spazzato o perso a un riavvio non si
  riprende: `send_to_agent` risponde 404. `spawnPromptSnippet` non è salvato
  (`terminal.ts:86`), e le righe figlie dormienti non vengono mai spazzate (oggi
  c'è `6f44cc46`, dormiente dal 09/09).
- **Limiti.** Profondità 3 e 5 figli per padre, contati solo in memoria
  (`terminal.ts:2262-2264`). Un albero nato da una chat non ha un tetto
  globale.

I difetti di esecuzione sono corretti a parte, **sullo stesso ramo**
`fix/subagent-tool-standard-0929`, da un altro agente: figlio in `$HOME` invece
che nel progetto (55 su 55 senza `cwd`), prompt incollato da 3 a 7 volte, prompt
dichiarato «preso» quando il transcript ha solo i record di avvio, e nome
sovrascritto. Questa change li presuppone: vedi tasks §0.

## What Changes

- **`spawn_agent` si allinea a `Agent`.** Nuovi parametri: `model`
  (`inherit|sonnet|opus|fable|haiku`), `agent_type` (il nome di un profilo),
  `effort`, `run_in_background` (default `true`). La risposta dice cosa è
  partito davvero: modello, profilo, effort, cartella, ramo.
- **Il figlio parte con i flag giusti.** `createSession` riceve le scelte
  risolte e aggiunge `--model`, `--agent` ed `--effort` alla riga di
  `terminal.ts:1764-1810`. Profilo e modello restano salvati sulla riga del
  figlio.
- **Fine turno riconosciuta dal transcript.** Si legge il primo record
  assistente con `stop_reason: "end_turn"` dopo il prompt accettato, oppure
  l'hook `Stop` (CCS-02) se arriva prima. Il processo resta acceso e l'esito
  parte comunque.
- **Un esito per ogni turno del figlio**, con uno stato: `completed`,
  `stopped` (con `partial`), `failed`, `undelivered` o `lost`. Porta anche il
  motivo, il modello, la durata e il ramo. Sostituisce il testo di ripiego di
  `subagent-exit.ts`, e il deduplicato diventa per turno, non per figlio.
- **Notifica al padre.** Una riga strutturata nella chat del padre, con la
  card, e, secondo la scelta 3, un turno nuovo che legge l'esito come dato non
  fidato. Passa per la stessa strada del goal loop (`POST /api/chat`).
- **Primo piano.** Con `run_in_background:false` la chiamata aspetta l'esito
  fino a 10 minuti, poi risponde «ancora in corso» e l'esito arriva come
  notifica.
- **Ripresa.** `send_to_agent` su un figlio spento lo riapre con
  `--resume <sessione>` nella stessa cartella, con lo stesso modello e lo stesso
  profilo.
- **Limiti contati dal DB**, non dalla memoria: profondità 3, 5 per padre, e il
  tetto globale della scelta 4. Le righe figlie spente o perse escono
  dall'elenco dopo 24 h.
- **UI.** `spawn_agent` ha la card del sotto-agente in chat
  (`client/src/components/Chat/ToolCards.tsx`), come `Agent`: nome, profilo,
  modello, stato ed esito. `SubAgentsStrip` distingue «in attesa del prompt»,
  «lavora» e «ha finito», e le etichette passano da i18n (it/en).

## Non-goals

- **Tetto di turni e di spesa per figlio.** `--max-turns` e `--max-budget-usd`
  valgono solo con `--print`, e il figlio è una TUI interattiva, visibile e
  pilotabile: vedi design §1.
- **Lista di tool per chiamata.** Le restrizioni stanno nel profilo (`tools:`
  del frontmatter), come nello standard.
- **Figli Codex o di altre CLI.** Il figlio resta una CLI Claude.
  `isCodexBridgeOnlyTopic` (`terminal.ts:2326`) resta com'è.
- **Il tool `task` del runtime nativo.** Resta vietato dalla sua spec in
  `openspec/specs/chat/spec.md`.
- **Messaggi fra fratelli senza passare dal padre.**
- **Comandi bash eseguibili in linea e indicatore del browser aperto in chat.**
  Sono l'altra richiesta di Attilio del 29/09, da trattare in una change a
  parte.

## Impact

- **Server:**
  - `server/mcp/topics-mcp-server.ts`: schema e handler di `spawn_agent` e
    `send_to_agent`, più le descrizioni.
  - `server/routes/terminal.ts`: rotte `/agents/*`, `createSession`, lettura
    dell'esito, ritiro e ripresa.
  - `server/routes/subagent-exit.ts` e `server/lib/subagent-watch.ts`.
  - Moduli nuovi e puri:
    - `server/lib/subagent-launch.ts`: risolve modello, profilo ed effort negli
      argomenti della CLI.
    - `server/lib/subagent-result.ts`: classifica un turno del transcript in un
      esito.
  - `server/services/goal-continuation.ts` come modello per il risveglio.
- **DB:** una migration crea la tabella `subagents`, una riga per figlio, con
  chiave `terminal_sessions.id`. Colonne: `parent_session_key`, `model`,
  `agent_type`, `effort`, `prompt_snippet`, `branch`, `state`,
  `turns_reported`, `ended_at`. `claude_session_id` e `status` restano dove
  sono già (migration 009 e 011). Prima di creare il file va fatto il backup di
  `data/topics.db`, perché il watcher la applica al DB vivo.
- **Client:**
  - `client/src/components/Chat/ToolCards.tsx` e `toolDetail.ts`;
  - `SubAgentsStrip.tsx`;
  - un nuovo `SubAgentResultCard.tsx`;
  - le chiavi in `i18n-chat-it.ts` e `i18n-chat-en.ts`.
- **Test:** unit con `bun:test` sui moduli puri e sulla rotta con il bridge
  finto (`server/routes/terminal.agent-spawn.test.ts`). E2E sulla card con
  fixture. Nessun turno vero di claude o di codex.
