## Da decidere

**Approvato il 2026-09-22 17:00.** Risposta registrata in `.openspec.yaml`:
«qua sta uscendo un errore formattato male e non dovrebbe proprio esserci jcode. e dovrebbe finire»

| # | Scelta | Deciso | Dove cambiarla |
|---|--------|--------|----------------|
| 1 | Il verdetto si legge come frase e il payload resta in un dettaglio richiudibile, invece di stampare l'involucro | Sì (consigliata: la frase che serve era sepolta fra due graffe) | `CHAT-REL-07` |
| 2 | Si sistemano tutte e due le strade del verdetto, anche il turno rifiutato prima di partire | Sì (consigliata: sistemarne una sola lascia il difetto segnalato dov'era) | `CHAT-REL-08` |
| 3 | Le 35 righe salvate troncate si leggono, senza riparare il JSON | Sì (consigliata: sono tutte errori `tool_use`/`tool_result`, quelli su cui non puoi agire senza leggere la frase) | `CHAT-REL-07`, scenario «payload salvato troncato» |
| 4 | Niente JCode in questo topic | Sì, verificato: zero righe `provider_sessions` | fuori dal codice, è una prova operativa |

---

# A verdict that reads, on both roads a verdict travels

## Goal
A turn that ends badly says one human sentence, whether the verdict was stored
on the message or thrown by the HTTP call that never got a stream, and keeps
the provider payload reachable instead of pasted in the reader's face.

## Scope
Two boundaries, because the reported defect appears on both:

1. **The stored verdict.** The amber banner reads the string once, through a
   pure function, and folds the payload.
2. **`client/src/lib/api.ts::chatApi.sendMessage` on a non-ok response.** It
   threw `response.text()` verbatim, so a refusal before the turn starts, the
   503s of `server/routes/chat.ts`, reached the chat as an escaped JSON object.
   It now opens the envelope with the same parser `request()` already used.

Coupled to (2) and not separable from it: `useChat` distinguished its two 409s
by searching the thrown message for `duplicate_message`, which only worked
while the message was the raw body. It now reads the code off the error.

Out: how a verdict is produced, stored or retried. Out: importing J-Code
transcripts message by message, touching the sources in the J-Code sessions
folder, and the model evaluation of the recovered topic, which is another card.

## Acceptance bar
- The banner of a payload verdict shows the label, the provider message and the
  advice, with no brace and no escaped quote in the visible line.
- The payload stays reachable, pretty-printed and copyable, in a fold that
  starts closed.
- A payload stored truncated is read too: the provider sentence becomes the
  headline, the fold keeps the cut payload verbatim and says it is partial.
- A verdict that is already prose, or whose braces are not JSON, is printed
  unchanged with no fold.
- A 503 from `/api/chat` throws the provider's sentence and still carries
  `status`, `code` and the remaining fields.
- A 409 `duplicate_message` is still recognised as a duplicate, so the message
  is not re-queued.

## Verification

**Unit, red first on all three fronts, then green.** `bun test
client/src/lib/chatSendMessageError.test.ts
client/src/components/Chat/errorVerdict.test.ts
client/src/components/Chat/TurnErrorBanner.test.tsx
client/src/components/Chat/turnError.test.ts` → **53 pass / 0 fail**, exit 0
(2026-09-22). Before the change: `chatSendMessageError.test.ts` failed 3
assertions (message was the JSON body, `code` undefined), `TurnErrorBanner`
failed on the fold, and the truncated-payload block failed 7 assertions.

**Measured against the real corpus, not only the samples.** A read-only pass
over the reference database applying `readableVerdict` to every verdict row:
all **35** truncated payloads now produce a sentence with no brace and a
verbatim fold, **0** stay raw, and the **36** rows whose braces are not JSON
come out byte-identical to before. That last number is the one that mattered:
it is the proof that reading a cut payload did not start eating prose.

**NOT RUN, and it is not a CI promise.** E2E
`tests/e2e/turn-error-rendering.spec.ts`, case «il payload del provider sta in
un dettaglio richiudibile»: written and annotated `CHAT-REL-07`, **pending**.
It needs a WebKit run against the isolated test server on :13334 and the
`.webm` of that run as the artefact, and neither exists yet. Nobody should read
this section as "the branch CI will cover it".

**Prove operative del topic recuperato** (lette, non promesse, 2026-09-22):
- Topic `8f56c2c4-52d0-4078-b4d2-9f6a2ff46444` gira su **`claude-code` /
  `claude-opus-5[1m]`**, che è la richiesta «non dovrebbe proprio esserci
  jcode».
- **Zero righe JCode in `provider_sessions`** per le chiavi di sessione del
  topic: zero righe di qualsiasi provider, quindi a maggior ragione zero JCode.
- **Transcript intatto**: 19 messaggi, nessuno `partial`, nessuno vuoto.
- Il **risultato del benchmark, 3 su 4**, arriva nello stesso topic ed è il
  contesto per cui il recupero serviva. Resta **fuori dal codice di questa
  change**: qui non c'è una riga che dipenda da quel numero.

## Grounding
Misurato sul database di riferimento il 2026-09-22, su **2.101** righe che
portano il cartello di avviso:

| | righe | cosa succede ora |
|---|---|---|
| payload JSON intero | **91** | frase + payload ripiegato e indentato |
| payload salvato troncato | **35** | frase + payload ripiegato **verbatim**, etichettato come troncato |
| **totale con payload** | **126** | tutte leggibili |
| graffe che non sono JSON | 36 | stampate invariate, nessun dettaglio |
| entità HTML | **0** | nessuna decodifica scritta: sarebbe codice che si difende da un guasto che questa app non produce |

I 35 troncati sono tagliati a 309 caratteri fissi: 9 avevano già chiuso la
stringa `message` prima del taglio, 26 no e la frase finisce con un'ellissi.

**Correzione rispetto alla stesura precedente**, che diceva 125 con payload e
90 interi: la misura rifatta dà **126 e 91**. Il denominatore 2.101 regge. Non
è deriva del database — la riga con payload più recente è del 2026-09-13, non
ne sono arrivate di nuove — era un conteggio sbagliato di uno.
