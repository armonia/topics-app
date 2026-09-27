# Tasks: live-tool-output-tail

Prima del codice: `grep -qx 'status: approved' openspec/changes/live-tool-output-tail/.openspec.yaml`.

## 1. Test rossi sul tree di oggi

- [x] 1.1 `server/providers/native/tool-output-stream.test.ts` (bun:test): i quattro scenari di CHAT-NTOOL-04 su `executeTool('bash', …)`. Rosso oggi: `ToolContext` non ha `onOutput`.
- [x] 1.2 `client/src/components/Chat/runningShellTail.test.ts` (la funzione pura sta accanto a `toolDetail.ts`, in `runningShellTail.ts`: dentro avrebbe importato `toolGrouping`, che importa `toolDetail`): «venti righe, se ne vedono otto» e «una barra di avanzamento è una riga» (CHAT-TOOL-08) sulla funzione pura.
- [x] 1.3 `client/src/hooks/senderAlsoSees.test.ts`: `senderAlsoSees('stream:tool_update') === true` (CHAT-TOOL-09); aggiorna il conteggio delle eccezioni.
- [x] 1.4 Test della guardia di `flushToolUpdates`: un parziale su una riga `success` non cambia `result` (CHAT-TOOL-09). Se la guardia sta in una funzione pura accanto a `toolUpdatePatch.ts`, bun:test lì.
- [x] 1.5 `tests/e2e/tool-live-tail.spec.ts` su `:13334`, frame iniettati con `page.routeWebSocket` (CHAT-TOOL-08, terzo scenario). Prima controlla `tests/e2e/tool-call-rendering.spec.ts`: se ha già l'impalcatura per iniettare `stream:tool_call`, estendi quella. Scritto; lo esegue la CI, qui Playwright non gira.

## 2. Server (CHAT-NTOOL-04)

- [x] 2.1 `ToolContext.onOutput?` in `server/providers/native/tools.ts:38`, con il commento del perché.
- [x] 2.2 In `runCommand`: buffer di coda da 16 KB separato da `out`, throttle 250 ms con chiamata finale in coda, annullata in `chiudi`; `try/catch` attorno al callback. Solo il caso `bash` lo passa.
- [x] 2.3 `agent-loop.ts:884`: contesto per chiamata con `onOutput` → `handler.onToolUpdate?.(t.id!, s)`.

## 3. Client (CHAT-TOOL-08, CHAT-TOOL-09)

- [x] 3.1 Funzione pura del taglio (8 righe, `\r`, `hiddenAbove`).
- [x] 3.2 `ShellCard` (`ToolCards.tsx:108`): blocco `shell-running-tail` + avviso i18n (`i18n-it.ts`, `i18n-en.ts`) quando la riga gira e il `detail` non ha `output`.
- [x] 3.3 `'stream:tool_update'` in `SENDER_ALSO_SEES` e nel tipo `SenderVisibleEventType`, con la riga che lo motiva nel commento del file.
- [x] 3.4 Guardia di stato in `flushToolUpdates` (`useChat.ts:1210`).

## 4. Verifica

- [x] 4.1 I test del §1 verdi; typecheck; rails statiche.
- [ ] 4.2 Prova video dell'E2E (`.webm`) con la coda che scorre e poi lascia il posto all'esito. Aperto: in questa sessione Playwright non gira (il server di test sulla 13334 è condiviso con altri agenti), e la CI registra il video solo con `E2E_VIDEO=1`. Il `.webm` viene da `E2E_VIDEO=1 npx playwright test tests/e2e/tool-live-tail.spec.ts`.
