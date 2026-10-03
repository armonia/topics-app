# Design: model-selector

Le scelte che cambiano cosa vedi stanno nel blocco «Da decidere» di
`proposal.md`. Qui ci sono quelle tecniche e il perché delle alternative
scartate. Ogni sezione segue la scelta consigliata; dove l'alternativa cambia il
lavoro, lo dice.

## 1. Un componente, tre varianti

### 1.1 Cosa c'è oggi

`AiExecutionMenuOptions` è già l'unico corpo del menu, ma ogni chiamante gli
mette attorno un `Menu` con il suo `minWidth`, la sua intestazione e il suo
adattatore:

| Chiamante | `minWidth` passato | Adattatore |
|---|---|---|
| `ProviderModelPicker.tsx:142` | 320 | nessuno |
| `FloatingTaskComposer.tsx:648` | 170 | `TaskModelMenuOptions` |
| `TaskDetail.tsx:2301` | 200 | `TaskModelMenuOptions` |
| `BoardSettingsPanel.tsx:131` | 240 | `TaskModelMenuOptions` |

I quattro `minWidth` non hanno effetto. Il pannello interno è fisso a
`w-[min(22rem,calc(100vw-1rem))]` (`AiExecutionMenuOptions.tsx:192,281`),
quindi tutte e quattro le superfici sono larghe 352 px.

Fuori da tutto questo restano la `<Select>` di `TopicSettingsModal.tsx:654` e
`/model`.

### 1.2 Cosa diventa

`client/src/components/Shared/ModelSelector/` contiene:

- `ModelSelector.tsx`: il trigger e il pannello. Il `Menu` lo possiede lui,
  così larghezza, altezza, posizione e foglio da telefono non si decidono più
  nel chiamante.
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
| `compact` | composer chat, composer card, cassetto card | trigger a chip, pannello ancorato largo 22rem (352 px, come oggi), foglio dal basso sotto 768 px | si sceglie mentre si scrive: conta arrivarci in un gesto |
| `full` | default della board, impostazioni della chat, modello di default per provider in Impostazioni | trigger largo come un campo; il pannello è lo stesso, ma ogni riga mostra per intero anche la descrizione | si sceglie una volta per tante chat: c'è spazio e conviene leggere |
| `chip` | card della board, intestazione del cassetto | etichetta «Opus 5.5 · via Topics», di sola lettura; il clic apre la `compact` se la sessione non è assegnata | sulla card si legge e basta (MP-TASK-03) |

Le differenze di `scope` sono utili e restano:
- `chat`: tutti i provider dello snapshot, con la finestra di contesto
  (EFFORTUI-01 la vuole leggibile nel momento della scelta);
- `task`: solo i motori con `coding-tasks` (`taskExecutionOptions`,
  `task-coding-models.ts:82`), con «Automatico in Codex» (`withinEngine`)
  tranne jcode. Quando la card è in Automatico, la fascia giudica il default
  della board.

Le differenze accidentali spariscono: i `minWidth` morti, le intestazioni,
l'`autoIcon` ignorato, i provider «disabilitati» ma cliccabili.

## 2. «Esegui in Topics»: acceso dove si può

### 2.1 Una funzione decide la strada

```ts
// shared/task-coding-models.ts
export const TOPICS_ROUTING_DEFAULT = { chat: true, task: false } as const; // scelta 2: qui e solo qui

export type TopicsRoute =
  | { via: 'topics' }
  | { via: 'direct'; reason: 'off' | 'family' | 'model' | 'engine-down' }
  | { via: 'pending' };                 // catalogo del motore in scoperta: solo le card aspettano

export function topicsRoute(
  stored: boolean | null | undefined,   // la colonna: null = mai toccata
  target: { provider: string | null; model: string | null }, // già risolto: vedi sotto
  snapshot: ProvidersSnapshot | null,
  scope: 'chat' | 'task',
): TopicsRoute
```

La regola, in ordine:

1. **Preferenza.** Vale `stored ?? TOPICS_ROUTING_DEFAULT[scope]`. Il
   prefisso legacy `topics:<model>` resta acceso come oggi (AICTRL-04).
