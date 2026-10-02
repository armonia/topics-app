# Design: model-selector

Le scelte che cambiano cosa vedi stanno nel blocco «Da decidere» di
`proposal.md`. Qui ci sono quelle tecniche e il perché delle alternative
scartate. Ogni sezione segue la scelta consigliata; dove l'alternativa cambia il
lavoro, lo dice.

## 1. Un componente, tre varianti

### 1.1 Cosa c'è oggi

`AiExecutionMenuOptions` è già l'unico corpo del menu, ma ogni chiamante gli
mette attorno un `Menu` con la sua larghezza, la sua intestazione e il suo
adattatore:

| Chiamante | Larghezza | Adattatore |
|---|---|---|
| `ProviderModelPicker.tsx:142` | 320 | nessuno |
| `FloatingTaskComposer.tsx:648` | 170 | `TaskModelMenuOptions` |
| `TaskDetail.tsx:2301` | 200 | `TaskModelMenuOptions` |
| `BoardSettingsPanel.tsx:131` | 240 | `TaskModelMenuOptions` |

Fuori da tutto questo restano la `<Select>` di `TopicSettingsModal.tsx:654` e
`/model`.

### 1.2 Cosa diventa

`client/src/components/Shared/ModelSelector/` contiene:

- `ModelSelector.tsx`: il trigger e il pannello. Il `Menu` lo possiede lui,
  così larghezza, posizione e foglio da telefono non si decidono più nel
  chiamante.
- `ModelList.tsx`: fascia, ricerca, Automatico e sezioni. È il corpo comune.
- `useModelCatalog.ts`: dallo snapshot ricava le righe (modello, azienda,
  motori, metadati). È logica pura, testata con `bun:test`.
- `modelMaker.ts` (in `shared/`): da un id ricava l'azienda.

```ts
type ModelSelectorProps = {
  scope: 'chat' | 'task';                 // quale catalogo: tutti i provider, o solo motori di codice
  variant: 'compact' | 'full' | 'chip';
  value: AiExecutionSelection;            // invariato: { provider, model }, null = Automatico
  routingTarget?: AiExecutionSelection;   // invariato: cosa giudica la fascia
  onSelect: (s: AiExecutionSelection) => void;
  automatic: { label: string; hint: string; withinEngine?: boolean };
  topicsRouting?: { stored: boolean | null; onToggle: (next: boolean) => void };
  disabled?: boolean;
};
```

Il valore salvato non cambia: resta `provider:model` per le card e
`{provider, model}` per le chat. AICTRL-04 e MP-TASK-06 restano veri senza
toccare i dati.

### 1.3 Le varianti e perché esistono

| Variante | Dove | Forma | Perché diversa |
|---|---|---|---|
| `compact` | composer chat, composer card, cassetto card | trigger a chip, pannello ancorato largo 22rem (352 px), foglio dal basso sotto 768 px | si sceglie mentre si scrive: conta arrivarci in un gesto |
| `full` | default della board, impostazioni della chat, modello di default per provider in Impostazioni | trigger largo come un campo; il pannello è lo stesso, ma ogni riga mostra per intero anche la descrizione | si sceglie una volta per tante chat: c'è spazio e conviene leggere |
| `chip` | card della board, intestazione del cassetto | etichetta «Opus 5.5 · via Topics», di sola lettura; il clic apre la `compact` se la sessione non è assegnata | sulla card si legge e basta (MP-TASK-03) |

Le differenze di `scope` sono utili e restano:
- `chat`: tutti i provider dello snapshot, con la finestra di contesto
  (EFFORTUI-01 la vuole leggibile nel momento della scelta);
- `task`: solo i motori con `coding-tasks` (`taskExecutionOptions`,
  `task-coding-models.ts:82`), con «Automatico in Codex» (`withinEngine`)
  tranne jcode, e la fascia giudica il default della board quando la card è in
  Automatico.

Le differenze accidentali spariscono: larghezze, intestazioni, `autoIcon`
ignorato, provider «disabilitati» ma cliccabili.

## 2. «Esegui in Topics»: acceso dove si può

### 2.1 Una funzione decide la strada

