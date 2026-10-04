# Tasks: model-selector

Prima del codice: `grep -qx 'status: approved' openspec/changes/model-selector/.openspec.yaml`.
Se esce non-zero, ci si ferma qui.

Prima di archiviare questa change vanno archiviate `ai-control-hierarchy-topics-switch`
e `general-auto-model-ui`, perché il delta modifica i loro requisiti.

**Barra.** Si esegue uguale a ogni giro:
1. `bun run typecheck` (client e server);
2. `bun test` sui 14 file di 1.6, più `server/services/task-dispatcher-topics-routing-default.test.ts`, `server/services/task-dispatcher-auto-topics-routing.test.ts`, `server/providers/native/agent-loop.test.ts` e `client/src/components/Shared/ModelSelector`;
3. `bunx playwright test tests/e2e/model-selector.spec.ts tests/e2e/provider-picker.spec.ts tests/e2e/picker-keyboard-nav.spec.ts tests/e2e/effort-single-surface.spec.ts tests/e2e/task-model-labels.spec.ts --project=chromium` sul server isolato :13334 (il progetto `webkit` le esclude e uscirebbe 1 con «No tests found»: sul Mac si corrono con una config locale che dà al progetto chromium `browserName: "webkit"`).

Quello che è verde resta verde. Le suite intere le fa la CI.

## 1. Test rossi sul tree di oggi, e una misura

- [x] 1.1 `shared/task-coding-models.test.ts`: i casi di `topicsRoute` (MSEL-06). Oggi è rosso perché la funzione non esiste.
  - Chat, `null` con `claude-code:claude-opus-5-5`: `topics`.
  - Chat, `null` con `codex:gpt-6.1-sol`: `direct/family`.
  - Chat, `false`: `direct/off`.
  - Chat, `null` con `claude-code:claude-haiku-3-5`: `direct/model`.
  - Chat in Automatico, `null`, con default `codex`: `direct/family`.
  - Chat in Automatico, `null`, con default `claude-code`: `topics`.
  - Card, `null` con `claude-code:claude-opus-5-5`: `direct/off`.
  - Card, `true` con `codex:gpt-6.1-sol`: `direct/family`.
  - Card in Automatico con il motore `loading`: `pending`.
  - `null` con il legacy `topics:claude-opus-5`: `topics`.
- [x] 1.2 Stesso file: una tabella con un'asserzione per riga. Per ogni lettore di design §2.1 (`effectiveTopicsRouting`, `topicsRoutingAvailable`, `taskProviderForModel`, `reusedSessionRouteConflict`, `taskModelMatchesSession`, `resolveTopicProvider`, `resolveDispatchTopicIdentity`, `dispatchTopicBinding`, `pickAutomaticTaskModel`, `topicsRoutingBlocked`, `surfaceTopicsRoutingEnabled`), lo stesso `null` e lo stesso bersaglio devono dare la stessa strada (MSEL-06, scenario «una lettura sola»).
  - Un test a parte esegue il `git grep` di design §2.1 e fallisce se compare un file che non è né nella tabella né tra i passaggi.
- [x] 1.3 `server/services/task-dispatcher-topics-routing-default.test.ts`: il riuso delle sessioni (MSEL-06, scenario «sessione riusata»). Oggi il test «senza nessuno dei tre, resta spento» resta verde; questi sono nuovi.
  - Una card `null` che riusa una sessione con 0 non si parcheggia e gira diretta.
  - Una card `null` che riusa una sessione con 1 non si parcheggia e gira sul motore.
  - Una card `true` che riusa una sessione con 0 si parcheggia con il motivo `switch-off`, come oggi.
  - Una card `null` che riusa una sessione `null` di prima del 22/09: prima del turno il topic contiene il valore effettivo della card.
