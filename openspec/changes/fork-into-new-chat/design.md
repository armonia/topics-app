# Design: fork-into-new-chat

Solo le scelte tecniche; quelle che cambiano cosa vedi stanno nel blocco
«Da decidere» di `proposal.md`.

## 1. Una porta sola: `POST /api/topics/:id/fork`

`server/routes/fork.ts`, `createForkRouter(ctx, { resolveProvider })`, montato
accanto a `createEditRouter` (`server/routes/topics.ts:881`). Corpo
`{ name?: string }`: il nome arriva dal client già tradotto; assente, il server
usa `«<nome> (ramo)»`, come `adopt-claude` usa `«<base> (ripresa)»`
(`topics.ts:1462`).

Controlli, tutti PRIMA di scrivere: topic (404), coordinatore globale
(`isGlobalOrchestratorSession`, 403, stessa risposta di `edit.ts:248-253`),
turno in corso (`isStreaming`, 409 `turn_in_progress`, §3), runtime
(`forkModeFor`, 409 `fork_unsupported`, §8), punto del ramo (400
`nothing_to_fork` se il ramo attivo non ha una risposta finita).

Poi una transazione sola, sulla forma di `adopt-claude` (`topics.ts:1464-1503`),
che crea topic, sessione e storia insieme perché un ramo a metà non compaia mai:

1. topic nuovo con `sessionKey = "topic:" + id.slice(0, 8)` e i campi ereditati
   (`CHAT-FORK-01`);
2. storia: `loadActiveThread(parent, { withBlocks: true })`
   (`server/utils.ts:1300`), tagliata al punto del ramo (§2), senza righe
   `partial`, passata a `copyThreadForFork` e scritta con `saveLocalMessages`
   (`utils.ts:1466`), che porta già blocchi, strumenti, allegati, pensiero e i
   campi di `metaParams`;
3. riga in `chat_forks` (§4);
4. solo per `claude-cli`: riga in `claude_code_sessions` col nuovo uuid (§6).

Fuori dalla transazione: `broadcastToAll({ type: "topic:created", topic })` e
risposta 201.

`copyThreadForFork(rows)` è pura, in `server/lib/chat-fork.ts`: id nuovi
(`crypto.randomUUID()`), `parentId` rimappato sulla riga copiata precedente,
`branchIndex: 0`, tutto il resto invariato. Il ramo copiato è lineare anche se
l'originale aveva fratelli: il ramo parte da UNA storia, quella che vedevi.

Perché non `POST /api/topics` più una copia dal client: sarebbero tre chiamate
e un ramo mezzo creato al primo errore di rete, con la sessione della CLI
ancora da legare.

## 2. Il punto del ramo è l'ultima risposta finita (scelta 1)

Nel database: l'ultima riga `assistant` non `partial` del ramo attivo; la copia
va dalla radice a quella riga compresa. Il suo id NEL RAMO diventa
`fork_point_message_id` (§4).

Per Claude Code il punto va detto anche alla CLI, perché `--fork-session` da
solo copia la sessione della madre com'è al PRIMO AVVIO del ramo, non com'era
al clic: se nel frattempo continui nell'originale, il modello del ramo
conoscerebbe turni che la sua chat non mostra. Alla creazione la rotta legge il
transcript della madre (`claudeTranscriptPath(cwd madre, id madre)`,
`server/lib/claude-transcript-path.ts:83`) e prende l'`uuid` dell'ultima riga
`type: "assistant"` che non sia `isSidechain`. Allo spawn quell'uuid va in
`--resume-session-at` (misurato: il ramo preso a «LIVE-ONE» non conosce
«LIVE-TWO»). Funzione pura `lastMainAssistantUuid(jsonlText)` in
`server/lib/chat-fork.ts`, testata su righe finte.

Perché non da una risposta qualunque: il database non conserva l'uuid del
transcript di ogni risposta, e senza quello l'unica strada per un punto vecchio
è un ramo fresco col riepilogo testuale (CCLI-06), che non ha gli esiti degli
strumenti. È l'alternativa della scelta 1; se la si sceglie, la voce va su ogni
risposta finita, `fork_point_message_id` diventa quella risposta, e per
`claude-cli` e `codex-cli` il runtime del ramo scende a `db-history` quando il
punto non è la coda.

## 3. Durante un turno (scelta 4)

`isStreaming(parent)` dà 409 `turn_in_progress`, come Rigenera
(`edit.ts:323`). Lato client la voce vive solo sull'ultima riga quando è una
risposta finita (§9): durante un turno l'ultima riga è la risposta in corso,
quindi la voce non c'è da sé, senza uno stato «spento» da mantenere.