```ts
// shared/task-coding-models.ts
export type TopicsRoute =
  | { via: 'topics' }
  | { via: 'direct'; reason: 'off' | 'family' | 'model' | 'engine-down' }
  | { via: 'pending' };                 // catalogo del motore in scoperta: solo le card aspettano

export function topicsRoute(
  stored: boolean | null | undefined,   // la colonna: null = mai toccata
  target: { provider: string | null; model: string | null },
  snapshot: ProvidersSnapshot | null,
): TopicsRoute
```

- **Preferenza**: `stored ?? true`. Il default acceso sta qui e solo qui.
  Il prefisso legacy `topics:<model>` resta acceso come oggi (AICTRL-04).
- **Preferenza spenta**: `direct/off`.
- **Automatico** (`provider` nullo): `topics` se il motore è `ready`,
  `pending` se è `loading`, altrimenti `direct/engine-down`.
- **Provider esplicito fuori dalla famiglia** (Codex, `claude` API, `openai`,
  ACP non jcode, OpenClaw, endpoint): `direct/family`.
- **Modello che il motore non serve** (`isTopicsModelServed`): `direct/model`.
- **Motore assente o non connesso**: `direct/engine-down`, oppure `pending`
  se è in scoperta.
- Altrimenti `topics`.

`topicsRoutingAvailable`, `effectiveTopicsRouting`, `resolveTopicProvider`,
`taskProviderForModel`, `topicsRoutingBlocked` e `reusedSessionRouteConflict`
leggono tutti questa funzione. Oggi ognuno ha il suo `!!`, `?? false` o `if`.
Il test che lo garantisce elenca i chiamanti (tasks 1.2).

### 2.2 Cosa cambia per chi la chiama

- **Chat** (`resolve-topic-provider.ts`):
  - `topics` restituisce il motore nativo;
  - `direct` passa al ramo di oggi «interruttore spento»;
  - `TopicsRoutingIncompatibleError` resta solo per `provider: 'topics'`
    legacy con il motore giù, perché lì non c'è nessun «diretto» verso cui
    andare. Il 409, il banner rosso e il bottone di invio disabilitato
    (`ChatInput.tsx:426, 1532, 1766`) spariscono con
    `chat.topicsRouting.blocked`.
- **Card** (`taskProviderForModel`): `topics` restituisce `'topics'`, `direct`
  il provider come oggi a interruttore spento, `pending` lancia
  `TaskProviderPendingError('topics')`. Non c'è più `TopicsRoutingUnavailableError`
  per famiglia o modello.
- **Automatico delle card** (`task-auto-model.ts:90`): la scheda non filtra più
  per instradabilità, così i GPT restano candidati. Dopo la scelta, la strada
  del modello scelto passa da `topicsRoute`. Il classificatore gira sul motore
  quando la preferenza è accesa e il motore è `ready`, come oggi con
  l'interruttore acceso (`:118-121`).
- **Il turno dice da dove è passato.** L'etichetta del modello sul turno (già
  conservata, MP-TASK-05) prende «via Topics» o «via Codex». Questo è ciò che
  impedisce il no-op silenzioso che AICTRL-01 vieta: ora non si blocca, ma si
  dichiara sempre.

### 2.3 Dati esistenti e sessioni riusate (scelta 2)

Una colonna `null` si legge accesa. Il DB non cambia (AICTRL-04).

- **Chat fissata su Claude Code o jcode, mai toccata.** Dal turno successivo
  va sul motore. La storia arriva dal chiamante (`native/provider.ts:11-16`),
  quindi la conversazione continua. Si perde la sopravvivenza al riavvio:
  questo è il prezzo detto nella scelta 2. Un turno già in volo non cambia
  strada (AICTRL-04, scenario del turno in volo).
- **Card che riusa una sessione.** `reusedSessionRouteConflict` confronta la
  strada effettiva delle due parti, calcolata da `topicsRoute` con la stessa
  lettura del `null`, non più `!!session.topicsRouting`. Senza questo, una
  sessione `null` di ieri (letta spenta) e una card `null` di oggi (letta
  accesa) si parcheggerebbero a vicenda (`task-dispatcher.ts:2978`). C'è un
  test apposta (tasks 1.3).