2. **Preferenza spenta.** La strada è `direct/off`.
3. **Il bersaglio si risolve prima della strada,** come a interruttore spento:
   - in chat, Automatico diventa `getDefaultProvider()`;
   - su una card, Automatico diventa il modello che sceglie il classificatore,
     oppure Codex se il default dello snapshot è Codex (`task-coding-models.ts:240`).

   Oggi Automatico più acceso salta il default e va sul motore
   (`resolve-topic-provider.ts:40-56`, `task-coding-models.ts:232-239`). Così
   un default esplicito su Codex o sulle API (`providers/index.ts:184-188`)
   resta dov'è. Il prezzo: chi oggi ha acceso a mano l'interruttore, sta in
   Automatico e ha il default su Codex, torna su Codex diretto. La fascia lo
   dice.
4. **Provider fuori dalla famiglia Claude** (Codex, l'API `claude`, `openai`,
   gli ACP che non sono jcode, OpenClaw, gli endpoint): `direct/family`.
5. **Modello che il motore non serve** (`isTopicsModelServed`): `direct/model`.
6. **Motore assente o non connesso:** `direct/engine-down`, oppure `pending` se
   è in scoperta.
7. Altrimenti `topics`.

**Chi legge la preferenza.** L'elenco è chiuso. L'ha prodotto
`git grep -nE "topicsRouting" -- server shared client/src server.ts ':!*.test.*'`
il 02/10: 33 file. Ogni riga è o un lettore, o un passaggio che copia il valore
senza interpretarlo.

I lettori. Tutti passano da `topicsRoute`, nessuno tiene il suo `!!`,
`?? false` o `if`:

| Lettore | Dove | Cosa cambia |
|---|---|---|
| `effectiveTopicsRouting` | `shared/task-coding-models.ts:193-196` | il `null` legge `TOPICS_ROUTING_DEFAULT[scope]` |
| `topicsRoutingAvailable` | `task-coding-models.ts:178` | diventa `topicsRoute(...).via === 'topics'` |
| `taskProviderForModel` | `task-coding-models.ts:222-239` | niente `TopicsRoutingUnavailableError`; Automatico risolve prima il bersaglio |
| `reusedSessionRouteConflict`, `taskModelMatchesSession` | `task-coding-models.ts:266-292` | regola del riuso, §2.3 |
| `resolveTopicProvider` | `server/providers/resolve-topic-provider.ts:40-58` | `direct` va sul ramo di oggi «spento», scope `chat` |
| `resolveDispatchTopicIdentity` | `server/services/dispatch-topic-identity.ts:34-51` | **esce il cancello duro di `:39-42`**, che oggi parcheggerebbe ogni card `codex:` con la preferenza accesa; `executor` è `topics` solo se la strada è `topics` |
| `dispatchTopicBinding` | `dispatch-topic-identity.ts:61-70` | il provider di un topic in Automatico è quello di `topicsRoute`, non `topicsRouting ? 'topics' : default` |
| `pickAutomaticTaskModel` | `server/services/task-auto-model.ts:90-91,125` | §2.2 |
| dispatcher | `server/services/task-dispatcher.ts:1621-1627`, `:5405-5408` | conserva il `null` fino al riuso (§2.3), poi `topicsRoute` con scope `task` |
| cancello d'invio e interruttori della board | `client/src/lib/topicsRoutingGate.ts:7-70` | `topicsRoutingBlocked` resta solo per il legacy `provider: 'topics'` con il motore giù |
| picker della chat | `client/src/components/Chat/ProviderModelPicker.tsx:164` | `!!topicsRouting` diventa `topicsRoute(..., 'chat')` |

I passaggi copiano il valore com'è, `null` compreso, e non cambiano:
- `topic-provider-resolver.ts:26`, che chiama `resolveTopicProvider`;
- `session-control-core.ts:227`;
- `routes/fork.ts:107`, cioè `parent.topicsRouting ?? null`;
- `utils.ts:650`, `tasks.ts:3653,3955`, `routes/topics.ts:1718-1724`,
  `routes/tasks-board.ts:383`, `routes/task-patch.ts:127`.

Una fork di una chat `null` resta `null`, e quindi accesa come la madre.

### 2.2 Cosa cambia per chi la chiama

