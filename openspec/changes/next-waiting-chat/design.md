# Design: next-waiting-chat

Solo le scelte tecniche; quelle che cambiano cosa vedi stanno nel blocco
«Da decidere» di `proposal.md`.

## 1. Le mete sono l'insieme ambra

Una meta è una riga della sidebar il cui soggetto sta in:

- `awaitingInputTopics` per una chat: fase `awaiting-approval` degli hook
  (`deriveAwaitingInputTopics`, `signals.ts:190`) più le chat che lo snapshot
  degli stream dà `waiting` (domanda o permesso dal bridge: `useSignalsSync.ts:64-65`,
  alimentato dalla poll a `:123` e dal frame `stream:tool_user_input_required` a `:157`);
- `claudePhaseAwaitingInputTermIds` per un terminale Claude Code.

Il piano entra solo dalla prima strada: `ExitPlanMode` visto dagli hook diventa
`awaiting-approval` (`server/lib/claude-session-state.ts:151`). Col runtime
nativo in plan mode la CLI non ha `ExitPlanMode` (`server/lib/plan-approval.ts:5-8`)
e l'app chiede l'approvazione a fine turno (`server/routes/chat.ts:1983-2001`):
il turno si chiude subito dopo (`:2315-2317`), lo stream esce da
`activeStreams` (`server/utils.ts:2151`), che è l'unica fonte dello scatto
(`server/routes/topics.ts:1128`), e `stream:end` toglie il topic da
`askWaitingTopics` (`useSignalsSync.ts:146-150`). Quella chat non è ambra e non
è una meta; è un Non-goal della proposta.

È lo stesso predicato che sceglie l'ambra (`useTopicAttentionTier`,
`signals.ts:1094-1100`, e `useTerminalAttentionTier`, `:1105`), quindi meta e colore non
possono divergere. Non si usa `awaitingFeedbackTopics`: aggiungerebbe i turni
finiti (`awaiting-user`, `paused`), che esistono solo per le sessioni con gli
hook. Una chat del runtime nativo che ha finito il turno non entra mai in
quell'insieme, e ⌘J si comporterebbe in due modi secondo il runtime.

Il «visto» (`seenSubjects`) non conta: spegne il fondo ambra dopo 1,2 s davanti,
ma la domanda resta aperta. Come per `topicAttentionCount` (`signals.ts:1482`),
il numero dice «ti resta un'azione», non «non l'hai ancora guardata».

## 2. Un ordine solo, quello della sidebar

`waitingQueue(allItems, pinnedIds, sig)` in `client/src/lib/waitingQueue.ts`,
pura come il resto di `buildSidebarItems.ts`:

1. le righe fissate che sono mete, nell'ordine dei Fissati (`pinnedBlock`,
   `TopicTree.tsx:692-723`), cioè quelle che la vista disegna in cima;
2. poi `groupSidebarItemsByState(unpinned, stateSig).awaiting`
   (`buildSidebarItems.ts:900-921`) filtrato sulle mete: quell'elenco conserva
   l'ordine del builder e promuove i figli dei progetti al loro posto;
3. infine un soggetto compare una volta sola, alla prima occorrenza. `unpinned`
   filtra solo il livello alto (`TopicTree.tsx:724-726`), mentre i Fissati
   prendono anche i figli fissati (`:697-698`) e `groupSidebarItemsByState`
   promuove i figli senza guardare `pinned` (`buildSidebarItems.ts:905-913`):
   senza questo passo una chat fissata dentro un progetto sarebbe in coda due
   volte, il numero della porta conterebbe una chat in più e con coda `[X, X]`
   il passo da X darebbe X invece di `null`.

Restituisce `WaitingTarget[]` (`{ subject, kind: 'chat' | 'terminal' }`).

Due note:

- Parte da `allItems`. Un filtro di ricerca della sidebar oggi non esiste:
  l'unico mount di `TopicTree` passa `searchQuery=""` (`App.tsx:1832`), quindi
  `filteredItems` coincide con `allItems` e la coda non riceve un filtro.