**Con l'alternativa** (solo le nuove): `topicsRoute` tiene `stored ?? false`,
e alla creazione di chat e card si scrive `true` (`createTopic`,
`task-dispatcher.ts:122`; `FloatingTaskComposer.tsx:145` parte da `true`). Il
resto è uguale.

### 2.4 Alternativa scartata nel design: acceso rigido per tutti

Basterebbe `stored ?? true` dentro le funzioni di oggi. Si bloccherebbero le
chat fissate su Codex, sulle API, su Gemini e su OpenClaw, l'Automatico delle
card perderebbe i GPT (`task-auto-model.ts:90`), e il primo messaggio
dopo l'aggiornamento sarebbe un banner rosso. È la scelta 1 «o:»: se viene
scelta, §2.2 non si fa e la fascia mostra il blocco invece di «diretto».

## 3. Una riga per modello, divisa per azienda (scelta 3)

### 3.1 L'azienda

`modelMaker(id)` guarda il prefisso dell'id, dopo aver tolto un eventuale
`provider:`:

| Prefisso | Azienda |
|---|---|
| `claude-` | Anthropic |
| `gpt-`, `o<n>`, `codex` | OpenAI |
| `gemini-` | Google |
| altro | il nome del provider che lo offre (OpenClaw, l'endpoint), in «Altri» |

È una tabella di prefissi, non un catalogo di modelli. Un modello nuovo della
stessa azienda non chiede di toccarla.

### 3.2 Il motore di una riga

`engines(model)` sono i provider pronti, nello `scope`, che hanno il modello
nel loro elenco (alias compresi, `nativeModelId`). `topics` resta escluso
(AICTRL-01). Il motore della riga si sceglie in quest'ordine:

1. quello che il valore salvato nomina già: la scelta non salta da sola;
2. `snapshot.defaultProvider`, se è tra questi;
3. l'ordine di `PROVIDER_PREFERENCE_ORDER` (`server/providers/index.ts:50`),
   cioè prima l'abbonamento e poi le API a consumo (CHAT-DEF-02). Lo snapshot
   lo espone già nell'ordine delle voci (tasks 2.3).

La riga dice la strada con `topicsRoute`: «via Topics», oppure «via Claude
Code», «via Codex», «via API». Se `engines` ha più di un motore, la colonna
«via» è un piccolo bottone. Il clic apre **dentro la riga**, non in un
sottomenu, un segmento con i motori; con la tastiera è `→` sulla riga.

### 3.3 Cosa resta fuori dalla riga

L'effort resta nel cursore della sessione (EFFORTUI-01). La variante 1M non è
un'altra riga (§4.3).

**Con l'alternativa** (per motore): `engines` non serve, le sezioni sono i
provider dello snapshot e i modelli si ripetono. Resta tutto il resto di §4.

## 4. Impaginazione (scelta 4)

### 4.1 Anatomia, dall'alto

1. **Fascia «Esegui in Topics»** (§5). Nella `compact` c'è sempre; nella
   `full` delle impostazioni della board scrive il default della board.
2. **Ricerca**, alta 32 px, segnaposto «Cerca modello o azienda». Su desktop
   ha il fuoco all'apertura; sul telefono no, perché la tastiera coprirebbe il
   foglio.
3. **Automatico**, con una riga di spiegazione: «Topics sceglie il modello per
   ogni richiesta tra quelli pronti». Sulle card resta «Automatico in Codex»
   dentro la sezione OpenAI.
4. **Sezioni per azienda**, con l'intestazione `position: sticky` (11 px,
   maiuscoletto, il pallino di stato del motore principale). Ordine: l'azienda
   del valore salvato, poi Anthropic, OpenAI, Google, Altri. Una sezione senza
   righe dopo la ricerca sparisce.
5. **«Altri modelli (n)»** in fondo a ogni sezione: una riga che apre sul
   posto le generazioni vecchie. La ricerca le include sempre.

### 4.2 Misure