- [x] 1.4 `server/services/dispatch-topic-identity.test.ts`: una card `codex:gpt-6.1-sol` con la preferenza `true` crea il suo topic, con `executor: 'codex'`, invece di lanciare `TopicsRoutingUnavailableError`.
- [x] 1.5 **Misura prima del codice di 2.6, non un test.** *Fatta il 03/10 senza nessuna chiamata a un modello: ascoltatore locale finto, HOME usa e getta (design §2.5, `measurements/`). Prima 0 richieste all'indirizzo di `settings.json`, dopo `POST /v1/messages` e 200 dal finto. Il 200 attraverso il proxy vero su :3336 resta non verificato: costava una richiesta d'uso, vietata in questa tornata.* Con il motore puntato su `ANTHROPIC_BASE_URL` di `~/.claude/settings.json`, una richiesta `complete` di una riga deve rispondere 200, e il log del cambia-account deve mostrarla. Si fa fuori da :3333 e :13333. Costa una richiesta di uso. L'esito va in design §2.5. Se non è 200, ci si ferma su 2.6 e la scelta 2 torna ad Attilio con il prezzo «un account solo».
- [x] 1.6 Riscrivi sul nuovo contratto i 14 file che fissano il blocco, senza cancellarli. Ognuno deve finire su un'asserzione di «diretto» o di «via Topics». L'elenco viene da `git grep -lE "TopicsRoutingUnavailableError|TopicsRoutingIncompatibleError|topicsRoutingBlocked|topicsRouting\.blocked|routingUnavailable|reusedSessionRouteConflict|ai-selector-topics-routing" -- '*.test.ts' '*.test.tsx' '*.spec.ts'`, più `server/routes/chat.provider-selection.test.ts`, che fissa il 409:
  - `client/src/components/Board/TaskModelMenuOptions.test.tsx` (si sposta su `ModelSelector`)
  - `client/src/components/Chat/topicsRoutingSendGate.test.ts`
  - `client/src/components/Shared/AiExecutionMenuOptions.test.tsx` (si sposta su `ModelSelector`)
  - `client/src/lib/topicsRoutingGate.test.ts`
  - `server/providers/resolve-topic-provider.test.ts`
  - `server/providers/topic-provider-resolver.test.ts`
  - `server/routes/chat.outage-direct-answer.test.ts`
  - `server/routes/chat.provider-selection.test.ts`
  - `server/services/dispatch-topic-identity.test.ts`
  - `server/services/task-auto-plan.test.ts`
  - `server/services/task-dispatcher-fanout-routing-block.test.ts`
  - `shared/task-coding-models.test.ts`
  - `tests/integration/process-run-command.test.ts`
  - `tests/integration/question-answer-order.test.ts`
  - `server/services/task-dispatcher-topics-catalog-pending.test.ts` (fuori dal `git grep`: fissava il parcheggio col motore assente; ora la card parte diretta)
- [x] 1.7 `server/services/task-auto-plan.test.ts`: con la preferenza `true` e il motore `ready`, la scheda contiene ancora i modelli Codex, un modello Claude scelto passa da `topics`, e il giudice è un modello servito dal motore, mai `gpt-6-luna` (MSEL-06).
- [x] 1.8 `client/src/components/Shared/ModelSelector/useModelCatalog.test.ts`, su uno snapshot finto con Claude Code (gli 11 id misurati) e Codex (gli 8 della cache, con `modelContextWindows`) (MSEL-02, MSEL-04, MSEL-05):
  - sezioni Anthropic e OpenAI con 4 righe correnti ciascuna;
  - «Altri» con 3 e 4 righe;
  - le coppie `[1m]` diventano una riga;
  - `gpt-5.5` porta il ritiro;
  - le finestre GPT valgono 272000;
  - un modello offerto da due motori diventa una riga con due motori.
- [x] 1.9 `tests/e2e/model-selector.spec.ts` su :13334, con lo snapshot finto via `page.routeWebSocket`. Prima guarda `provider-picker.spec.ts` e `picker-keyboard-nav.spec.ts` e riusa i loro helper.
  - Composer chat: aperto il selettore, Opus 5.5 e GPT-6.1-Sol sono visibili insieme, senza clic.
  - «gpt» nella ricerca lascia solo OpenAI.
  - ⌘⇧M apre; le frecce arrivano da Opus a GPT; Invio sceglie; Esc riporta il fuoco al chip.
  - La fascia è accesa per Opus e dice «diretto» per GPT.
  - Il chip ha l'icona `Route` solo con Opus.
  - Con quattro aziende nello snapshot finto e un viewport alto 900 px, il pannello resta dentro il viewport, l'area delle sezioni scorre e le intestazioni restano ferme.
  - A 390x844: foglio, righe da 44 px, ricerca senza fuoco.
  - Riferimenti: MSEL-02, MSEL-03, MSEL-07, MSEL-08.
- [x] 1.10 Stesso spec, le altre superfici (MSEL-01, MSEL-10): *le superfici delle card (composer, cassetto, impostazioni della board, chip «· via Topics») stanno in `task-model-labels.spec.ts`, che già le apriva; la chat, le sue impostazioni e `/model` in `model-selector.spec.ts`. Girate su Chromium del PC Windows (porta 14201), una spec alla volta.*
  - composer delle card e cassetto: stesso pannello, `data-variant="compact"`, solo motori di codice;
  - impostazioni della board e della chat: `data-variant="full"`;
  - card della board: `chip` di sola lettura;
  - `/model op` propone i modelli del motore attuale della chat.

## 2. Catalogo e strada

- [x] 2.1 `topicsRoute` e `TOPICS_ROUTING_DEFAULT` in `shared/task-coding-models.ts`. I lettori di design §2.1 la leggono. Escono:
  - `TopicsRoutingUnavailableError` per famiglia e modello;
  - il cancello duro di `dispatch-topic-identity.ts:39-42`;
  - il ramo di blocco di `resolveTopicProvider`, tranne `provider: 'topics'` con il motore giù.

  Automatico risolve prima il bersaglio e poi la strada.
