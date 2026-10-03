## Da decidere

Selettore del modello e «Instrada via Topics»: 5 scelte prima del codice.

1. Acceso vuol dire «quando si può»: Claude passa da Topics, GPT, Gemini e le API vanno diretti e la riga lo dice, l'invio non si blocca mai, perché l'acceso rigido di oggi dà 409 a ogni chat su Codex e parcheggia le card `codex:` (o: acceso rigido, invio bloccato col banner rosso).
2. Acceso di default per tutte le chat, anche quelle che esistono già; le card mai toccate seguono il default della board, che resta spento, perché un turno che passa da Topics muore a ogni riavvio del server e viene rifatto (pagato due volte), e le card sono i turni più lunghi (o: acceso anche per le card).
3. Una riga per modello, raggruppate per azienda (Anthropic, OpenAI, Google, altri), col motore scritto sulla riga («via Topics», «via Codex»), perché per motore gli stessi modelli Claude comparirebbero due volte, sotto Claude Code e sotto jcode (o: gruppi per motore come oggi, tutti aperti insieme).
4. Su desktop una colonna per azienda, affiancate (pannello di circa 700 × 300 px, ricerca in cima che filtra tutte le colonne), sul telefono una lista sola, perché è quello che hai chiesto: con 4 aziende la lista unica supera gli 850 px e Google si vede solo scorrendo; costa due impaginazioni da tenere e testare (o: lista unica ovunque, larga 352 px, intestazioni ferme, dalla terza azienda si scorre).
5. L'interruttore si chiama «Esegui in Topics», sta in una fascia colorata in cima al selettore con una riga di spiegazione, e il bottone del modello mostra un segno quando è acceso, perché oggi la spiegazione sta solo in un tooltip che sul telefono non si vede (o: tenere «Instrada via Topics» e aggiungere solo la riga).

Compreso, senza scelta:
- **Il motore di Topics passa dallo stesso proxy degli account di Claude Code.** Le sessioni Claude Code lanciate da Topics leggono `~/.claude/settings.json` (`--setting-sources user,project,local`, `server/providers/claude/args.ts:328`). Su questo Mac lì c'è `ANTHROPIC_BASE_URL=http://127.0.0.1:3336`: è il cambia-account, con 2 account e `autoSwitch: true` (misurato). Il motore invece chiama sempre `https://api.anthropic.com/v1/messages` (`server/providers/native/agent-loop.ts:53`), con l'unica credenziale del Portachiavi (`native/auth.ts:139`). Con questa change legge lo stesso indirizzo. Prima del codice si misura che una sua richiesta passi davvero dal proxy (tasks 1.5). Se non passa, la scelta 2 deve aggiungere anche questo prezzo, «un account solo invece della rotazione», e torna a te.
- **Automatico segue il default, poi l'interruttore.** Prima si risolve il bersaglio come a interruttore spento, poi si decide la strada. Così chi ha un default esplicito su Codex o sulle API (`server/providers/index.ts:184-188`) resta lì.
- **Un componente solo, `ModelSelector`, con tre varianti dichiarate e motivate.** «Compatta» per il composer della chat, il composer delle card e il cassetto della card. «Intera» per le impostazioni: default della board, modello di default per provider, impostazioni della chat. «Chip» per la card della board: si legge soltanto, e il clic apre la compatta.
- **Restano solo le differenze utili.** In chat la finestra di contesto. Sulle card soltanto i motori che sanno scrivere codice, e «Automatico in Codex». Il default della board come bersaglio di una card in Automatico.
- **Spariscono le differenze accidentali.** Le larghezze 320, 170, 200 e 240 passate a `Menu` sono morte: il pannello interno è fisso a 22rem, quindi tutte e quattro le superfici sono larghe 352 px. Spariscono anche le intestazioni diverse, l'`autoIcon` ignorato e i provider «disabilitati» che però si cliccano.
- **La ricerca torna.** Il campo ha il fuoco all'apertura, solo su desktop, e cerca anche per azienda. I testi esistono già nel dizionario e oggi non li usa nessuno (`chat.picker.search`, `i18n-chat-it.ts:153-160`).
- **Ogni riga dice cosa guadagni e cosa spendi:** nome, una riga di descrizione, finestra di contesto, «via …» e l'eventuale data di ritiro. La finestra dei GPT passa da 400k e ≈1M a 272k quando Codex dichiara le finestre della sua cache: lo snapshot ha già il campo (`modelContextWindows`, `shared/types.ts:541`), è Codex che non lo riempie.
- **Ciò che non si può usare resta visibile e disabilitato,** con il motivo e un'azione («Apri impostazioni»).
- **Tastiera:** ⌘⇧M apre il selettore del composer attivo, le frecce attraversano tutta la lista, Invio sceglie, Esc chiude. **Telefono:** un foglio che sale dal basso, largo quanto lo schermo.
- **Le impostazioni della chat** scelgono provider e modello con lo stesso componente. Prendono il posto della `<Select>` col solo provider e i testi in inglese (`TopicSettingsModal.tsx:645-672`).
- **`/model` completa** con i modelli del motore attuale della chat.
- **Testi in italiano e inglese.**