| | Desktop | Telefono (< 768 px) |
|---|---|---|
| Contenitore | `Menu` ancorato, `w-[min(22rem,calc(100vw-1rem))]` | foglio dal basso di `Menu` (`Menu.tsx:197-265`), larghezza piena |
| Altezza massima | `calc(100dvh - 3rem)` come oggi (`Menu.tsx:249`) | 85dvh, `overscroll-behavior: contain` |
| Riga | 28 px (`POPOVER_ITEM`) | 44 px (`coarse:py-3`) |
| Colonne della riga | nome · finestra · via · spunta | nome · via · spunta; la finestra va sotto il nome |

Stima sul catalogo di questo Mac, non misurata a schermo: fascia 56 + ricerca
40 + Automatico 36 + 2 intestazioni da 24 + 8 righe da 28 + 2 «Altri» da 28,
cioè circa 460 px. Gemini e OpenClaw aggiungono una sezione ciascuno, con
elenco non misurato (serve lo snapshot vivo, :3333 vietata).

### 4.3 Correnti e «Altri modelli»

- **Anthropic.** È corrente il più nuovo di ogni famiglia: `newestOfFamily`
  (`server/providers/claude-models.ts:77`), già usato per il default. Sul
  catalogo misurato restano Opus 5.5, Sonnet 5.5, Haiku 4.5 e Fable 5.1;
  Opus 4.8, Sonnet 4.6 e Haiku 3.5 vanno in «Altri».
- **OpenAI** (Codex). È corrente la generazione del primo modello per
  `priority` della cache: 6.1-Sol, 6-Astra, 6-Sol, 6-Luna. 5.6-Sol, 5.6-Terra,
  5.6-Luna e 5.5 vanno in «Altri», e 5.5 porta «si ritira il 14/10».
- **Senza ordine noto** (ACP, endpoint): tutti correnti.
- **1M.** `claude-x[1m]` e `claude-x` diventano una riga sola con un
  interruttore «1M» a destra del nome, se la variante esiste. La finestra
  mostrata segue l'interruttore. Il valore salvato resta l'id vero. Righe
  Anthropic da 11 a 7, prima di piegare.

### 4.4 Ricerca