- [x] 2.2 Il dispatcher conserva il `null` fino al controllo del riuso. Applica la regola di design §2.3 e scrive il valore effettivo su una sessione `null` riusata prima del turno.
- [x] 2.3 `task-auto-model.ts`: la scheda non si filtra per instradabilità, e la strada si decide dopo la scelta. `task-auto-plan.ts`: con la preferenza accesa e il motore `ready`, il giudice si sceglie tra i modelli che il motore serve.
- [x] 2.4 `CodexProvider.contextWindows()`, letto da `context_window` della cache. `modelInfo` nello snapshot:
  - Codex: `label`, `description`, `retiresAt`, `replacement`, `generation`;
  - Claude Code: `generation`, da `newestOfFamily`.

  Lo snapshot emette i provider nell'ordine di `PROVIDER_PREFERENCE_ORDER`.
- [x] 2.5 `shared/modelMaker.ts`, con un test su 10 id veri presi dai cataloghi misurati.
- [x] 2.6 Il motore legge `ANTHROPIC_BASE_URL`: prima dalla variabile di processo, poi dall'`env` di `~/.claude/settings.json`, poi `https://api.anthropic.com`. Lo prova `server/providers/native/agent-loop.test.ts`, con HOME temporanea e un `settings.json` finto. Solo dopo 1.5.

## 3. Il componente

- [x] 3.1 `Shared/ModelSelector/` (`ModelSelector`, `ModelList`, `useModelCatalog`), costruito sopra `Menu`, `POPOVER_ITEM` e i token di `index.css`. Nessuna durata o colore scritto a mano.
- [x] 3.2 Su desktop, il tetto di altezza viene dallo spazio libero dal lato in cui `Menu` apre. L'area delle sezioni scorre da sola. Fascia, ricerca e Automatico restano ferme.
- [x] 3.3 La fascia (`RoutingBand`) con i tre stati di design §5.2, e il segno `Route` sul chip.
- [x] 3.4 Le righe:
  - nome, interruttore 1M, finestra, «via» (segmento dentro la riga se ci sono più motori), spunta;
  - la descrizione, nella variante `full`;
  - le righe non disponibili restano disabilitate, con il motivo e «Apri impostazioni».
- [x] 3.5 Ricerca per sottostringa senza accenti, sezioni con intestazione sticky, «Altri modelli» che si apre sul posto.
- [x] 3.6 Tastiera e ARIA di design §7:
  - ⌘⇧M nel catalogo delle scorciatoie;
  - frecce, `→` e `←` sul «via», Invio, Esc;
  - i ruoli ARIA.
- [x] 3.7 Testi it/en di design §5.1. Escono `routingHint`, `routingUnavailable` e `chat.topicsRouting.blocked`. `chat.picker.search` e affini tornano in uso.

## 4. Le superfici

- [x] 4.1 `ProviderModelPicker` diventa `<ModelSelector scope="chat" variant="compact">`. Escono il banner rosso e il blocco di invio da `ChatInput` e `ChatPane`.
- [x] 4.2 `FloatingTaskComposer` e `TaskDetail` passano a `scope="task" variant="compact"`. `TaskModelMenuOptions` sparisce, e il suo adattatore `menuSelection` va in `useModelCatalog`.
- [x] 4.3 Passano a `variant="full"`:
  - `BoardSettingsPanel`;
  - `TopicSettingsModal`, al posto della `<Select>` col solo provider;
  - il «Modello di default» di `AIProvidersSection`, filtrato al suo provider e senza fascia.
- [x] 4.4 La card della board passa a `variant="chip"`.
- [x] 4.5 `/model`: nel menu degli slash, completamento con i modelli del motore attuale della chat, presi da `useModelCatalog`.
- [x] 4.6 `AiExecutionMenuOptions.tsx` e `TaskModelMenuOptions.tsx` rimossi. `grep -rn "AiExecutionMenuOptions\|TaskModelMenuOptions" client/src` deve uscire vuoto.

## 5. Prova

- [x] 5.1 La barra, verde. *03/10: verdi typecheck, unit e `model-selector.spec.ts` (5/5). Sul PC Windows `provider-picker`, `picker-keyboard-nav` e `composer-model-memory` non trovano righe `claude-code` pronte: lì Claude Code non è collegato («claude login»), la stessa precondizione della versione di prima; `task-model-labels` si ferma su `openProjectBoard` (percorso Windows), dopo le asserzioni del selettore. Restano da vedere in CI (Linux).* *04/10: visti in CI. Run `37178516138` su `e85a6958a`, gli 8 shard e2e sono verdi, e le quattro spec girano senza skip: `provider-picker` 1/1, `picker-keyboard-nav` 3/3, `composer-model-memory` 1/1, `task-model-labels` 2/2 (desktop e telefono), `model-selector.spec.ts` 5/5.*
- [x] 5.2 In `screenshots/`:
  - i video `.webm` di 1.9, desktop e 390 px;
  - uno screenshot chiaro e uno scuro del pannello aperto, accanto a `mockup.html`.
  *`screenshots/impl-desktop-{light,dark}.png`, `impl-phone-{light,dark}.png`, `impl-main-flow.webm` (Chromium, PC Windows).*
- [x] 5.3 `docs/board-protocol.md` non cambia: il dispatcher legge `topicsRoute`, e l'envelope non nomina l'interruttore. Si verifica con `grep -n topicsRouting server/services/task-dispatcher.ts`, e l'esito va annotato qui.