- **Chat** (`resolve-topic-provider.ts`):
  - `topics` restituisce il motore nativo;
  - `direct` passa al ramo di oggi «interruttore spento»;
  - `TopicsRoutingIncompatibleError` resta solo per il legacy
    `provider: 'topics'` con il motore giù, perché lì non c'è nessun «diretto»
    verso cui andare. Il 409, il banner rosso e il bottone di invio disabilitato
    (`ChatInput.tsx:426, 1532, 1766`) spariscono, insieme a
    `chat.topicsRouting.blocked`.
- **Card** (`taskProviderForModel`, `resolveDispatchTopicIdentity`): `topics`
  restituisce `'topics'`, `direct` restituisce il provider come oggi a
  interruttore spento, `pending` lancia `TaskProviderPendingError('topics')`.
  `TopicsRoutingUnavailableError` non esiste più per famiglia o modello.
- **Automatico delle card** (`task-auto-model.ts:90`). La scheda non filtra
  più per instradabilità, così i GPT restano candidati. Dopo la scelta, la
  strada del modello scelto passa da `topicsRoute`.
- **Il giudice del classificatore** (`task-auto-plan.ts:35`). Oggi è il primo
  modello «affordable» nell'ordine della scheda. Con i GPT di nuovo nella
  scheda può essere `gpt-6-luna` («Fast and affordable», misurato sulla
  cache), cioè un `codex exec` per ogni card. Quindi: con la preferenza accesa
  e il motore `ready`, il giudice si sceglie solo tra i modelli che il motore
  serve, e gira sul motore come oggi (`task-auto-model.ts:121-125`). Altrimenti
  resta come oggi.
- **Il turno dice da dove è passato.** L'etichetta del modello sul turno (già
  conservata, MP-TASK-05) prende «via Topics» o «via Codex». È questo che evita
  il no-op silenzioso vietato da AICTRL-01: il turno non si blocca più, ma la
  strada si dichiara sempre.

### 2.3 Dati esistenti e sessioni riusate (scelta 2)

Il DB non cambia (AICTRL-04). Cosa contiene oggi:
- **Chat**: `null`, salvo chi ha toccato l'interruttore.
- **Topic delle card dispacciate dopo il 22/09**: un booleano esplicito.
  `resolveDispatchTopicIdentity` scrive il valore effettivo
  (`dispatch-topic-identity.ts:34,49` → `server.ts:1862,1870` →
  `utils.ts:650`), cioè 0 per ogni card dispacciata a interruttore spento.
- **Topic delle card dispacciate prima del 22/09**: `null`, perché la colonna è
  nata senza backfill.

Le regole:

- **Chat fissata su Claude Code o jcode, mai toccata.** Dal turno successivo
  va sul motore. La storia arriva dal chiamante (`native/provider.ts:11-16`),
  quindi la conversazione continua. Si perde la sopravvivenza al riavvio: è il
  prezzo detto nella scelta 2. Un turno già in volo non cambia strada
  (AICTRL-04, scenario del turno in volo).
- **Chat in Automatico.** Cambia strada solo se il suo default è Claude Code o
  jcode (§2.1, punto 3). Con il default `topics`, che su questo Mac è il
  default del runtime, gira già sul motore.
- **Card mai toccata, con il default della board mai toccato.** Scope `task`,
  quindi spenta come oggi. Il dispatcher continua a scrivere il valore
  effettivo sul topic nuovo.
- **Card che riusa una sessione.** Oggi una card si parcheggia se il suo
  valore effettivo è diverso dal `!!` della sessione (`task-coding-models.ts:272-273`,
  `task-dispatcher.ts:2975-2985`). La regola nuova:
  - se la preferenza della card e del default della board non è mai stata
    scritta (`null`), la card **adotta** la strada della sessione e non si
    parcheggia: non sta difendendo un valore che nessuno ha scelto;
  - se è esplicita e la strada effettiva è diversa, si parcheggia come oggi,
    con lo stesso motivo;
  - una sessione con `null` (le card di prima del 22/09) si legge con lo scope
    `task`. Prima del turno il dispatcher ci scrive il valore effettivo, come
    `createTopic` fa per una sessione nuova, così `resolveTopicProvider` non la
    legge con lo scope `chat`.

  Per questo il dispatcher conserva il `null` fino al controllo del riuso
  (`task-dispatcher.ts:5405-5408` oggi lo fa diventare booleano subito).