Fuori:
- l'effort, che resta nel cursore della sessione (EFFORTUI-01, `openspec/specs/settings/spec.md:193`);
- preferiti e recenti;
- prezzi e velocità per modello: il catalogo non ha una fonte;
- il selettore dell'ospite (`Share/AgentStartControl.tsx`) e i sotto-agenti;
- cambiare `DEFAULT_AGENT_RUNTIME`;
- più account per provider;
- far sopravvivere il turno nativo a un riavvio, che serve un'altra change;
- qualsiasi migration: un valore mai scritto resta mai scritto, cambia solo come si legge.

ok / ok ma 2 no

| # | Dove cambiarla |
|---|----------------|
| 1 | `MSEL-06`; `AICTRL-01` (modificato); design §2.1-2.2 |
| 2 | `MSEL-06`, scenari «chat esistente su Claude Code, mai toccata» e «card mai toccata»; `TOPICS_ROUTING_DEFAULT`; design §2.3 |
| 3 | `MSEL-02`, `MSEL-05`; `AICTRL-02` e `MP-TASK-04` (modificati); design §3 |
| 4 | `MSEL-02`, `MSEL-03`; design §4 |
| 5 | `MSEL-07`; design §5 |

`mockup.html` mostra il selettore aperto su desktop e su un telefono da 390 px, in chiaro e in scuro, e accanto quello di oggi.

---

# Un selettore solo, tutte le aziende in una vista, «Esegui in Topics» acceso e spiegato

Richiesta di Attilio del 02/10 (testo esatto in `.openspec.yaml`).

## Why

### L'interruttore è spento perché nessuno lo ha acceso

Non è stata una decisione. Un valore mai scritto si legge «spento» per costruzione:
- `effectiveTopicsRouting` (`shared/task-coding-models.ts:193-196`);
- `if (topic?.topicsRouting)` (`server/providers/resolve-topic-provider.ts:40`);
- `!!topicsRouting` (`client/src/components/Chat/ProviderModelPicker.tsx:164`);
- il composer delle card parte da `null` (`Board/FloatingTaskComposer.tsx:145`).

La migration che ha creato le colonne dice «NULL… or to off otherwise… No backfill», per non riscrivere dati (AICTRL-04). Nessun commit sceglie «spento di default».

Non tutti i `null` sono rimasti `null`. Ogni card dispacciata scrive sul suo topic il valore effettivo: `resolveDispatchTopicIdentity` lo calcola (`dispatch-topic-identity.ts:34,49`), `createTopic` lo passa (`server.ts:1862,1870`) e `saveSingleTopic` scrive 0 per «spento» (`server/utils.ts:650`). Quindi le sessioni delle card dispacciate a interruttore spento dalla migration del 22/09 contengono uno 0 esplicito.

