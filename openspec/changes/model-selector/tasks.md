# Tasks: model-selector

Prima del codice: `grep -qx 'status: approved' openspec/changes/model-selector/.openspec.yaml`.
Se esce non-zero, ci si ferma qui.

Prima di archiviare questa change vanno archiviate `ai-control-hierarchy-topics-switch`
e `general-auto-model-ui`, perché il delta modifica i loro requisiti.

**Barra.** Si esegue uguale a ogni giro:
1. `bun run typecheck` (client e server);
2. `bun test shared/task-coding-models.test.ts server/providers/resolve-topic-provider.test.ts server/services/task-dispatcher-topics-routing-default.test.ts server/services/task-dispatcher-auto-topics-routing.test.ts server/services/task-auto-plan.test.ts client/src/lib/topicsRoutingGate.test.ts client/src/components/Shared/ModelSelector`;
3. `bunx playwright test tests/e2e/model-selector.spec.ts tests/e2e/provider-picker.spec.ts tests/e2e/picker-keyboard-nav.spec.ts tests/e2e/effort-single-surface.spec.ts tests/e2e/task-model-labels.spec.ts --project=webkit` sul server isolato :13334.

Quello che è verde resta verde. Le suite intere le fa la CI.

## 1. Test rossi sul tree di oggi

- [ ] 1.1 `shared/task-coding-models.test.ts`: casi di `topicsRoute` (MSEL-06).
  - Casi: `null` più `claude-code:claude-opus-5-5` dà `topics`; `null` più `codex:gpt-6.1-sol` dà `direct/family`; `false` dà `direct/off`; `null` più `claude-code:claude-haiku-3-5` dà `direct/model`; Automatico con motore `loading` dà `pending`; `null` più `topics:claude-opus-5` legacy dà `topics`.
  - Oggi è rosso: la funzione non esiste.
- [ ] 1.2 Stesso file: per ogni chiamante (`topicsRoutingAvailable`, `effectiveTopicsRouting`, `taskProviderForModel`, `reusedSessionRouteConflict`, `resolveTopicProvider`, `topicsRoutingBlocked`), lo stesso caso `null` deve dare la stessa strada. È una tabella sola, un'asserzione per riga (MSEL-06, scenario «una lettura sola»).
- [ ] 1.3 `server/services/task-dispatcher-topics-routing-default.test.ts`: una sessione `null` di Claude Code riusata da una card `null` non si parcheggia (MSEL-06, scenario «sessione riusata»).
- [ ] 1.4 `server/services/task-auto-plan.test.ts`: in Automatico con la preferenza `null`, la scheda contiene ancora i modelli Codex, e un modello Claude scelto passa da `topics` (MSEL-06).
- [ ] 1.5 **Misura, non test.** Su un server di test isolato (:13334), avvia un turno nativo lungo, manda SIGTERM come fa il watcher e annota se il turno finisce o muore. L'esito va nel paragrafo §8 di `design.md`, e cambia la frase del prezzo nella scelta 2.
- [ ] 1.6 Riscrivi sul nuovo contratto i test che fissano il blocco, senza cancellarli. Ognuno deve finire su un'asserzione di «diretto» o di «via Topics»:
  - `client/src/components/Chat/topicsRoutingSendGate.test.ts`
  - `client/src/lib/topicsRoutingGate.test.ts`
  - `server/routes/chat.provider-selection.test.ts`
  - `server/services/task-dispatcher-fanout-routing-block.test.ts`
  - `server/providers/resolve-topic-provider.test.ts`
- [ ] 1.7 `client/src/components/Shared/ModelSelector/useModelCatalog.test.ts`, su uno snapshot finto con Claude Code (gli 11 id misurati) e Codex (gli 8 della cache) (MSEL-02, MSEL-04, MSEL-05):
  - sezioni Anthropic e OpenAI con 4 righe correnti ciascuna;
  - «Altri» con 3 e 4 righe;
  - le coppie `[1m]` diventano una riga;
  - `gpt-5.5` porta il ritiro;
  - le finestre GPT valgono 272000;
  - un modello offerto da due motori diventa una riga con due motori.
- [ ] 1.8 `tests/e2e/model-selector.spec.ts` su :13334 con lo snapshot finto via `page.routeWebSocket`. Prima guarda `provider-picker.spec.ts` e `picker-keyboard-nav.spec.ts` e riusa i loro helper.
  - Composer chat: aperto il selettore, Opus 5.5 e GPT-6.1-Sol sono visibili insieme senza clic.
  - «gpt» nella ricerca lascia solo OpenAI.
  - ⌘⇧M apre; le frecce arrivano da Opus a GPT; Invio sceglie; Esc riporta il fuoco al chip.
  - La fascia è accesa per Opus e mostra «diretto» per GPT.
  - Il chip ha l'icona `Route` solo con Opus.
  - A 390x844: foglio, righe da 44 px, ricerca senza fuoco.
  - Riferimenti: MSEL-02, MSEL-03, MSEL-07, MSEL-08.