**Con l'alternativa** (anche le card): `TOPICS_ROUTING_DEFAULT.task` diventa
`true`. La regola del riuso resta la stessa: con l'alternativa, è lei che evita
il parcheggio di ogni card `null` su una sessione che contiene 0. Il prezzo del
riavvio si moltiplica per le card Claude in volo. Le card Claude Code esplicite
(`task-coding-models.ts:226`) e quelle in Automatico che scelgono un bersaglio
Claude Code (`task-auto-model.ts:91,125`) passano dal broker, dove il turno
sopravvive al SIGTERM (`claude-code.ts:1640-1652`), al motore, dove viene
annullato e poi rimandato (§8).

### 2.4 Alternativa scartata nel design: acceso rigido per tutti

Basterebbe `stored ?? true` dentro le funzioni di oggi. Si bloccherebbero le
chat fissate su Codex, sulle API, su Gemini e su OpenClaw. Ogni card `codex:`
si parcheggerebbe (`dispatch-topic-identity.ts:39-42`). L'Automatico delle card
perderebbe i GPT (`task-auto-model.ts:90`). Il primo messaggio dopo
l'aggiornamento sarebbe un banner rosso. È la scelta 1 «o:». Se viene scelta,
§2.2 non si fa, e la fascia mostra il blocco invece di «diretto».

### 2.5 Il motore passa dallo stesso proxy di Claude Code

Le sessioni Claude Code lanciate da Topics hanno
`--setting-sources user,project,local` (`server/providers/claude/args.ts:328`),
quindi leggono l'`env` di `~/.claude/settings.json`. Su questo Mac lì c'è
`ANTHROPIC_BASE_URL=http://127.0.0.1:3336` (misurato). Su quella porta ascolta
il cambia-account (`~/.claude/account-switcher/dashboard.mjs`), con
`autoSwitch: true` e 2 account (misurato). Il motore invece manda tutto a
`API_URL = "https://api.anthropic.com/v1/messages"` (`native/agent-loop.ts:53`),
con la credenziale «Claude Code-credentials» del Portachiavi
(`native/auth.ts:139`).

Il motore legge l'indirizzo con lo stesso ordine della CLI: prima la variabile
di processo `ANTHROPIC_BASE_URL`, poi l'`env` di `~/.claude/settings.json`,
infine il valore di oggi. Se l'indirizzo non è raggiungibile non ripiega
sull'API diretta in silenzio: l'errore dice quale indirizzo ha provato.

Prima del codice, una misura (tasks 1.5): una richiesta del motore attraverso
il proxy risponde 200. Se non risponde, questa sezione si ferma, e la scelta 2
aggiunge il prezzo «un account solo invece della rotazione».

**Esito della misura (03/10, implementazione).** La misura è stata fatta senza
nessuna chiamata a un modello vero, per regola di questa tornata: HOME usa e
getta, `settings.json` finto con `env.ANTHROPIC_BASE_URL` su un ascoltatore
locale finto, credenziale finta, Portachiavi spento
(`TOPICS_CREDENTIALS_KEYCHAIN=0`) e un `fetch` che rifiuta ogni host che non sia
loopback (`measurements/msel11-measure.ts`).
- Prima del codice: l'ascoltatore riceve 0 richieste, il motore prova
  `https://api.anthropic.com/v1/messages` (`measurements/msel11-before.json`).
- Dopo `base-url.ts`: l'ascoltatore riceve `POST /v1/messages`, il turno chiude
  con 200 (`measurements/msel11-after.json`).
- Il proxy vero su :3336 non è stato chiamato. Che accetti la richiesta del
  motore si legge nel suo codice (`~/.claude/account-switcher/dashboard.mjs`,
  `handleProxyRequest`): prende ogni `POST /v1/messages`, rimette l'identità di
  Claude Code (`ensureClaudeCodeIdentity`) e sostituisce il token del chiamante
  con quello dell'account attivo, quindi la forma che manda il motore (bearer
  OAuth, `anthropic-beta` OAuth, blocco d'identità) è la stessa delle sessioni
  Claude Code. Il 200 attraverso il proxy vero resta **non verificato**: costa
  una richiesta d'uso, che qui era vietata.