- È la sequenza della sezione «Attende te» in ogni vista. Nella timeline coincide
  con l'ordine a schermo (Fissati, poi la lista, coi figli al posto del loro
  progetto). Con i gruppi accesi (`spaceScoped`, vero appena un gruppo vivo ha
  tab: `App.tsx:818`, `spaceHelpers.ts:76-86`) le righe sono smistate per card
  (`groupSidebarItemsBySpace`) e la sezione non si disegna
  (`TopicTree.tsx:2016`): ⌘J segue comunque il suo ordine e a schermo può
  saltare fra le card. Lo dice la scelta 2 della proposta.

## 3. Il passo, e cosa succede dopo una risposta

`nextWaiting(queue: string[], focused: string | null, last: { queue: string[]; target: string } | null): string | null`

1. `queue` vuota: `null`.
2. `focused` sta in `queue`: la prima dopo di lei, girando dall'inizio; se è
   l'unica, `null`.
3. `focused` non sta in `queue` ma è `last.target` (la chat dove ti ha portato
   l'ultimo ⌘J, che nel frattempo ha smesso di aspettare perché hai risposto):
   si scorre `last.queue` dopo `last.target` e si prende la prima ancora in
   `queue`; se non ce n'è, `queue[0]`.
4. Altrimenti `queue[0]`.

Il punto 3 esiste perché la risposta sposta la chat: esce da «Attende te», passa
«Al lavoro» e nella lista cambia posto per attività. La sua posizione nuova non
dice niente; quella nell'elenco di prima sì. `last` vive nello store e si
aggiorna a ogni passo; un clic su un'altra riga lo rende irrilevante, perché
`focused` non è più `last.target`.

`null` produce un avviso con `useToast` (già in `TopicTree.tsx:447`): «Nessuna
chat ti aspetta» a coda vuota, «Nessun'altra chat ti aspetta» quando l'unica è
quella a fuoco. Testo dall'i18n.

## 4. Il tasto

- **Registro.** Nel gruppo «Chat» di `shared/shortcuts.ts`:
  `{ keys: [MOD, 'J'], description: 'Next chat waiting for you', native: { chars: ['j'] } }`,
  in inglese come il resto del registro: `KeyboardShortcuts.tsx:56` stampa la
  descrizione senza i18n.
  Senza `native` il monitor NSEvent non inoltra l'accordo e con una pane browser
  a fuoco ⌘J morirebbe lì, come spiega il commento di ⌘E (`shortcuts.ts`,
  gruppo «Panels & tabs»). `bun run gen:shortcuts` rigenera
  `shortcuts_generated.rs`; `chords.rs:162-170` aggiunge `'j'` alla lista di
  `app_chords_from_the_registry_are_forwarded`, perché il test di coerenza non
  prova la copertura.
- **Gestore.** In `useKeyboardShortcuts.ts`, accanto a ⌘E (`:360-367`):
  `isMod && !e.shiftKey && !e.altKey && e.key` è `j`/`J` `&& (e.metaKey || !isRawKeySurfaceFocused(e.target))`
  → `preventDefault()` e `window.dispatchEvent(new CustomEvent(NEXT_WAITING_EVENT))`.
  Confronto su `e.key`, mai su `e.code`: il keydown sintetico del monitor porta
  solo `key` e i modificatori.
- **Nessuna guardia sul campo di testo.** Il composer è il posto da cui si parte:
  hai appena risposto, premi ⌘J. Come ⌘K.
- **Windows.** `isMod` è anche `ctrlKey`, e Ctrl+J è un tasto vero nel
  terminale (a capo) e in un editor: sul ramo ctrl il gestore cede a quelle due
  superfici, come ⌘E e ⌘, già fanno. Con una pagina a fuoco Ctrl+J viene
  inoltrato e non arriva alla pagina: lo stesso compromesso di Ctrl+E.

## 5. Chi risponde: la sidebar

L'evento lo ascolta `TopicTree`, perché lì stanno le tre cose che servono:
l'ordine (`allItems`, `pinnedBlock`), la riga a fuoco (lo stesso `isFocused` di
`TopicTree.tsx:920-921` e `:991`) e il gesto della riga (`handleChatRowClick`,
`:893-906`, che sa anche riportare davanti una chat staccata in un'altra
finestra). Per i terminali il clic della riga fa due cose,
`clearTerminalFinished` e poi `onTerminalClick` (`TopicTree.tsx:2376`): le due
chiamate diventano `handleTerminalRowClick` in `TopicTree`, passato alla riga al
posto di `onTerminalClick` e chiamato dal tasto. Così ⌘J fa esattamente ciò che
fa il clic, senza una seconda strada per «apri questa chat».