È un confronto per sottostringa, senza distinguere maiuscole e accenti, su:
etichetta, id, azienda, nome del motore e descrizione. Più parole vanno tutte
trovate. Niente libreria fuzzy (MP-TASK-07, nessuna dipendenza). Con meno di
40 righe la lista non si virtualizza (HERO: la virtualizzazione non risolve un
problema che qui non c'è).

**Con l'alternativa** (colonne): sopra i 720 px di viewport il pannello è largo
`min(44rem, 100vw - 2rem)` e ogni azienda è una colonna; sotto, si torna a
§4.1. Sono due impaginazioni da mantenere e testare.

## 5. La fascia «Esegui in Topics» (scelta 5)

### 5.1 Testi

| Chiave | it | en |
|---|---|---|
| `ai.selector.routing` | Esegui in Topics | Run in Topics |
| `ai.selector.routingLine` | Claude gira dentro Topics col tuo abbonamento, senza aprire Claude Code: stessa quota, meno memoria. GPT e Gemini restano diretti. | Claude runs inside Topics on your subscription, without starting Claude Code: same quota, less memory. GPT and Gemini stay direct. |
| `ai.selector.route.topics` | via Topics | via Topics |
| `ai.selector.route.direct.family` | Questo modello va diretto: {engine} non passa da Topics. | This model runs direct: {engine} does not go through Topics. |
| `ai.selector.route.direct.model` | Questo modello va diretto: Topics non lo serve ancora. | This model runs direct: Topics does not serve it yet. |
| `ai.selector.route.direct.engineDown` | Il motore di Topics non è connesso: per ora va diretto. | The Topics engine is not connected: running direct for now. |

`ai.selector.routingHint`, `routingUnavailable` e `chat.topicsRouting.blocked`
escono dai dizionari.

### 5.2 Stati della fascia

| Stato | Sfondo | Testo sotto il titolo |
|---|---|---|
| acceso, il modello scelto passa | `--primary-light`, bordo sinistro 2 px `--primary` | `routingLine` |
| acceso, il modello scelto va diretto | `--bg-inset` | `route.direct.*` in ambra (`--color-accent-warning`) |
| spento | `--bg-inset` | `routingLine` in `--text-muted` |

L'interruttore è un vero `role="switch"`, largo 28 px, che si clicca su tutta la
fascia. Non è mai disabilitato: spegnere e accendere vale sempre, perché nessuno
dei due stati blocca.

### 5.3 Il segno sul chip

Quando la strada del valore attuale è `topics`, il chip del composer mostra
l'icona `Route` (12 px, `--primary`) prima del nome del modello, con il
`title` «via Topics». Quando è diretto, non c'è niente. Sulla `chip` della
board, «· via Topics» fa parte del testo.

## 6. I metadati del catalogo

`ProviderSnapshotEntry` impara un campo opzionale:

```ts
modelInfo?: Record<string, {
  label?: string;          // display_name della cache Codex
  description?: string;    // una riga, già tagliata a 400 caratteri in codex/models.ts:22
  contextWindow?: number;  // dichiarata: batte la tabella di shared/context-window.ts
  retiresAt?: string;      // ISO, da `upgrade.retirement_at`
  replacement?: string;    // `upgrade.model`
  generation?: 'current' | 'older';
}>;
```

- **Codex**: tutto dalla cache (`readCodexModels`, già letta). Oggi
  `codex.ts:1353-1362` la riduce agli slug.
- **Claude Code**: soltanto `generation` (da `newestOfFamily`). Niente
  descrizioni scritte a mano: il catalogo a mano di `CommandMenu` è stato
  tolto apposta (`Shared/CommandMenu.tsx:12-24`).
- **ACP ed endpoint**: le finestre che già dichiarano (`modelContextWindows`)
  confluiscono qui.

`contextWindowFor(model, declared)` riceve `modelInfo[model].contextWindow`.
Così i GPT passano da 400k e ≈1M a 272k (misurato sulla cache).

## 7. Tastiera e telefono

- ⌘⇧M (libero in `shared/shortcuts.ts`, misurato) apre il selettore del
  composer che ha il fuoco. Lo stesso tasto lo richiude. La scorciatoia è
  registrata nel catalogo delle scorciatoie, quindi resta rimappabile.
- Il fuoco parte dalla ricerca. `↓` entra nella lista e le frecce attraversano
  fascia, Automatico, righe e «Altri» senza fermarsi alle intestazioni
  (`useMenuKeyboard`, che salta i non navigabili). Invio sceglie e chiude. `→`
  su una riga con più motori apre il segmento «via», `←` lo chiude. Spazio
  sulla fascia commuta. Esc chiude e il fuoco torna al trigger (MP-TASK-07).
- Lettore di schermo: `role="listbox"`, intestazioni `role="presentation"`
  con `aria-label` sul gruppo (`role="group"`), riga `role="option"` con
  `aria-describedby` sulla descrizione.
- Telefono: il foglio di `Menu` con la maniglia; righe da 44 px; la ricerca
  resta in cima e non scorre con la lista.

## 8. Rischi

- **Il turno nativo e il riavvio.** Con la scelta 2 consigliata, le chat
  fissate su Claude Code passano a una strada che non sopravvive al riavvio.
  Va misurato prima del codice se `gracefulShutdown` aspetta i turni nativi
  (tasks 1.5). Se non li aspetta, il rimedio sta in un'altra change: questa
  dichiara il prezzo, non lo nasconde.
- **Due change non archiviate.** AICTRL e MP-TASK-04/07 vivono in
  `ai-control-hierarchy-topics-switch` e `general-auto-model-ui`. Il delta qui
  le MODIFICA, quindi l'archiviazione va fatta in quest'ordine: quelle due,
  poi questa.
- **Test che fissano il vecchio comportamento.** Gli E2E e gli unit sul
  blocco a interruttore acceso (`topicsRoutingGate.test.ts` e gli spec che
  cercano `ai-selector-topics-routing` disabilitato) vanno riscritti sul nuovo
  contratto, non cancellati. L'elenco è in tasks 1.6.