Quindi il motore si può instradare sullo stesso indirizzo, e la scelta 2 resta
quella approvata.

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

> **Consigliata dopo la verifica: colonne affiancate su desktop, lista sul
> telefono.** La richiesta chiede di vedere insieme i modelli di aziende
> diverse; le misure qui sotto (§4.2) dicono che la lista unica lo fa solo fino
> a due o tre aziende, e su questo Mac possono essere quattro. Le colonne:
> pannello di circa 700 px, una colonna per azienda larga almeno 160 px,
> ciascuna scorre da sola con l'intestazione ferma; ricerca, fascia e
> Automatico sopra tutte; frecce su e giù dentro la colonna, sinistra e destra
> fra le colonne. Sotto i 720 px resta la lista descritta in §4.1. Il resto di
> questa sezione descrive la lista, che è anche la forma del telefono.

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

Fascia, ricerca e Automatico non scorrono. Scorre solo l'area delle sezioni,
che è il contenitore delle intestazioni sticky.

### 4.2 Misure

| | Desktop | Telefono (< 768 px) |
|---|---|---|
| Contenitore | `Menu` ancorato, `w-[min(22rem,calc(100vw-1rem))]` | il foglio dal basso di `Menu` (`Menu.tsx:197-265`), largo quanto lo schermo |
| Altezza massima | **nuova**: lo spazio libero dal lato in cui `Menu` apre il pannello, meno 16 px | quella di `Menu`, `calc(100dvh - 3rem)` (`Menu.tsx:249`) |
| Scorrimento | **nuovo**: area delle sezioni con `overflow-y: auto` e `overscroll-behavior: contain` | lo stesso, dentro il foglio |
| Riga | 28 px (`POPOVER_ITEM`) | 44 px (`coarse:py-3`) |
| Colonne della riga | nome · finestra · via · spunta | nome · via · spunta; la finestra va sotto il nome |

Oggi il popover da desktop non ha né altezza massima né scorrimento
(`Menu.tsx:252-262`). Il tetto e l'`overflow` esistono solo nel ramo telefono
(`:246-250`), e stanno in uno stile inline apposta (`:230-240`): una classe
messa dal chiamante non li cambia. Quindi:
- su desktop il tetto lo calcola `ModelSelector`, dallo stesso rettangolo del
  trigger che `Menu` usa per decidere se aprire sopra o sotto
  (`computeMenuPosition`, `Menu.tsx:127-130`, da `lib/popoverPosition`);
- sul telefono si tiene il `calc(100dvh - 3rem)` di `Menu`, e niente 85dvh.

Altezze misurate nel mockup, con le righe da 28 px:

| Caso | Altezza |
|---|---|
| 2 aziende più il riquadro Google «non pronto», chiaro | 585 px |
| 2 aziende, scuro | 532 px |
| ogni azienda in più con 4 righe correnti e «Altri» | circa +160 px |
| 4 aziende (stima: Gemini, jcode e OpenClaw sono installati su questo Mac) | circa 850-900 px |

I modelli di Gemini e di OpenClaw non li ho misurati: serve lo snapshot vivo
su :3333, che è vietata. In una finestra alta 900 px, con il composer in basso,
il pannello si apre sopra il trigger e ha circa 700 px. Da 3-4 aziende in su
la lista scorre, con le intestazioni ferme.

### 4.3 Correnti e «Altri modelli»

- **Anthropic.** È corrente il più nuovo di ogni famiglia: `newestOfFamily`
  (`server/providers/claude-models.ts:77`), già usato per il default. Sul
  catalogo misurato restano Opus 5.5, Sonnet 5.5, Haiku 4.5 e Fable 5.1;
  Opus 4.8, Sonnet 4.6 e Haiku 3.5 vanno in «Altri».
- **OpenAI** (Codex). È corrente la generazione del primo modello per
  `priority` della cache: 6.1-Sol, 6-Astra, 6-Sol, 6-Luna. 5.6-Sol, 5.6-Terra,
  5.6-Luna e 5.5 vanno in «Altri», e 5.5 porta «si ritira il 14/10».
- **Senza ordine noto** (ACP, endpoint): tutti correnti.
- **1M.** `claude-x[1m]` e `claude-x` diventano una riga sola, con un
  interruttore «1M» a destra del nome se la variante esiste. La finestra
  mostrata segue l'interruttore. Il valore salvato resta l'id vero. Prima di
  piegare le generazioni vecchie, le righe Anthropic passano da 11 a 7.

