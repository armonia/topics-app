# Tasks — inline-context-dedup

## 1. Slot composti

- [x] 1.1 In `server/context/adapt.ts`, estrarre `composeSystemSlots(blocks): { slot, content }[]`
      con gli id stabili `prompt · files · template · browser · project-markers ·
      topic-switch · memory · pinned · goal · plan-mode`, nell'ordine attuale.
- [x] 1.2 Ridefinire `composeSystemMessages` come wrapper (`slots.map(s => sys(s.content))`)
      così i chiamanti e `regression.test.ts` non cambiano di una riga.
- [x] 1.3 Test: `composeSystemSlots` produce gli stessi contenuti, nello stesso ordine, di
      `composeSystemMessages` su un envelope con tutte le categorie popolate.
- [x] 1.4 Bug preesistente: aggiungere lo slot `goal` (`synthetic:goal`), che nessuno degli
      slot raccoglieva — l'obiettivo del topic veniva assemblato, contato nel budget e poi
      scartato in silenzio. Test che oggi `composeSystemMessages([goalBlock])` non è più `[]`.

## 2. Stato per sessione

- [x] 2.1 Nuovo `server/context/inline-sent-state.ts`: `getInlineSentState(sessionKey, scope)`
      (svuota se lo scope differisce), `markInlineSent`, `rollbackInlineSent`,
      `resetInlineSent`. Mappa bounded (cap ~256 sessioni, eviction FIFO).
- [x] 2.2 `hashSlot(content)` = `sha256` troncato a 16 hex.
- [x] 2.3 Test `inline-sent-state.test.ts`: mark → hit; contenuto diverso → miss; scope
      diverso → svuotamento; rollback ripristina lo stato esatto precedente; eviction al cap.

## 3. Filtro nell'adattatore

- [x] 3.1 `adaptEnvelope(envelope, opts?)` con `opts.alreadySent?: ReadonlyMap<string,string>`;
      restituisce anche `inlineSlots: { slot, hash }[]`. Firma a un argomento invariata.
- [x] 3.2 `adaptInlineSystem`: salta gli slot con hash già presente, tiene sempre i
      `VOLATILE_SLOTS` (`plan-mode`), antepone la riga di ritiro per gli slot spariti,
      **omette del tutto** `<context>` quando non resta nulla da dire.
- [x] 3.3 `buildInlineSystemNotes`: aggiungere gli slot saltati per nome e i token risparmiati.
- [x] 3.4 Test in `adapt.test.ts`: primo turno completo · secondo turno vuoto · hash cambiato
      → slot intero · `plan-mode` mai saltato · ritiro emesso una volta sola · strategie
      non-inline invariate.

## 4. Aggancio al send

- [x] 4.1 In `server/routes/chat.ts`, prima di `adaptEnvelope`: leggere `claudeSessionId`
      (via `server/lib/claude-session-repo.ts`) e il conteggio dei marker di compattazione,
      comporre `scope`, ottenere lo stato. `TOPICS_INLINE_CONTEXT_DEDUP=0` ⇒ stato vuoto.
- [x] 4.2 Passare `{ alreadySent }` ad `adaptEnvelope`; marcare subito dopo con
      `markInlineSent`.
- [x] 4.3 `rollbackInlineSent` nel `.catch` di `drive` — lo stesso ramo che scrive già
      `⚠️ Failed to send message`.
- [x] 4.4 Verificare che il preview dell'inspector (`server/routes/context-preview.ts`)
      continui a chiamare `adaptEnvelope` **senza** `alreadySent` e non marchi nulla.

## 5. Prompt caching sui provider SDK

- [x] 5.1 Nuovo `server/providers/prompt-cache.ts`: `applyPromptCache(params)` in-place —
      breakpoint effimero su ultimo tool, fine `system` (convertito in blocchi di testo),
      ultimo messaggio. Massimo quattro, no-op quando non c'è nulla di stabile.
- [x] 5.2 Applicarlo ai tre call-site di `server/providers/claude.ts`: `sendChat`,
      `streamHTTP`, `complete`.