Con il «no»: il punto diventa l'ultima risposta finita PRIMA del turno in
corso. Nel transcript vuol dire l'ultima riga `assistant` prima della riga
`user` che apre il turno (una riga `user` con testo, non un `tool_result`), e
la copia del database si ferma alla risposta prima del prompt in volo.

## 4. La tabella `chat_forks`

```sql
CREATE TABLE IF NOT EXISTS chat_forks (
  session_key            TEXT PRIMARY KEY,
  parent_topic_id        TEXT,
  parent_name            TEXT NOT NULL,
  fork_point_message_id  TEXT NOT NULL,
  runtime                TEXT NOT NULL CHECK (runtime IN ('claude-cli', 'codex-cli', 'db-history')),
  parent_ref             TEXT,
  parent_at              TEXT,
  created_at             TEXT NOT NULL,
  FOREIGN KEY (session_key) REFERENCES topics(session_key) ON DELETE CASCADE
);
```

- `parent_topic_id` senza chiave esterna: la madre può sparire, il ramo resta
  e la sua riga «Diramata da» perde solo il collegamento.
- `parent_name` è il nome al momento del ramo: la riga lo mostra anche se la
  madre non c'è più.
- `parent_ref`: l'id di sessione della CLI della madre (`claude-cli`) o il suo
  thread (`codex-cli`). NULL vuol dire «la memoria del ramo è la storia
  copiata», ed è lo stato in cui ogni ramo scende quando la strada della CLI
  non è percorribile (§6, §7).
- `parent_at`: per `claude-cli` l'uuid del §2; per `codex-cli` la dimensione in
  byte del rollout della madre al clic (§7).

Una riga sola per ramo, scritta alla nascita. L'unica modifica ammessa è
`parent_ref = NULL` (con `parent_at`) nel recupero. «Il fork è già avvenuto»
non si scrive: lo dice il transcript del ramo (Claude Code) o il suo thread in
`codex_sessions` (Codex), che vincono sempre.

Migration `server/db/migrations/<YYYYMMDDHHMMSS>-chat-forks.sql`, nel formato a
timestamp delle ultime (`20260927091818-message-end-reason.sql`), più la riga
nel manifest `server/db/migrations-embedded.ts`. Il watcher di produzione la
applica al database vivo appena il file esiste: backup di `data/topics.db` e
`-wal` prima di crearla, e prova su un database sintetico
(`tests/integration/migration-074-messages-timestamp-index.test.ts` è la
forma).

## 5. La cartella (scelta 3)

Il ramo eredita `projectPath` e `worktreeId`, quindi
`getTopicWorkspaceForSession` (`claude-code.ts:572-597`) gli dà la stessa cwd
della madre. È la forma di `--fork-session` in Claude Code, che dirama nella
cartella in cui sei.

Con il «no»: la rotta crea una worktree dal ramo git della madre (la stessa
strada del modale, `NewTopicModal.tsx:170-181`) e la lega al ramo. Il fork della
CLI regge la cartella diversa (misurato: il ramo lanciato da un'altra cwd ha la
storia, e il suo transcript va sotto la cwd nuova), quindi il §6 non cambia; il
controllo «il transcript del ramo esiste» usa la cwd del ramo, che è già quella
che lo spawn calcola.

## 6. Claude Code: lo spawn del ramo

Alla nascita (§1, passo 4) la rotta scrive
`claude_code_sessions(session_key ramo, claude_session_id = uuid nuovo)`,
`import_offset` NULL: il ramo non è una sessione adottata e lo sweep di
importazione non lo deve seguire (`topics.ts:1485-1490` spiega il criterio).

Allo spawn (`claude-code.ts:2427-2512`), dopo `getOrCreateClaudeSessionId`
(che trova la riga e risponde `isNew: false`):

```ts
const origin = readForkOrigin(sessionKey); // chat_forks, lettura stretta come le altre
const forkFrom =
  origin?.runtime === 'claude-cli' && origin.parentRef && origin.parentAt
  && !existsSync(claudeTranscriptPath(workspace, claudeSessionId))
    ? { sessionId: origin.parentRef, atUuid: origin.parentAt }
    : null;
```

e `buildClaudeArgs` riceve `forkFrom`. La coda dell'argv diventa:

```ts
...(opts.forkFrom
  ? ["--resume", opts.forkFrom.sessionId, "--resume-session-at", opts.forkFrom.atUuid,
     "--fork-session", "--session-id", opts.claudeSessionId]
  : opts.isNewSession ? ["--session-id", opts.claudeSessionId] : ["--resume", opts.claudeSessionId]),
```

- `needsHistoryReplay` (`:2570`) resta falso con `forkFrom`: la memoria arriva
  dalla CLI, e il riepilogo la duplicherebbe.
