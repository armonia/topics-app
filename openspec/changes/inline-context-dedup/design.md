# Design — inline-context-dedup

## Il problema in una riga

`adaptInlineSystem` non ha memoria: compone il preambolo da zero ad ogni turno e lo
antepone, mentre il destinatario (una CLI process-resident) quel testo ce l'ha già.

```ts
// server/context/adapt.ts:59-73 — oggi
function adaptInlineSystem(envelope, composedSystem): ProviderPayload {
  let userContent = envelope.userMessage.content;
  if (composedSystem.length > 0) {
    const preamble = composedSystem.map((m) => m.content).join("\n\n---\n\n");
    userContent = `<context>\n${preamble}\n</context>\n\n${userContent}`;  // ← sempre
  }
  ...
}
```

## Perché non basta `leanContext`

Esiste già ed è il flag giusto per il posto sbagliato:

| | `full` (default, chat interattive) | `lean` (dispatcher) | **differenziale (questa change)** |
|---|---|---|---|
| Primo turno | tutto | ridotto | tutto |
| Turni successivi, nulla cambiato | **tutto di nuovo** | niente | niente |
| CLAUDE.md modificato a metà sessione | arriva | **si perde** | **arriva** |
| Plan mode disattivato | il modello non lo sa | il modello non lo sa | **ritiro esplicito** |

`lean` scommette che nulla cambi mai; `full` paga come se cambiasse tutto ogni volta. Un
hash per slot toglie la scommessa dal tavolo: il costo diventa proporzionale al
**cambiamento reale**, che è quanto la CLI stessa fa con i suoi `system-reminder` di file
modificato.

## Unità di deduplicazione: lo *slot*, non il blocco

`composeSystemMessages` non emette un messaggio per `SystemBlock`: aggrega. Nove slot
ordinati, alcuni dei quali fondono più blocchi (tutti i `file:*` in uno; project-awareness
+ tutti i `template:*` in uno).

Deduplicare per `SystemBlock.id` significherebbe ricostruire un messaggio aggregato da un
sottoinsieme dei suoi pezzi — cioè emettere `Context files for this topic:` con dentro il
solo file cambiato, che è **falso** rispetto a quello che è già in sessione.

Quindi l'unità è lo **slot composto**, con id stabile:

```
prompt · files · template · browser · project-markers · topic-switch · memory · pinned · plan-mode
```

`composeSystemMessages` viene rifattorizzata per restituire `{ slot, content }[]`; il
wrapper che restituisce `ChatMessage[]` resta per i chiamanti attuali (regression test
inclusi). Cambia un template ⇒ cambia l'hash dello slot `template` ⇒ quello slot riparte
**intero**, coerente per costruzione.

Hash: `sha256(content)` troncato a 16 hex — collisione irrilevante, confronto a stringa.

## Lo scope: quando la memoria va buttata

La mappa vale per **una** conversazione CLI. Il suo scope:

```
scope = `${claudeSessionId}#${compactionCount}`
```

- **`claudeSessionId`** (`claude_code_sessions.claude_session_id` via
  `server/lib/claude-session-repo.ts`) — cambia su nuova sessione, su `/revive`, su un
  `--resume` che atterra altrove. La CLI nuova non ha mai visto niente: si riparte.
- **`compactionCount`** (`COUNT(*)` su `compaction_markers` per `session_key`) — dopo una
  compattazione la conversazione è un **riassunto**, e nessuno garantisce che il README
  del progetto sia sopravvissuto alla sintesi. Si riparte.

Scope diverso da quello memorizzato ⇒ `sent` svuotata prima del filtro. Nessun listener,
nessun hook da tenere in sincronia: lo scope si **legge** al momento del send. Due letture
indicizzate per turno, trascurabili accanto a un turno di modello.

## Purezza e punto di marcatura

`adaptEnvelope` è documentata pura e la chiamano in due (`chat.ts` e il preview
dell'inspector). Resta pura: lo stato **entra** come argomento ed **esce** come dato.

```ts
adaptEnvelope(envelope, { alreadySent?: ReadonlyMap<string,string> })
  → ProviderPayload & { inlineSlots: { slot: string; hash: string }[] }
