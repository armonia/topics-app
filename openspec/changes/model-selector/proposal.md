## Da decidere

Selettore del modello e «Instrada via Topics»: 5 scelte prima del codice.

1. «Instrada via Topics» parte acceso e significa «quando si può»: i modelli Claude passano da Topics, mentre GPT, Gemini e le API vanno diretti e la riga del modello lo dice, senza mai bloccare l'invio. Perché: un «acceso» rigido come quello di oggi bloccherebbe ogni chat fissata su Codex (409, `server/routes/chat.ts:513-514`) e toglierebbe tutti i GPT dall'Automatico delle card (`server/services/task-auto-model.ts:90`). (o: acceso rigido come oggi, con l'invio bloccato e il banner rosso quando il modello scelto non passa da Topics)
2. Il nuovo default vale per tutte le chat e le card dove nessuno ha mai toccato l'interruttore, anche quelle che esistono già, e nel DB non si scrive niente. Perché: chi è in Automatico gira già sul motore di Topics (`DEFAULT_AGENT_RUNTIME = 'topics'`, `shared/types.ts:129`), quindi il cambio si vede solo sulle chat fissate su Claude Code o jcode. Il prezzo: da lì in poi un turno di quelle chat si perde se il server riparte mentre è in corso (`server/providers/native/provider.ts:14-22`). (o: solo le chat e le card nuove partono accese, le vecchie restano come sono)
3. Una riga per modello, divisa per azienda (Anthropic, OpenAI, Google, altri). Chi esegue il modello sta scritto sulla riga («via Topics», «via Codex»), e il motore si sceglie dentro la riga solo dove ce n'è più d'uno. Perché: con l'interruttore acceso Claude Code e jcode mandano lo stesso modello allo stesso motore (`shared/task-coding-models.ts:226`), quindi dividere per motore mostrerebbe due righe che fanno la stessa cosa; e la richiesta parla di aziende. (o: gruppi per motore come oggi, cioè Claude Code, Codex, jcode, Gemini, tutti aperti insieme, con i modelli Claude ripetuti sotto ogni motore che li offre)
4. Una lista sola che scorre: ricerca in cima, il nome dell'azienda resta fermo in alto mentre scorri, e si vedono solo i modelli correnti (la versione 1M sta dentro la sua riga, le generazioni vecchie sono raccolte in «Altri modelli»). Perché: sul catalogo misurato su questo Mac restano 4 righe Anthropic e 4 OpenAI, che entrano in un pannello largo 352 px e in un telefono da 390 px senza colonne. È la forma di Zed, T3 Code e Warp; T3 Code ha tolto i sottomenu per provider perché «cumbersome» (PR pingdotgg/t3code#2153). (o: su desktop una colonna per azienda affiancata, pannello di circa 700 px, e la lista solo sul telefono)
5. L'interruttore si chiama «Esegui in Topics» e sta in una fascia colorata in cima al selettore, con una riga sola: «Claude gira dentro Topics col tuo abbonamento, senza aprire Claude Code: stessa quota, meno memoria. GPT e Gemini restano diretti.» In più, il bottone del modello nel composer mostra un segno quando è acceso. Perché: oggi la spiegazione sta solo nel `title` (`client/src/components/Shared/AiExecutionMenuOptions.tsx:171`), che sul telefono non si vede, e dice «motore leggero» senza parlare di abbonamento o memoria (`client/src/lib/i18n-it.ts:37`). (o: tenere il nome «Instrada via Topics» e aggiungere solo la riga sotto)

Compreso, senza scelta:
- **Un componente solo, `ModelSelector`, con tre varianti dichiarate e motivate.** «Compatta» per il composer della chat, il composer delle card e il cassetto della card. «Intera» per le impostazioni: default della board, modello di default per provider, impostazioni della chat. «Chip» per la card della board, che si legge soltanto e apre la compatta.
- **Restano solo le differenze utili.** In chat la finestra di contesto; sulle card soltanto i motori che sanno scrivere codice; «Automatico in Codex» sulle card; il default della board come bersaglio di una card in Automatico.
- **Spariscono le differenze accidentali.** Larghezze 320, 170, 200 e 240; intestazioni diverse; `autoIcon` ignorato; provider «disabilitati» che però si cliccano.
- **La ricerca torna**, con il fuoco nel campo all'apertura (solo su desktop) e la ricerca anche per azienda. I testi esistono già nel dizionario e oggi non li usa nessuno (`chat.picker.search`, `i18n-chat-it.ts:153-160`).
- **Ogni riga dice cosa guadagni e cosa spendi:** nome, una riga di descrizione, finestra di contesto, «via …» e l'eventuale data di ritiro. Codex dà già descrizione, finestra (272k) e ritiro (GPT-5.5 si ritira il 14/10) nella sua cache, e oggi lo snapshot li butta. Il badge mostra 400k e ≈1M per i GPT perché legge la tabella invece della cache (misurato).
- **Ciò che non si può usare resta visibile e disabilitato,** con il motivo e un'azione («Apri impostazioni»).
- **Tastiera:** ⌘⇧M apre il selettore del composer attivo, le frecce attraversano tutta la lista, Invio sceglie, Esc chiude. **Telefono:** foglio dal basso a tutta larghezza.
- **Le impostazioni della chat** scelgono provider e modello con lo stesso componente, al posto della `<Select>` col solo provider e i testi in inglese (`TopicSettingsModal.tsx:645-672`).
- **`/model` completa** dallo stesso catalogo.
- **Testi in italiano e inglese.**

Fuori:
- l'effort, che resta nel cursore della sessione (EFFORTUI-01, `openspec/specs/settings/spec.md:193`);
- preferiti e recenti: la lista corrente sta in una schermata;
- prezzi e velocità per modello: nessuna fonte nel catalogo;
- il selettore dell'ospite (`Share/AgentStartControl.tsx`) e i sotto-agenti;
- cambiare `DEFAULT_AGENT_RUNTIME`;
- più account per provider;
- qualsiasi migration: un valore mai scritto resta mai scritto, cambia solo come si legge.

ok / ok ma 2 no

| # | Dove cambiarla |
|---|----------------|
| 1 | `MSEL-06`; `AICTRL-01` (modificato); design §2 |
| 2 | `MSEL-06`, scenario «chat esistenti»; design §2.3 |
| 3 | `MSEL-02`, `MSEL-05`; `AICTRL-02` e `MP-TASK-04` (modificati); design §3 |
| 4 | `MSEL-02`, `MSEL-03`; design §4 |
| 5 | `MSEL-07`; design §5 |

Il selettore aperto su desktop e su un telefono da 390 px, in chiaro e in scuro, con accanto il selettore di oggi: `mockup.html`.

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

Oggi l'interruttore conta poco in Automatico. Il runtime di default è `topics` (`shared/types.ts:129`) e `recomputeDefault` preferisce il motore nativo se è connesso (`server/providers/index.ts:181-238`), quindi una chat in Automatico va già sul motore anche a interruttore spento (`resolve-topic-provider.ts:58`). Acceso cambia due cose:
- un pin su Claude Code o jcode passa dal motore invece che dalla CLI;
- quando il bersaglio non è raggiungibile, l'invio si blocca invece di ripiegare (`resolve-topic-provider.ts:40-56`, `task-coding-models.ts:222-239`).

Il blocco oggi si vede come:
- un 409 (`server/routes/chat.ts:513-514`);
- un toast (`ChatPane.tsx:1430`);
- un bottone di invio disabilitato e un banner rosso (`ChatInput.tsx:426, 1532, 1766`);
- una card parcheggiata.

### Perché un «acceso» rigido non si può mettere di default

Solo `claude-code` e `jcode` sono instradabili (`CLAUDE_CODING_PROVIDERS`, `task-coding-models.ts:7`), e solo con un modello che il motore serve.

Misurato su questo Mac: la CLI di Claude Code espone 11 modelli (`discoverClaudeModels`). Il motore ne dichiara 14 (`native/provider.ts:179-194`). In comune ce ne sono 9 con l'alias di Haiku. Restano fuori `claude-sonnet-4-6[1m]` (429 «Usage credits are required») e `claude-haiku-3-5` (404), come scritto in `provider.ts:171-177`.

Con un «acceso» rigido per tutti:
- le chat fissate su Codex, sulle API, su Gemini e su OpenClaw si bloccherebbero;
- l'Automatico delle card perderebbe tutti i GPT (`task-auto-model.ts:90`);
- le card che riusano la sessione di un'altra card con l'interruttore in posizione diversa si parcheggerebbero (`task-coding-models.ts:266-279`, `task-dispatcher.ts:2978`).

Da qui la scelta 1: acceso dove si può, diretto e dichiarato dove non si può.

### Cosa si guadagna e cosa si perde passando da Topics

Le stesse 5 ore e 7 giorni, perché è lo stesso abbonamento OAuth di Claude Code (`native/auth.ts:1-30`).

Memoria: un processo `claude` o `codex` costa circa 790 MB per sessione. Lo dice il commento in `server/providers/acp/agents.ts` (misura del 15/08, non rifatta qui). Il motore nativo non apre processi.

Il classificatore dell'Automatico con l'interruttore spento lancia un `claude -p` per ogni card (`task-auto-model.ts:118-121`).

Il contro: un turno nativo muore se il server riparte (`native/provider.ts:14-22`) e non si riattacca (501, `chat.ts:977-1002`). Su questa macchina il server riparte a ogni salvataggio di `server/`. Se `gracefulShutdown` aspetti i turni nativi non l'ho verificato: nelle prime 30 righe (`server.ts:6698`) non lo fa.

### La spiegazione non arriva

La riga è una voce di menu come le altre, con l'icona `Route` attenuata (`AiExecutionMenuOptions.tsx:164-185`). L'unica spiegazione è nel `title` (`:171`): sul telefono non c'è, e non dice cosa cambia per l'utente (`i18n-it.ts:36-38`).

### Per cambiare azienda servono 3-4 clic dentro un sottomenu

Il selettore condiviso è a due livelli: prima l'esecuzione, poi il modello (`AiExecutionMenuOptions.tsx:187-317`). Lo impone MP-TASK-04 (`openspec/changes/general-auto-model-ui/specs/multi-provider/spec.md`).

Si apre sul provider scelto (`:114`). Per passare da Opus a GPT servono 4 clic: chip, indietro, Codex, modello. Non c'è ricerca: è stata tolta in `d20667ff7` (12/09) e i suoi testi sono rimasti nel dizionario.

### Quattro superfici, quattro larghezze, più tre selettori fuori

Il componente è uno solo, ma i chiamanti divergono senza motivo:

| Superficie | Dove | Larghezza | Differenze |
|---|---|---|---|
| Composer chat | `Chat/ProviderModelPicker.tsx:137-169` | 320 | finestra di contesto, Automatico = «Torna al default» |
| Composer card | `Board/FloatingTaskComposer.tsx:648-662` | 170 | solo motori di codice, «Automatico in X» |
| Cassetto card | `Board/TaskDetail.tsx:2301-2316` | 200 | bloccato a sessione assegnata |
| Default board | `Board/BoardSettingsPanel.tsx:131-148` | 240 | niente intestazione, interruttore = default board |

`autoIcon` è ignorato (`TaskModelMenuOptions.tsx:79`). AICTRL-02 vuole i provider non pronti disabilitati, ma si cliccano (`AiExecutionMenuOptions.tsx:300-317`).

Restano fuori dal componente tre selettori:
- le impostazioni della chat, con una `<Select>` che sceglie il solo provider, nomi grezzi e testi in inglese (`TopicSettingsModal.tsx:645-672`);
- `/model <id>`, a testo libero (`slashCommands.ts:53`);
- il modello di default per provider in Impostazioni (`Settings/AIProvidersSection.tsx:510`).

### Il catalogo ha più di quel che mostra

Lo snapshot porta per provider soltanto gli id (`ProviderSnapshotEntry.models: string[]`, `shared/types.ts:457-553`).

La cache di Codex (`~/.codex/models_cache.json`, misurata) ha 10 modelli, 8 visibili. Per ciascuno dà `display_name`, `description`, `priority`, `context_window` 272000, i livelli di ragionamento e `upgrade`: GPT-5.5 «retires on October 14, 2026». `readCodexModels` legge la descrizione (`codex/models.ts:22`), ma non arriva al client.

La finestra di contesto viene da una tabella che sbaglia proprio i GPT (misurato con `contextWindowFor`):
- `gpt-5.5` e `gpt-5.6-sol` risultano 400k «noti»;
- `gpt-6.1-sol` e `gpt-6-astra` risultano ≈1M «stimati»;
- la cache dice 272k per tutti.

## What changes

- `ModelSelector` sostituisce `AiExecutionMenuOptions`, `TaskModelMenuOptions` e la `<Select>` delle impostazioni della chat. Ha tre varianti (MSEL-01).
- Una vista con tutte le aziende, divise per azienda, con ricerca e niente sottomenu (MSEL-02, MSEL-03).
- Righe con descrizione, finestra, motore e ritiro. Lo snapshot impara `modelInfo` per modello (MSEL-04, MSEL-09).
- Una riga per modello, con il motore deciso da una regola sola e cambiabile nella riga (MSEL-05).
- «Esegui in Topics» acceso dove si può, in una fascia in cima, segnato sul chip (MSEL-06, MSEL-07).
- Tastiera e telefono (MSEL-08). `/model` e le impostazioni della chat sullo stesso catalogo (MSEL-10).

## Impact

- Client: `Shared/AiExecutionMenuOptions.tsx` diventa `Shared/ModelSelector/`. Si toccano anche `Board/TaskModelMenuOptions.tsx` (rimosso), `Chat/ProviderModelPicker.tsx`, `Board/FloatingTaskComposer.tsx`, `Board/TaskDetail.tsx`, `Board/BoardSettingsPanel.tsx`, `Modals/TopicSettingsModal.tsx`, `Settings/AIProvidersSection.tsx`, `lib/topicsRoutingGate.ts`, i dizionari.
- Shared: `task-coding-models.ts` (lettura del default, regola del motore), `types.ts` (`modelInfo`), `context-window.ts` (finestra dichiarata prima della tabella).
- Server: `providers/resolve-topic-provider.ts`, `services/task-auto-model.ts`, `services/task-dispatcher.ts` (stessa lettura), `providers/codex.ts` e `snapshot-manager.ts` (metadati).
- Spec: nuova capability `model-selector`. Modificati AICTRL-01 e AICTRL-02 (change `ai-control-hierarchy-topics-switch`) e MP-TASK-04 e MP-TASK-07 (change `general-auto-model-ui`). Nessuna delle due è archiviata: vanno archiviate prima di questa.
- Nessuna migration, nessuna dipendenza nuova.