- `spawnMeta` porta `forkFrom`, e `isNewSession: false`: un avvio che fallisce
  sulla madre è un resume fallito, non una sessione nuova.
- Il controllo sul transcript del ramo è quello che rende ripetibile lo spawn:
  rifare il fork su un id che esiste è un errore della CLI (misurato,
  «already in use», exit 1). Uno spawn ucciso prima del primo messaggio non
  lascia il file, e allora il fork si rifà, giustamente.

**Recupero.** `markMissingSessionRecovery` (`:3318`) oggi dimentica la sessione
e marca il processo per un respawn fresco. Per un avvio con `forkFrom` fa in
più `UPDATE chat_forks SET parent_ref = NULL, parent_at = NULL`: il respawn
trova una sessione nuova senza origine, parte con `--session-id` e, visto che
il database ha la storia copiata, col riepilogo (CCLI-06). Il fork non si
riprova. Oltre ai motivi di `SESSION_NOT_FOUND_PATTERNS` (`:616`), per il solo
avvio con `forkFrom` vale anche il rifiuto di una bandiera sconosciuta che
nomina `--fork-session` o `--resume-session-at`: è la forma in cui una release
che le toglie si presenterebbe.

`CRITICAL_CLAUDE_FLAGS` (`server/providers/claude/cli-compat.ts:80`) riceve
le due bandiere con il loro `breaks` («i rami ripartono dal riassunto del
database»), senza `introducedIn` finché nessuno l'ha misurato.

## 7. Codex

`resolveCodexInvocation` (`server/providers/codex.ts:238`) resta pura e prende
un argomento in più:

```ts
fork?: { parentThreadId: string; parentRolloutExists: boolean; parentUnchanged: boolean } | null
```

Ordine: thread del ramo salvato e rollout presente → `resume`; altrimenti
`fork` valido e madre presente e ferma → `fork`; altrimenti `fresh`.
`parentUnchanged` confronta la dimensione del rollout della madre con
`parent_at`: se la madre ha fatto turni dopo il clic, `codex exec fork` li
porterebbe nel ramo, e non c'è un `--resume-session-at` per Codex. In quel caso
il ramo scende a `fresh`, cioè alla cronologia in markdown
(`codex.ts:607`), che per il ramo è la storia copiata.

`buildCodexForkArgs` in `server/providers/codex/args.ts`:

```ts
["exec", "fork", opts.parentThreadId, "--json", "--skip-git-repo-check",
 ...codexSharedFlags(opts, true), "-"]
```

- `viaConfigSandbox: true` come il resume: `codex exec fork --help` non ha
  `--sandbox`, ha `-c`.
- Il `-` finale non è decorazione: misurato, senza `-` `codex exec fork` non
  legge stdin, crea un thread vuoto ed esce 0, cioè un turno muto che sembra
  riuscito.
- Il prompt è il solo messaggio nuovo, come per il resume.
- Il thread nuovo arriva da `thread.started` e si salva con
  `saveCodexThreadId` (`codex.ts:265`, chiamata a `:837`): dal turno dopo il
  ramo è un `resume` qualunque.
- `allowResumeFallback` vale anche per `fork`: un fork che muore riparte una
  volta, fresco, e azzera `parent_ref`.

## 8. I runtime senza bandiere, e quelli senza strada

`forkModeFor(providerName)` in `shared/chat-fork.ts`, una tabella letta da
server e client:

| provider risolto | modo |
|---|---|
| `claude-code`, `claude-code-team` | `claude-cli` |
| `codex` | `codex-cli` |
| `topics` (e il vecchio `topics:<modello>`), `claude`, `openai` | `db-history` |
| tutto il resto: `openclaw`, gli agenti ACP (`jcode`, …) | `null` |

`db-history` funziona senza una riga di codice nel fornitore: il nativo legge
la storia della SUA sessione a ogni turno (`nativeHistorySource`,
`server/providers/native/history-source.ts:22`, con i blocchi, quindi con gli
strumenti), `claude` e `openai` hanno la capacità `history` e ricevono il
thread intero dall'inviluppo. La copia del §1 è la loro memoria.

`null`: openclaw e ACP tengono una sessione loro, chiave per `sessionKey`, fuori
da Topics. Un `sessionKey` nuovo aprirebbe una conversazione vuota sotto una
chat che mostra la storia: il difetto che `063-provider-sessions.sql` descrive
per i riavvii. Restano fuori finché non hanno una strada loro.

Il server decide sul fornitore RISOLTO (`resolve-topic-provider.ts`), non sulla
colonna: un topic con `provider` nullo usa quello dell'installazione. Il client
con `provider` nullo mostra la voce e lascia decidere il server.

## 9. Client