### Chi cambia strada se il `null` si legge acceso

A interruttore spento, una chat in Automatico va su `getDefaultProvider()` (`resolve-topic-provider.ts:58`). `recomputeDefault` sceglie il default in quest'ordine:
1. il default esplicito delle Impostazioni (`aiProvider`) o la variabile `AI_PROVIDER` (`server/providers/index.ts:184-188`, `app-settings.ts:284-285`);
2. il default di prima, se è ancora connesso (`index.ts:191-193`);
3. il motore nativo, se è connesso (runtime `topics`, `shared/types.ts:129`).

Su questo Mac `AI_PROVIDER` non è in `~/.topics-server-env` (misurato). Il valore di `aiProvider` sta nel DB vivo e non l'ho letto.

A interruttore acceso, il ramo di oggi salta del tutto il default: Automatico va sul motore (`resolve-topic-provider.ts:40-56`). Sulle card, l'Automatico manda al motore un bersaglio Claude Code scelto dal classificatore (`task-auto-model.ts:91,125`), e anche una card esplicita `claude-code:` ci va (`task-coding-models.ts:226`). Leggere il `null` come acceso con le regole di oggi sposterebbe quindi:
- le chat fissate su Claude Code o jcode;
- tutte le chat in Automatico, anche quelle con un default esplicito su Codex o sulle API;
- tutte le card Claude, comprese quelle in Automatico.

Questa change cambia due cose. Automatico prima risolve il bersaglio come a interruttore spento, poi decide la strada (design §2.1). E le card restano fuori dal nuovo default (scelta 2). Con queste due regole, cambiano strada solo:
- le chat fissate su Claude Code o jcode con un modello che il motore serve;
- le chat in Automatico il cui default è Claude Code o jcode.

### Perché un «acceso» rigido non si può mettere di default

Solo `claude-code` e `jcode` sono instradabili (`CLAUDE_CODING_PROVIDERS`, `task-coding-models.ts:7`), e solo con un modello che il motore serve.

Misurato su questo Mac: la CLI di Claude Code espone 11 modelli (`discoverClaudeModels`) e il motore ne dichiara 14 (`native/provider.ts:176-191`). In comune ce ne sono 9, alias di Haiku compreso. Restano fuori `claude-sonnet-4-6[1m]` (429 «Usage credits are required») e `claude-haiku-3-5` (404), come scritto in `provider.ts:171-177`.

Con un «acceso» rigido per tutti:
- le chat fissate su Codex, sulle API, su Gemini e su OpenClaw si bloccherebbero con un 409;
- ogni card `codex:` si parcheggerebbe quando nasce il suo topic (`dispatch-topic-identity.ts:39-42`);
- l'Automatico delle card perderebbe tutti i GPT (`task-auto-model.ts:90`);
- una card che riusa la sessione di un'altra card, con l'interruttore in posizione diversa, si parcheggerebbe (`task-coding-models.ts:266-279`, `task-dispatcher.ts:2975-2985`).

Da qui la scelta 1: acceso dove si può, diretto e dichiarato dove non si può.

### Cosa si guadagna e cosa si perde passando da Topics