### 4.4 Ricerca

È un confronto per sottostringa, senza distinguere maiuscole e accenti, su
etichetta, id, azienda, nome del motore e descrizione. Più parole vanno tutte
trovate. Niente libreria fuzzy (MP-TASK-07, nessuna dipendenza). Con meno di
40 righe la lista non si virtualizza (HERO: la virtualizzazione non risolve un
problema che qui non c'è).

**Con l'alternativa** (colonne): sopra i 720 px di viewport il pannello è largo
`min(44rem, 100vw - 2rem)` e ogni azienda è una colonna di circa 176 px. È alto
circa 300 px e mostra tutte le aziende insieme fino a 4. Sotto i 720 px si torna
a §4.1. Le frecce scendono dentro una colonna, e `←` `→` passano da una
colonna all'altra; la scelta del motore dentro la riga va quindi su un altro
tasto. Sono due impaginazioni da tenere e da testare. È la forma più vicina a
T3 Code. In pingdotgg/t3code#2153 (verificato con `gh`) T3 Code ha tolto i
sottomenu per provider perché «cumbersome», e li ha sostituiti con una colonna
di provider, una lista con ricerca e i preferiti.

## 5. La fascia «Esegui in Topics» (scelta 5)

### 5.1 Testi

| Chiave | it | en |
|---|---|---|
| `ai.selector.routing` | Esegui in Topics | Run in Topics |
| `ai.selector.routingLine` | Claude gira dentro Topics col tuo abbonamento, senza aprire un processo Claude Code per chat. GPT e Gemini restano diretti. | Claude runs inside Topics on your subscription, without starting a Claude Code process per chat. GPT and Gemini stay direct. |
| `ai.selector.route.topics` | via Topics | via Topics |
| `ai.selector.route.direct.family` | Questo modello va diretto: {engine} non passa da Topics. | This model runs direct: {engine} does not go through Topics. |
| `ai.selector.route.direct.model` | Questo modello va diretto: Topics non lo serve ancora. | This model runs direct: Topics does not serve it yet. |
| `ai.selector.route.direct.engineDown` | Il motore di Topics non è connesso: per ora va diretto. | The Topics engine is not connected: running direct for now. |

La riga non dice «stessa quota» né «meno memoria».
- La quota è la stessa solo con §2.5.
- La memoria cala per Claude Code («~206 MB misurati» a sessione,
  `native/auth.ts:7-8`; il commento di `acp/agents.ts:35` dice ~790), ma non
  per jcode, che costa 0,58 MB a sessione (`acp/agents.ts:35-38`).

`ai.selector.routingHint`, `routingUnavailable` e `chat.topicsRouting.blocked`
escono dai dizionari.

### 5.2 Stati della fascia

| Stato | Sfondo | Testo sotto il titolo |
|---|---|---|
| acceso, il modello scelto passa | `--primary-light`, bordo sinistro 2 px `--primary` | `routingLine` |
| acceso, il modello scelto va diretto | `--bg-inset` | `route.direct.*` in ambra (`--color-accent-warning`) |
| spento | `--bg-inset` | `routingLine` in `--text-muted` |

L'interruttore è un vero `role="switch"`, largo 28 px, e si clicca su tutta la
fascia. Non è mai disabilitato: spegnere e accendere vale sempre, perché nessuno
dei due stati blocca.

### 5.3 Il segno sul chip

Quando la strada del valore attuale è `topics`, il chip del composer mostra
l'icona `Route` (12 px, `--primary`) prima del nome del modello, con il
`title` «via Topics». Quando è diretto, non c'è niente. Sulla `chip` della
board, «· via Topics» fa parte del testo.

## 6. I metadati del catalogo

**La finestra di contesto non chiede niente di nuovo.** Il campo esiste già:
`ProviderSnapshotEntry.modelContextWindows` (`shared/types.ts:541`). Lo
riempie `snapshot-manager.ts:171-172` da `contextWindows()` del provider, il
menu lo legge (`AiExecutionMenuOptions.tsx:85`), e `contextWindowFor(model,
declared)` lo fa già vincere sulla tabella (`shared/context-window.ts:168-174`).
Manca solo che Codex lo dichiari: `CodexProvider.contextWindows()` legge
`context_window` dalla cache, come fa `openai-compatible.ts:134` per gli
endpoint. I GPT passano così da 400k e ≈1M a 272k.

Si mostra `context_window` (272000) e non `max_context_window`, che vale 872000
per tutti tranne `gpt-5.5` (misurato): la finestra con cui Codex lavora di
default è la prima.

**Gli altri metadati** entrano in un campo opzionale:

```ts
modelInfo?: Record<string, {
  label?: string;          // display_name della cache Codex
  description?: string;    // una riga, già tagliata a 400 caratteri in codex/models.ts:22
  retiresAt?: string;      // ISO, da `upgrade.retirement_at`
  replacement?: string;    // `upgrade.model`
  generation?: 'current' | 'older';
}>;
```

- **Codex**: tutto dalla cache (`readCodexModels`, già letta). Oggi
  `codex.ts:1353-1362` la riduce agli slug.
- **Claude Code**: soltanto `generation`, da `newestOfFamily`. Niente
  descrizioni scritte a mano: il catalogo a mano di `CommandMenu` è stato tolto
  apposta (`Shared/CommandMenu.tsx:12-24`).

## 7. Tastiera, telefono e `/model`

- ⌘⇧M (libero in `shared/shortcuts.ts`, misurato) apre il selettore del
  composer che ha il fuoco, e lo stesso tasto lo richiude. La scorciatoia è
  registrata nel catalogo delle scorciatoie, quindi resta rimappabile.
- Il fuoco parte dalla ricerca. `↓` entra nella lista. Le frecce attraversano
  fascia, Automatico, righe e «Altri» senza fermarsi alle intestazioni
  (`useMenuKeyboard`, che salta ciò che non si naviga).
- Invio sceglie e chiude. `→` su una riga con più motori apre il segmento «via»,
  `←` lo chiude. Spazio sulla fascia la commuta. Esc chiude e riporta il fuoco
  al trigger (MP-TASK-07).
- Lettore di schermo:
  - `role="listbox"` sulla lista;
  - le intestazioni hanno `role="presentation"`, e l'`aria-label` sta sul
    gruppo (`role="group"`);
  - ogni riga ha `role="option"` e `aria-describedby` sulla descrizione.
- Telefono: il foglio di `Menu` con la maniglia, righe da 44 px, e la ricerca
  ferma in cima mentre la lista scorre.
- `/model <id>` scrive solo `topic.model` (`ChatPane.tsx:1042` →
  `commandApi.setModel`), quindi il motore non può viaggiare con lui. Il
  completamento propone solo i modelli del motore attuale della chat. Per
  cambiare motore si apre il selettore.

## 8. Rischi

- **Il turno nativo e il riavvio.** Non serve misurarlo, lo dice il codice.
  `gracefulShutdown` (`server.ts:6698`) chiama `stopAllProviders` (`:6771`).
  Lì `stop()` del motore annulla ogni turno vivo con causa `server-shutdown`
  (`native/provider.ts:288-301`). Al boot `riprendiTurniInterrotti` lo rimanda
  (`server.ts:5713`), e il turno si paga di nuovo. Su questo Mac succede a ogni
  salvataggio sotto `server/` (`TOPICS_SERVER_WATCH`, `~/.topics-server-env:18`).
  Con la scelta 2 consigliata il prezzo resta alle chat che cambiano strada
  (§2.3). Rimediare sta in un'altra change: questa dichiara il prezzo, non lo
  nasconde.
- **Il proxy degli account** (§2.5). Se il motore non passa da :3336, chi
  cambia strada lascia la rotazione dei 2 account per uno solo. Le chat in
  Automatico sul motore lo pagano già oggi.
- **Due change non archiviate.** AICTRL e MP-TASK-04/07 vivono in
  `ai-control-hierarchy-topics-switch` e `general-auto-model-ui`. Il delta qui
  le MODIFICA, quindi l'archiviazione va fatta in quest'ordine: quelle due,
  poi questa.
- **Test che fissano il vecchio comportamento.** Sono 14 file (tasks 1.6).
  Vanno riscritti sul nuovo contratto, non cancellati.