**La voce.** In `MessageBubble.tsx`, nella barra delle azioni accanto a
Rigenera (`:420-429`), un bottone `data-testid="msg-action-fork"` con l'icona
`GitBranch` di lucide (import a `:3`), `title` e `aria-label` da
`chat.message.fork` e `chat.message.forkAria`. Prop nuova `onFork?`, passata da
`MessageList` solo alla riga con `isLast` (`MessageList.tsx:2103`) quando è
`assistant` e non `partial`. `ChatPane` la passa solo se non è il coordinatore e
`forkModeFor(topic.provider)` non dice `null`, con la stessa forma di
`onRegenerate` (`ChatPane.tsx:1784`). Sul telefono è la stessa barra, che si
apre tenendo premuto.

**`/fork [testo]`.** Voce in `SLASH_COMMANDS` (`slashCommands.ts:33`) con
`chat.slash.fork.description` e l'icona `GitBranch`; ramo in
`handleSlashCommand` (`ChatPane.tsx:965`), così `slashCommandRouting.test.ts`
lo trova gestito. NON va in `CLI_BUILTINS` (`server/context/adapt.ts:93`): la
CLI non lo riceve mai. Il coordinatore lo blocca già con tutti gli altri
(`ChatPane.tsx:967`).

**Una funzione per entrambe le porte**, in `ChatPane`:

```ts
async function forkHere(prompt?: string) {
  const topic = await topicsApi.fork(topicId, { name: tr('chat.fork.name', { name }) }); // errore → commandResult
  window.dispatchEvent(new CustomEvent('topics:open-topic', {
    detail: { topicId: topic.id, topic, mode: 'permanent', reveal: true },
  }));
  if (prompt?.trim()) await sendMessage(topic.sessionKey, prompt.trim());
}
```

- `topics:open-topic` è la strada per aprire un topic da un'altra superficie
  (`usePanelLifecycle.ts:1547-1583`): applica la proiezione del server senza
  aspettare il WebSocket e chiama `openPanel` (`:1473`), che apre una tab
  permanente col fuoco, nella finestra del progetto per un topic di progetto
  (`setPendingProjectFocus`, `:1511-1524`) o nel gruppo standalone
  (`:1528-1531`), e sul telefono chiude il cassetto (scelta 2). Con il «no»
  serve una richiesta di divisione che `openPanel` oggi non ha (i suoi modi
  sono `preview`, `permanent` e `below`, `:1475`): la divisione a destra passa
  da `split` di `client/src/state/layout/layoutTree.ts:87`.
- `sendMessage(sk, …)` è quella che `ChatPane` riceve già (`ChatPane.tsx:104`),
  per `sessionKey`: il primo messaggio del ramo parte dalla strada normale, con
  la coda del turno e tutto il resto.
- Gli errori (409, 403, rete) vanno in `setCommandResult` col messaggio del
  server tradotto per codice: `turn_in_progress` → «Aspetta la fine del turno»,
  `fork_unsupported` → «Questa chat non si può diramare».

**La riga «Diramata da».** `Topic.forkedFrom` (§11) arriva col topic.
`MessageList` disegna `ForkOriginDivider` (`data-testid="fork-origin-divider"`)
subito dopo la riga `forkedFrom.atMessageId`, nella forma di
`CompactionDivider` (`MessageList.tsx:2085`): «Diramata da <nome>», e il nome è
un bottone che manda `topics:open-topic` sulla madre. Madre sparita: testo
senza bottone. Non è una riga di messaggio, quindi non entra nella storia del
fornitore (HISTBUILD-01), nell'esportazione né nei conteggi.

## 10. Perché `/fork <testo>` non usa `initialMessage`

`Topic.initialMessage` (TOPIC-IM-01, `shared/types.ts:1185-1190`) è nato per
questo («the renderer reads it on first session open, dispatches it»), ma il
lettore non esiste: in `client/src` lo scrive solo `NewTopicModal.tsx:192`, e
nessun file lo legge per spedirlo. Appoggiarcisi vorrebbe dire costruire quel
lettore, con la domanda di quale finestra lo spedisce. `sendMessage` sul
`sessionKey` del ramo, dalla finestra che ha chiesto il ramo, non ha quella
domanda. Il difetto del modale resta per una card sua (proposal, Non-goals).

## 11. Trasporto

`Topic.forkedFrom?: { topicId: string | null; name: string; atMessageId: string }`
in `shared/types.ts`, proiettato dal server da `chat_forks` (una LEFT JOIN nella
lettura dei topic, `server/utils.ts:565` è dove si proiettano i campi
facoltativi) su `GET /api/topics`, `GET /api/topics/:id` e `topic:created`.
Assente per i topic che non sono rami: la lista non cresce per chi non dirama.
