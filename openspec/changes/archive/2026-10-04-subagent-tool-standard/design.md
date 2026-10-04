# Design: subagent-tool-standard

Riferimento: il tool `Agent` di Claude Code (CLI 2.1.285 sul Mac, 29/09), che
ha `prompt`, `description`, `subagent_type`, `model`, `run_in_background`,
`isolation`, una notifica al padre quando un agente in background finisce, e la
ripresa con `SendMessage`. Qui si dice come ciascuna cosa arriva in
`spawn_agent`, e perché in quella forma.

## §1 Il figlio resta una TUI interattiva, non un `claude -p`

Un figlio in `--print --output-format stream-json` risolverebbe da solo tre
problemi: il seed del prompt, perché il prompt è un argomento; la fine turno,
perché c'è un evento `result`; i tetti, perché `--max-turns` e
`--max-budget-usd` esistono solo lì. Costerebbe però la cosa per cui
`spawn_agent` esiste accanto ad `Agent`: il figlio è una tab di terminale
visibile, annidata sotto il padre, in cui l'umano può leggere e **scrivere**.

Tutto quello che questa change deve passare al figlio esiste anche in modalità
interattiva (`claude --help`, 2.1.285): `--model`, `--agent`, `--effort`,
`--resume` e `--session-id`. Per questo il figlio resta com'è, e i tetti di
turni e di spesa vanno nei non-goal.

## §2 Il modello: una catena, risolta dal server

Ordine di risoluzione:

1. `model` della chiamata: `sonnet`, `opus`, `fable` o `haiku`, passato come
   `--model <alias>`;
2. altrimenti il `model:` del profilo (§3), se ne ha uno;
3. altrimenti la scelta 1:
   - **consigliata, `inherit`:** il modello del padre;
   - alternativa: nessun `--model`, e vale il default della CLI.

Da dove si legge il modello del padre, per `inherit`:

| Padre | Fonte |
|---|---|
| chat o card (`topic:<id>`) | `topics.model`, così com'è, compreso il suffisso `[1m]` |
| tab PTY Claude | `message.model` dell'ultimo record assistente del suo transcript |
| modello non Claude (GPT, Gemini, un `auto` non risolto) o nessuna fonte | nessun `--model` |

Nell'ultimo caso la risposta lo dice: `model: "default (parent model gpt-… is
not a Claude model)"`. Il figlio è **sempre** una CLI Claude, qualunque sia il
runtime del padre (nativo `topics`, `claude-code`, Codex con il bridge
completo). Per questo il modello che il figlio può onorare è sempre un modello
Claude, e un padre non Claude non ha nulla da ereditare.

Su `haiku`: il valore esiste perché lo standard lo ha e perché l'umano può
chiederlo. La descrizione del tool dice al modello di **non** sceglierlo da
solo, per la regola di Attilio «mai haiku per un agente economico».

Il modello *effettivo* si legge dopo, da `message.model` del primo record
assistente del figlio, e finisce nell'esito (§4). Quello richiesto e quello
ottenuto possono differire (piano, fallback della CLI), e l'esito deve dire
quello vero.

L'effort segue la stessa catena: `effort` della chiamata, poi `effort:` del
profilo, poi l'override del **topic del padre** (oggi si perde, perché
`topicEffortFor(db, undefined)`), poi Impostazioni, env e `xhigh`, come in
`resolveClaudeEffort`.

## §3 I profili sono i file che la CLI già legge

`agent_type: "<nome>"` diventa `--agent <nome>`. Il server scandisce
`~/.claude/agents/*.md` e `<cwd>/.claude/agents/*.md`; il progetto vince a
parità di nome, come nella CLI. Solo per tre cose:

- rifiutare un nome sconosciuto con un 400 che elenca quelli validi;
- risolvere modello ed effort del profilo (§2), e passarli **espliciti**, così
  la risposta dice quello che parte senza fidarsi di come la CLI combina
  `--agent` e `--model`;
- mettere nella descrizione del parametro `agent_type` i nomi e la prima frase
  di ogni descrizione, al massimo 120 caratteri ciascuna.

Il prompt di sistema e i `tools:` del profilo li applica la CLI. Topics non
ricostruisce la lista dei tool, e per questo la «lista di tool per chiamata» è
fra i non-goal.

Oggi i profili sono 7: `oracle`, `scout`, `verifier`, `worker` e tre
`rivet-worker*` che dicono di sé «not intended for direct invocation». Si
elencano tutti: la descrizione di ognuno basta a tenere lontano il modello.

Alternativa della scelta 2: un elenco proprio di Topics in Impostazioni.
Duplicherebbe file che l'utente mantiene già, e divergerebbe da quello che vede
`Agent` nella stessa chat claude-code.

## §4 Fine turno ed esito

La fine di un turno del figlio si riconosce dal **transcript**, con l'hook
`Stop` (CCS-02, `server/routes/claude-hooks.ts:156`) come acceleratore quando
arriva. Il transcript c'è sempre; l'hook dipende da un wrapper installato. Nel
transcript interattivo il record assistente porta `stop_reason` e `model`:
verificato su un transcript del 29/09, con 50 `end_turn` e 2.930 `tool_use`.

`classifyChildTurn(records, turn)` in `server/lib/subagent-result.ts` è pura e
restituisce un solo esito per turno:

| stato | quando | testo |
|---|---|---|
| `completed` | un `end_turn` dopo l'ultimo record `user` del turno | il testo dell'ultimo messaggio assistente del turno |
| `failed` | record `<synthetic>` o errore API; exit code diverso da 0; «Login expired», «spend limit» | la riga d'errore come `reason` |
| `stopped` | `stop_agent`, tab chiusa o «Ricarica» mentre il turno è aperto | l'ultimo testo, con `partial: true`; mai presentato come esito |
| `undelivered` | nessun record `user` con lo snippet del prompt entro 60 s dal seed | vuoto; `reason: "prompt never reached the child"` |
| `lost` | PTY sparita senza frame `exit` (bridge morto, spazzata delle orfane) | l'ultimo testo, se c'è, `partial: true` |

Uno stop su un figlio **inattivo**, con l'ultimo turno già riportato, non
produce un secondo esito. Il deduplicato passa da `childId` a
`childId + indice del turno`: oggi (`subagent-watch.ts:346`) il primo esito
blocca tutti quelli dopo, e una «Ricarica» brucia quello vero.

## §5 Notifica e risveglio del padre

Per un padre `topic:` l'esito diventa sempre una riga nella chat del padre, con
un blocco `subagent-result` e la card in UI.

Con la scelta 3 consigliata, la riga è un messaggio `user` marcato, che passa
per `POST /api/chat`: è la stessa strada, e lo stesso motivo, del goal loop
(`server/services/goal-continuation.ts:6-20`). Così il padre riparte con un
turno che ha l'esito davanti:

- **Se il turno del padre è in volo** la rotta risponde 409, e l'esito aspetta
  la fine di quel turno. Più esiti che arrivano entro 2 s dall'altro diventano
  **un** risveglio.
- **Il testo del figlio è dato non fidato.** Va in una busta
  `<subagent-result agent="…" status="…">` con i tag di controllo neutralizzati,
  cioè `<` diventa `<\`, come fa la CLI dalla 2.1.210.
- **Il client lo disegna come card**, non come una bolla dell'umano (stesso
  motivo del `goal-nudge`).

Con l'alternativa la riga resta `assistant`, come oggi, ma con la card e lo
stato; non parte nessun turno.

Un padre **PTY** (tab Claude) non riceve push, né oggi né dopo: scrivere nella
TUI di qualcuno mentre l'umano ci digita è peggio del polling. Legge con
`read_agent`, e la risposta del tool lo dice.

## §6 Primo piano

Con `run_in_background:false` la chiamata aspetta il primo esito del figlio
fino a 10 minuti, poi risponde `{status:"running"}`, e l'esito arriva per la
strada del §5.

Per tutta l'attesa il turno del padre deve risultare vivo. Il cane da guardia
del runtime nativo chiude un turno dopo «nessuna attività per 3 minuti»: è
successo in c82359c1, e la regola è che la nostra attesa non è uno stallo.
Quindi l'attesa emette un battito di progresso del tool almeno ogni 30 s.

Implementato a gambe, non con una fetch sola da 11 minuti: `callSpawnAgent`
chiama `GET /agents/:agentId/wait?legMs=25000` finché l'esito arriva o scadono i
10 minuti, emette un battito per ogni gamba vuota e alla fine manda
`release=1`. Il server trattiene gli esiti di un figlio in primo piano (così lo
stesso turno non sveglia anche la chat) fino al rilascio o alla sua scadenza, e
quello che tiene ancora va per la strada del §5: un MCP morto a metà attesa non
perde niente. Ogni gamba ha la sua fetch, con un timeout di gamba + 15 s.

## §7 Ritiro e ripresa

Un figlio che ha riportato il suo turno ed è inattivo si ritira dopo 15 minuti
(scelta 5):

- chiusura graceful della PTY, come il parcheggio (`terminal.ts:2680-2695`),
  che oggi salta i figli;
- riga `subagents.state = 'retired'`, con `claude_session_id`, modello, profilo,
  effort e cartella salvati.

`send_to_agent` su un figlio `retired`, `stopped` o `lost` lo ricrea con
`--resume <claude_session_id>`, gli stessi flag e la stessa cartella, e poi
consegna l'input. Il figlio mantiene lo stesso `agentId`, così il padre non
deve imparare un id nuovo.

La tabella tiene anche `name`, `cwd`, `claude_session_id`, `reported_at`,
`pending_results` e `created_at`: dopo uno stop la riga di `terminal_sessions`
viene cancellata, e senza queste colonne la ripresa non avrebbe da dove
ripartire (implementazione, 01/10).

Oltre 24 h dalla fine, la riga esce da `list_agents` e la ripresa risponde 410
con il motivo. Il transcript resta su disco. Questo spazza anche le righe figlie
dormienti di oggi (`6f44cc46`).

## §8 Tetti

- **Profondità 3 e 5 figli vivi per padre**, come oggi, ma contati dalla
  tabella `subagents` unita alle PTY vive, non da una mappa in memoria che un
  riavvio azzera.
- **Scelta 4:** tetto globale di 6 figli vivi su tutta la macchina. Il rifiuto
  (429) nomina chi occupa i posti (padre e nome) perché il modello possa
  fermarne uno.
- **I rifiuti della board** (`boardSpawnRefusal`, tetto e profondità 1 per i
  figli di card) restano com'erano, e vengono prima.
- **Un figlio ritirato non conta:** non ha processo.