È la forma di ⌘E e ⌘T: il tasto annuncia l'intenzione, chi possiede la cosa
risponde. La sidebar è sempre montata: chiusa, scorre fuori con `translateX`
(`App.tsx:1481-1484`), non si smonta.

Lo store `client/src/state/waitingQueue.ts` (zustand) tiene `queue: string[]` e
`last`. `TopicTree` scrive `queue` in un effetto solo quando cambia (confronto
per elementi, per non svegliare chi legge a ogni render); il passo scrive `last`.
Lo store esiste per la porta del telefono, che sta in `App.tsx:1964` e ha
bisogno del numero.

## 6. La porta sul telefono

`MobileChromeBar` riceve `waitingCount` e `onNextWaiting` e disegna una casella
in più, prima del Profilo: `BottoneFila` (`MobileChromeBar.tsx:376`) con
`Hourglass`, lo stesso glifo della sezione «Attende te» (`TopicTree.tsx:72`),
etichetta «In attesa» e il numero come `NotificationBadge`. A zero è `disabled`
col titolo «Nessuna chat ti aspetta».

`BottoneFila` oggi non ha `disabled`: lo riceve, e a zero spegne glifo e testo
ma tiene la campitura `RAISED_CONTROL`. MOBILE-CHROME-06 misura il fondo di ogni
porta a riposo, e nella sua suite nessuna chat aspetta: la porta misurata è
proprio quella spenta.

Il Profilo resta l'ultima porta e tiene la curva: il verso lo decide
`formaFila` guardando da che bordo dista la casella, quindi l'arco non si tocca.
In `tests/e2e/mobile-chrome-bar.spec.ts` passano da quattro a cinque:

- i conteggi `expect(...length).toBe(4)` di MOBILE-CHROME-02 (`:230`), 03
  (`:263`), 03b (`:308`) e 06 (`:466`); `porte()` (`:105-109`) conta ogni
  `<button>` della barra;
- la destrutturazione in quattro di MOBILE-CHROME-03 (`:264`): con cinque, `dx`
  sarebbe la quarta porta, che non tocca il bordo, e
  `dx.daFondo > centroDx.daFondo` cadrebbe. Diventa primo, ultimo e
  `slice(1, -1)` per i centrali, come MOBILE-CHROME-07 (`:563-565`);
- i titoli di MOBILE-CHROME-02 (`:221`) e 03b (`:303`) e i commenti che dicono
  quattro: `:5`, `:13`, `:258`, `:281-282`, `:310`, `:464`, `:472`, `:493`,
  `:559`.

Il minimo di 44 px regge (circa 70 px su 375).

## 7. La sezione «Attende te» legge l'unione

In `TopicTree.tsx:788-799` il set `awaitingTopics` passato a
`groupSidebarItemsByState` diventa `awaitingFeedbackTopics ∪ awaitingInputTopics`.
L'unione si fa nel `useMemo`, non nel selettore (il commento di `:774-778` dice
perché: un `new Set` nel selettore ridisegna a ciclo continuo).

Per non scriverla due volte, la costruzione dei segnali di stato passa in una
funzione pura `sidebarStateSignals(...)` in `buildSidebarItems.ts`, usata dalla
vista e da `waitingQueue`. I terminali non cambiano:
`claudePhaseAwaitingTermIds` contiene già `awaiting-approval`.