- [ ] 1.9 Stesso spec, le altre superfici (MSEL-01, MSEL-10):
  - composer delle card e cassetto: stesso pannello, `data-variant="compact"`, solo motori di codice;
  - impostazioni della board e della chat: `data-variant="full"`;
  - card della board: `chip` di sola lettura;
  - `/model` propone il catalogo.

## 2. Catalogo e strada

- [ ] 2.1 `topicsRoute` in `shared/task-coding-models.ts`. I sei chiamanti la leggono. Escono `TopicsRoutingUnavailableError` per famiglia e modello, e il ramo di blocco di `resolveTopicProvider`, tranne `provider: 'topics'` con il motore giù.
- [ ] 2.2 `task-auto-model.ts`: la scheda non si filtra per instradabilità; la strada si decide dopo la scelta.
- [ ] 2.3 `modelInfo` nello snapshot: Codex dalla cache (`label`, `description`, `contextWindow`, `retiresAt`, `replacement`, `generation`), Claude Code `generation` da `newestOfFamily`, ACP ed endpoint le finestre dichiarate. Lo snapshot emette i provider nell'ordine di `PROVIDER_PREFERENCE_ORDER`.
- [ ] 2.4 `contextWindowFor` riceve la finestra di `modelInfo` prima della tabella.
- [ ] 2.5 `shared/modelMaker.ts` e un test su 10 id veri presi dai cataloghi misurati.

## 3. Il componente

- [ ] 3.1 `Shared/ModelSelector/` (`ModelSelector`, `ModelList`, `useModelCatalog`), sopra `Menu`, `POPOVER_ITEM` e i token di `index.css`. Nessuna durata o colore scritto a mano.
- [ ] 3.2 La fascia (`RoutingBand`) con i tre stati di design §5.2. Il segno `Route` sul chip.
- [ ] 3.3 Righe: nome, interruttore 1M, finestra, «via» (segmento in riga se ci sono più motori), spunta, descrizione nella `full`. Le non disponibili restano disabilitate, con il motivo e «Apri impostazioni».
- [ ] 3.4 Ricerca per sottostringa senza accenti, sezioni con intestazione sticky, «Altri modelli» che si apre sul posto.
- [ ] 3.5 Tastiera (⌘⇧M nel catalogo delle scorciatoie, frecce, `→`/`←` sul «via», Invio, Esc) e ruoli ARIA di design §7.
- [ ] 3.6 Testi it/en di design §5.1. Escono `routingHint`, `routingUnavailable` e `chat.topicsRouting.blocked`, e `chat.picker.search` e affini tornano in uso.

## 4. Le superfici

- [ ] 4.1 `ProviderModelPicker` diventa `<ModelSelector scope="chat" variant="compact">`. Escono il banner rosso e il blocco di invio da `ChatInput` e `ChatPane`.
- [ ] 4.2 `FloatingTaskComposer` e `TaskDetail` passano a `scope="task" variant="compact"`. `TaskModelMenuOptions` sparisce, e il suo adattatore `menuSelection` va in `useModelCatalog`.
- [ ] 4.3 `BoardSettingsPanel`, `TopicSettingsModal` (al posto della `<Select>` solo provider) e il «Modello di default» di `AIProvidersSection` passano a `variant="full"`. Quest'ultimo è filtrato al suo provider, senza fascia.
- [ ] 4.4 La card della board passa a `variant="chip"`.
- [ ] 4.5 `/model`: completamento dal catalogo di `useModelCatalog` nel menu degli slash.
- [ ] 4.6 `AiExecutionMenuOptions.tsx` e `TaskModelMenuOptions.tsx` rimossi. `grep -rn "AiExecutionMenuOptions\|TaskModelMenuOptions" client/src` deve uscire vuoto.

## 5. Prova

- [ ] 5.1 La barra, verde.
- [ ] 5.2 I video `.webm` di 1.8 (desktop e 390 px) e uno screenshot chiaro/scuro del pannello aperto accanto a `mockup.html`, in `screenshots/`.
- [ ] 5.3 `docs/board-protocol.md` non cambia: il dispatcher legge `topicsRoute`, e l'envelope non nomina l'interruttore. Da verificare con `grep -n topicsRouting server/services/task-dispatcher.ts`, e annotare qui l'esito.