- [x] 5.3 Test `prompt-cache.test.ts`: marker su tool/system/ultimo messaggio · `system`
      stringa → blocchi · conteggio ≤ 4 · params vuoti invariati · idempotenza.

## 6. Finestre di contesto e ring (fronte aperto in corsa)

- [x] 6.1 `server/usage/context-window.ts`: correggere la tabella — 1M è la finestra
      DI SERIE da Opus 4.6 / Sonnet 4.6 in avanti e su tutta la generazione 5, non una
      variante. `DEFAULT_CONTEXT_WINDOW` a 1M; fallback di famiglia: opus/sonnet 1M,
      haiku 200k. Fonte: tabella modelli della skill `claude-api`.
- [x] 6.2 `windowForMeasure(measure, currentModel)`: il DENOMINATORE si ricalcola sul
      modello corrente del topic, il NUMERATORE resta la misura. Chiude due cose
      insieme — le righe scritte con la finestra sbagliata si autocorreggono, e un
      cambio di modello si vede subito.
- [x] 6.3 Applicarla a `GET /api/context/live` e ri-emettere `stream:context` sul
      cambio di modello (`PATCH /api/topics/:id`), invece di aspettare il turno dopo.
- [x] 6.4 `scripts/token-live.ts`: saltare le righe `<synthetic>` (usage a zero: la
      CLI le scrive per errori e interruzioni). Il ring del server è già immune.
- [x] 6.5 Test: finestre per generazione · alias corti · legacy a 200k · default
      stimato · `windowForMeasure` (correzione, modello corrente, fallback, estimated).

## 7. Consumo: le leve misurate (giro del 30/07)

- [x] 7.1 Misure verificate con controprova indipendente su transcript reale
      (275 risposte, dedup per `message.id`). Decomposizione del contesto letto:
      58,6% storia accumulata × n chiamate · 19,3% output riletto · 14,3% tool_result
      · 8,8-17,3% thinking. Le tre ipotesi erano sovrastimate: thinking non 35%,
      schemi MCP già deferiti (1,2%, non 17,8%), e la causa delle riscritture di
      cache non è il gateway condiviso ma un server che si riavvia.
- [x] 7.2 `isColdBootServer`: i server `stdio` con `npx -y` non entrano nelle chat.
      8 richieste su 275 portavano l'85% delle scritture di cache (~$20-33/sessione).
      Regola strutturale + log dell'esclusione + due uscite via env.
- [x] 7.3 Soglie assolute di contesto (200k/400k) accanto a quelle percentuali, con
      `ContextReason` per dire QUALE è scattata: su 1M il 70% è 700k e non avvisava
      mai, mentre ogni chiamata rileggeva già 380k.
- [x] 7.4 `cacheWrite1hTokens` anche in `transcript-usage.ts`: il chip del board
      smette di tariffare a 1.25x scritture che costano 2x.
- [x] 7.5 Flaky ACP: i due test di abort aspettano una condizione invece di 150ms.
      Suite server intera verde (1816 pass, 0 fail).

## 8. Verifica

- [x] 8.1 `bun test server/context/ server/providers/` verde, `regression.test.ts` incluso.
- [x] 8.2 Misura su transcript reale: rigirare lo script di conto composto
      (`iniezioni <context>` per sessione) su una chat nuova e mostrare 1 iniezione invece
      di N. Evidenza: numeri prima/dopo.
- [ ] 8.3 E2E: una chat di più turni su `claude-code` risponde ancora in modo coerente sul
      progetto dopo che il contesto non viene più ripetuto (il modello sa ancora dove si trova).
- [ ] 8.4 Anteprima durevole per la consegna: il comportamento è dinamico (più turni) ⇒
      **video**, non screenshot.

## 9. Fuori scope, da aprire come task top-level

- [ ] 9.1 (CHIUSO dalla misura 7.1: gli schemi MCP sono già deferiti, 1,2%) overhead fisso (~48k token alla prima risposta) degli schemi dei tool
      MCP montati per sessione.