- **Abbonamento, sì. Quota, non su questo Mac.** Il motore usa la credenziale OAuth di Claude Code (`native/auth.ts:112-140`), cioè lo stesso abbonamento. Ma le sessioni Claude Code passano dal proxy `127.0.0.1:3336`, che ruota 2 account su 429 e 401 (misurato: in ascolto, `autoSwitch: true`). Il motore invece va diretto su `api.anthropic.com` con un account solo (`agent-loop.ts:53`). È il motivo della riga «Compreso» sul proxy. Oggi lo pagano già le chat in Automatico che girano sul motore.
- **Memoria.** Per Claude Code si risparmia un processo Node a sessione: «~206 MB misurati» (`native/auth.ts:7-8`). Il commento di `acp/agents.ts:35` ne dice ~790; nessuno dei due è stato rimisurato qui. Per jcode non si risparmia niente: il suo costo è 0,58 MB a sessione (`acp/agents.ts:35-38`).
- **Classificatore.** A interruttore spento, il classificatore dell'Automatico lancia un `claude -p` per ogni card (`task-auto-model.ts:121-125`).
- **Riavvio, il contro.** Un turno nativo non sopravvive a un riavvio, e non serve misurarlo: lo dice il codice. `gracefulShutdown` chiama `stopAllProviders` (`server.ts:6698`, `:6771`). Lì `stop()` del motore annulla ogni turno vivo con causa `server-shutdown` (`native/provider.ts:288-301`). Al boot `riprendiTurniInterrotti` rimanda il turno (`server.ts:5713`), e così l'uso si paga di nuovo. Il turno non si riattacca (501, `chat.ts:977-1002`). Un turno di Claude Code in modalità broker, invece, sopravvive (`claude-code.ts:1640-1652`). Su questa macchina il server riceve un SIGTERM a ogni salvataggio sotto `server/` (`~/.topics-server-env:18`).

### La spiegazione non arriva

La riga dell'interruttore è una voce di menu come le altre, con l'icona `Route` attenuata (`AiExecutionMenuOptions.tsx:164-185`). L'unica spiegazione sta nel `title` (`:171`), che sul telefono non si vede e non dice cosa cambia per l'utente (`i18n-it.ts:36-38`).

### Per cambiare azienda servono 4 clic dentro un sottomenu

Il selettore condiviso ha due livelli: prima l'esecuzione, poi il modello (`AiExecutionMenuOptions.tsx:187-317`). Lo impone MP-TASK-04 (`openspec/changes/general-auto-model-ui/specs/multi-provider/spec.md`).

Si apre sul provider scelto (`:114`). Per passare da Opus a GPT servono 4 clic: chip, indietro, Codex, modello. Non c'è ricerca: è stata tolta in `d20667ff7` (12/09), e i suoi testi sono rimasti nel dizionario.

### Quattro chiamanti, quattro larghezze morte, più tre selettori fuori

Il componente è uno solo, ma ogni chiamante gli passa una larghezza sua:

| Superficie | Dove | `minWidth` passato | Differenze |
|---|---|---|---|
| Composer chat | `Chat/ProviderModelPicker.tsx:137-169` | 320 | finestra di contesto, Automatico = «Torna al default» |
| Composer card | `Board/FloatingTaskComposer.tsx:648-662` | 170 | solo motori di codice, «Automatico in X» |
| Cassetto card | `Board/TaskDetail.tsx:2301-2316` | 200 | bloccato a sessione assegnata |
| Default board | `Board/BoardSettingsPanel.tsx:131-148` | 240 | niente intestazione, interruttore = default board |

Le quattro larghezze non cambiano niente a schermo. Il pannello interno è fisso a `w-[min(22rem,calc(100vw-1rem))]` (`AiExecutionMenuOptions.tsx:192,281`), quindi tutte e quattro le superfici sono larghe 352 px.

Le differenze vere sono altre. `autoIcon` è ignorato (`TaskModelMenuOptions.tsx:79`). AICTRL-02 vuole i provider non pronti disabilitati, ma si cliccano (`AiExecutionMenuOptions.tsx:300-317`).

Restano fuori dal componente tre selettori:
- le impostazioni della chat, con una `<Select>` che sceglie il solo provider, con nomi grezzi e testi in inglese (`TopicSettingsModal.tsx:645-672`);
- `/model <id>`, a testo libero, che scrive solo `topic.model` (`ChatPane.tsx:1042` → `commandApi.setModel`);
- il modello di default per provider, in Impostazioni (`Settings/AIProvidersSection.tsx:510`).

### Il catalogo ha più di quel che mostra

