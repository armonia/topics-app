## Da decidere

Coda viva dei tool lunghi: 2 scelte prima del codice.
1. Si riusa `stream:tool_update`, testo cumulativo, emesso dal runtime nativo `topics` (il default); codex, acp e openclaw lo mandano già. Perché: il client lo coalesce già e sostituire non raddoppia (o: nuovo `stream:tool_output_delta` ad append: coalescing nuovo, doppio nella finestra da cui scrivi).
2. Mentre gira, il corpo aperto mostra le ultime 8 righe con l'avviso che sopra ce n'è altro; a fine comando l'output completo, come oggi. Perché: altezza fissa, la chat non salta a ogni aggiornamento (o: tutto l'output in un riquadro scorrevole tenuto in fondo).
Compreso, senza scelta: solo `bash` fra i tool nativi; la coda arriva anche alla finestra da cui hai scritto (oggi la scarta); il runtime `cli` resta senza, il suo stream porta solo battiti; max 4 aggiornamenti/s, mai salvati.
Col sì: si vede anche l'output vivo di codex, acp e openclaw, che oggi arriva e si butta. Costo: ogni bash di ogni chat passa dal nuovo callback; un suo errore o un comando verboso non devono toccare il tool (try/catch, throttle 250 ms).
«ok» = tutte le consigliate · «ok ma 2 no» = cambio la 2.

| # | Dove cambiarla |
|---|----------------|
| 1 | `CHAT-NTOOL-04` (emissione) e `CHAT-TOOL-09` (consegna); design §1 |
| 2 | `CHAT-TOOL-08`; design §4 |

---

# Tool lunghi: la coda dell'output mentre gira

Card `f33b1be4-6cb1-489e-b967-aed0df02c30f` (review tool-UX del 23/09, finding 7).

## Why

Un `bash` al p90 dura 65-115 s, e per tutto quel tempo la riga mostra uno
spinner e `$ comando`. Niente dice se sta lavorando, se è fermo su un prompt o
se sta fallendo al test 3 di 400. Tre buchi, uno dietro l'altro:

1. **Il runtime nativo non manda niente.** È il default
   (`shared/types.ts:128`, `DEFAULT_AGENT_RUNTIME = 'topics'`). `runCommand`
   (`server/providers/native/tools.ts:262`) accumula stdout/stderr in `out` e lo
   restituisce solo alla chiusura; `ToolContext` (`tools.ts:38`) non ha un gancio
   di avanzamento, e `agent-loop.ts:884` chiama `executeTool` senza callback.
   `handler.onToolUpdate` lo chiamano solo codex (`codex.ts:859-957`), acp
   (`acp.ts:592`) e openclaw (`openclaw.ts:36`).
2. **Il client butta l'output anche quando arriva.** `useChat.ts:1210` scrive il
   parziale in `tc.result`, ma `chat.ts:2589` ha già dato alla riga un `detail`
   tipizzato `shell` senza `output`, e `resolveToolDetail`
   (`client/src/components/Chat/toolDetail.ts:431-459`) restituisce quello per
   primo: `ShellCard` (`ToolCards.tsx:108`) riceve `output = undefined` finché
   gira. Per questo oggi non si vede nemmeno l'output di codex.
3. **La finestra da cui hai scritto lo scarta.** `onToolUpdate`
   (`chat.ts:2765`) va solo su WS (`broadcastTurnFrame`, nessun `writeSSE`), e
   `stream:tool_update` non è in `SENDER_ALSO_SEES`
   (`client/src/hooks/senderAlsoSees.ts:44`): `useChat.ts:1304` lo lascia cadere
   per la sessione che ha l'SSE locale (`useChat.ts:1857`).

Il runtime `cli` non può partecipare: il suo stream-json porta solo battiti
`tool_progress` con `elapsed_time_seconds` e nessun output
(`server/providers/claude/background-work.test.ts:128`).

## What changes

- **Server, nativo.** `ToolContext` guadagna `onOutput?(tail)`; il `bash`
  (`tools.ts:565`) lo passa a `runCommand`, che lo chiama al massimo ogni 250 ms
  con gli ultimi 16 KB dell'output, cumulativi. `agent-loop.ts:884` lo collega a
  `handler.onToolUpdate(t.id, tail)`. Nessun evento nuovo sul filo.
- **Client, riga.** Una riga `shell` in corso senza `output` tipizzato prende la
  coda da `tc.result` e ne mostra le ultime 8 righe, con l'avviso che sopra ce
  n'è altro. A fine comando torna l'output definitivo del `detail`, come oggi.
- **Client, consegna.** `stream:tool_update` entra in `SENDER_ALSO_SEES`, e un
  parziale non scrive mai su una riga già chiusa.

## Non-goals

- Nessuna PTY. Un programma che su una pipe bufferizza a blocchi (python senza
  `-u`, binari C) arriva a raffiche o solo alla fine: resta così.
- Nessun output vivo per il runtime `cli`, per `grep` e per gli altri tool
  nativi.
- Nessuna persistenza della coda: i frame restano effimeri
  (`server/routes/tasks.ts:1243`). Una finestra che si ricarica a metà comando
  riprende dal frame successivo.
- Nessun cambio a CHAT-TOOL-03 (quando il corpo si apre e si richiude) né alla
  resa dell'output finale.

## Impact

`server/providers/native/tools.ts`, `server/providers/native/agent-loop.ts`,
`client/src/components/Chat/toolDetail.ts`, `client/src/components/Chat/ToolCards.tsx`,
`client/src/hooks/senderAlsoSees.ts`, `client/src/hooks/useChat.ts`, i18n
(`client/src/lib/i18n-it.ts`, `i18n-en.ts`). Test: vedi `tasks.md`.