```

Chi marca è `chat.ts`, che è già il posto dove si decide di inviare:

```
payload = adaptEnvelope(env, { alreadySent: state.sent })
markInlineSent(sessionKey, scope, payload.inlineSlots)   // ottimistico
drive.catch(() => rollbackInlineSent(sessionKey, scope, payload.inlineSlots))
```

**Perché ottimistico e non nel `.then`.** `sendChat` risolve a turno avviato/concluso; se
l'utente accoda un secondo messaggio prima, quello verrebbe composto con `sent` ancora
vecchia e riemetterebbe il preambolo. Marcare subito chiude la finestra. Il rischio
speculare — marcare qualcosa che non è mai arrivato — è coperto dal rollback nel `.catch`,
che è **lo stesso ramo** dove oggi si scrive già `⚠️ Failed to send message` all'utente.

Asimmetria voluta: sbagliare per eccesso di invio costa ~2k token una volta; sbagliare per
difetto costa un modello che lavora senza sapere in che progetto si trova. Ogni caso
dubbio cade dal lato dell'invio.

## Slot modali e ritiro

`plan-mode` non si deduplica: è uno stato corrente, non un documento, e costa poche
centinaia di token. Va nella lista `VOLATILE_SLOTS`, sempre emesso quando presente.

Per tutti gli altri, la **sparizione** è informazione. Slot in `sent` che non compare più
tra quelli composti ⇒ una riga in testa al preambolo:

```
Context no longer in effect: pinned messages, plan mode.
```

e lo slot esce da `sent`. Chiude un buco che c'è **oggi**: disattivato il plan mode,
niente nel preambolo lo revoca, e il modello continua a comportarsi come se pianificasse.

## Il preambolo quando non resta niente

Se ogni slot è già in sessione e non c'è nulla da ritirare, `userContent` è il messaggio
utente **nudo** — niente `<context></context>` vuoto. È il caso comune a regime, ed è
esattamente ciò che rende il turno "riaccedi" 3 token invece di 1.973.

## Osservabilità e uscita di sicurezza

- `adaptationNotes` — già renderizzate dall'inspector — guadagnano
  `N slot già in sessione, saltati (~M token risparmiati)` con gli slot elencati per nome.
  Il comportamento è ispezionabile senza leggere il codice.
- `TOPICS_INLINE_CONTEXT_DEDUP=0` ⇒ `alreadySent` è sempre vuota ⇒ comportamento
  byte-identico a oggi. Un solo punto di lettura dell'env, in `chat.ts`.

## Perché in memoria e non a DB

Perdere la mappa costa **una** re-iniezione (~2k token) e si ricostruisce da sola al turno
dopo. Una tabella per proteggere 2k token occasionali sarebbe una migration, uno schema e
una pulizia da mantenere per sempre. In dev il server si riavvia spesso e la dedup si
azzera: resta comunque 1 iniezione per riavvio contro 33.

Se un giorno la misura dicesse che i riavvii sono il fattore dominante, la mappa ha già la
forma di una riga (`session_key`, `scope`, `sent_json`) e la si persiste senza toccare i
chiamanti.

## Rischi

| Rischio | Mitigazione |
|---|---|
| Il modello "perde" il progetto perché uno slot non riparte | Lo scope si invalida su sessione nuova **e** su compattazione, i due soli eventi che possono cancellare il preambolo dalla conversazione CLI |
| Marcatura ottimistica su un send fallito | Rollback nel `.catch` già esistente |
| L'inspector mostra un preambolo diverso da quello inviato | Le `adaptationNotes` dichiarano gli slot saltati; i blocchi restano visibili in elenco |
| Regressione silenziosa sul primo turno | `regression.test.ts` gira con `alreadySent` vuota — che *è* il primo turno — e deve restare byte-identico |