Lo snapshot ha già un campo per le finestre dichiarate dal provider: `ProviderSnapshotEntry.modelContextWindows` (`shared/types.ts:541`). Lo riempie `snapshot-manager.ts:171-172` chiamando `contextWindows()` del provider, e il menu lo legge (`AiExecutionMenuOptions.tsx:85`). Inoltre `contextWindowFor(model, declared)` fa già vincere la finestra dichiarata sulla tabella (`shared/context-window.ts:168-174`). Oggi solo l'endpoint compatibile OpenAI dichiara qualcosa (`openai-compatible.ts:134`). Codex no.

La cache di Codex (`~/.codex/models_cache.json`, misurata) ha 10 modelli, 8 visibili. Per ciascuno dà:
- `display_name`, `description` e `priority`;
- `context_window` di 272000;
- `max_context_window` di 872000, tranne `gpt-5.5` che resta a 272000;
- i livelli di ragionamento;
- `upgrade`: GPT-5.5 «retires on October 14, 2026».

`readCodexModels` legge la descrizione (`codex/models.ts:22`), ma `listModels` passa solo gli slug (`codex.ts:1353-1362`).

Senza la finestra dichiarata vince la tabella, che sbaglia proprio i GPT (misurato con `contextWindowFor`):
- `gpt-5.5` e `gpt-5.6-sol` risultano 400k «noti»;
- `gpt-6.1-sol` e `gpt-6-astra` risultano ≈1M «stimati».

Il valore giusto da mostrare è `context_window`, 272k: è la finestra con cui Codex lavora di default. Il massimo di 872k è un'altra cosa.

## What changes

- `ModelSelector` sostituisce `AiExecutionMenuOptions`, `TaskModelMenuOptions` e la `<Select>` delle impostazioni della chat. Ha tre varianti (MSEL-01).
- Tutte le aziende in una vista, divise per azienda, con ricerca e niente sottomenu (MSEL-02, MSEL-03).
- Righe con descrizione, finestra, motore e ritiro. Codex dichiara le finestre (`contextWindows()`) e lo snapshot impara `modelInfo` per gli altri metadati (MSEL-04, MSEL-09).
- Una riga per modello, con il motore deciso da una regola sola e cambiabile dentro la riga (MSEL-05).
- «Esegui in Topics» acceso dove si può nelle chat, in una fascia in cima, segnato sul chip. Automatico segue il default. Il motore passa dal proxy degli account (MSEL-06, MSEL-07, MSEL-11).
- Tastiera e telefono (MSEL-08). `/model` e le impostazioni della chat sullo stesso catalogo (MSEL-10).

## Impact

- Client: `Shared/AiExecutionMenuOptions.tsx` diventa `Shared/ModelSelector/`. Si toccano anche:
  - `Board/TaskModelMenuOptions.tsx`, che viene rimosso;
  - `Chat/ProviderModelPicker.tsx`, `Chat/ChatInput.tsx`, `Chat/ChatPane.tsx`;
  - `Board/FloatingTaskComposer.tsx`, `Board/TaskDetail.tsx`, `Board/BoardSettingsPanel.tsx`;
  - `Modals/TopicSettingsModal.tsx`, `Settings/AIProvidersSection.tsx`;
  - `lib/topicsRoutingGate.ts` e i dizionari.
- Shared: `task-coding-models.ts`, per la lettura del default, la regola del motore e il riuso delle sessioni, e `types.ts`, per `modelInfo`.
- Server:
  - `providers/resolve-topic-provider.ts`;
  - `services/dispatch-topic-identity.ts`, `services/task-auto-model.ts`, `services/task-auto-plan.ts` (il giudice), `services/task-dispatcher.ts`;
  - `providers/codex.ts`, con `contextWindows()` e i metadati;
  - `providers/native/agent-loop.ts`, per l'indirizzo del proxy.
- Spec: nuova capability `model-selector`. Modificati AICTRL-01 e AICTRL-02 (change `ai-control-hierarchy-topics-switch`) e MP-TASK-04 e MP-TASK-07 (change `general-auto-model-ui`). Nessuna delle due è archiviata: vanno archiviate prima di questa.
- Nessuna migration, nessuna dipendenza nuova.
