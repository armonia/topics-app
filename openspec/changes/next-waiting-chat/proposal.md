## Da decidere

⌘J alla prossima chat che ti aspetta: 4 scelte prima del codice.
1. Mete: solo le righe ambra (CHAT-WAIT-01), cioè le chat ferme su una domanda o un permesso, più il piano da approvare dove lo chiede Claude Code (`cli` e terminali). Perché: domanda e permesso sono ambra con ogni runtime (o: anche i turni finiti blu, che esistono solo per `cli` e terminali Claude Code).
2. Ordine: quello della sidebar, prima i Fissati e poi la sezione «Attende te». Perché: nella timeline e nella vista per stato ⌘J scende lungo le righe che vedi; con i gruppi accesi (basta un gruppo con tab) la sezione non è a schermo e ⌘J segue il suo ordine, non quello delle card (o: chi aspetta da più tempo per primo, una coda che non si vede).
3. Dopo una risposta ⌘J va alla successiva di quella appena lasciata, come Gmail dopo un'archiviazione. Perché: ripartire dalla prima ti rimanda a quella che avevi saltato (o: riparte sempre dalla prima).
4. Telefono: quinta porta «In attesa» in fondo, col numero, sempre al suo posto e spenta a zero. Perché: il pollice ci arriva da lista e chat, e le porte non si spostano (o: tasto nella testata della chat, solo quando serve).
Compreso, senza scelta: dopo l'ultima si riparte dalla prima; le chat al lavoro non sono mete; ⌘J vale anche col fuoco nel composer o in una pane browser; su Windows Ctrl+J resta al terminale e all'editor; anche i terminali Claude Code fermi su un permesso sono mete; un avviso quando non c'è un'altra chat; niente ⌘⇧J.
Fuori, senza scelta: il piano che col runtime nativo l'app chiede a fine turno. Il turno è chiuso e la riga non è ambra, quindi ⌘J non lo trova; portarlo dentro vuol dire colorare un turno chiuso, ed è una change sua.
Col sì: la sezione «Attende te» della vista per stato mostra anche le chat ferme su una domanda o un permesso dentro l'app, che oggi finiscono sotto «Al lavoro». Costo: la fila del telefono passa da quattro a cinque porte (forma del 12/08 e del 14/08), ciascuna da circa 89 a 70 px su un iPhone largo 375.
«ok / ok ma 2 no»: «ok» = tutte le consigliate, «ok ma 2 no» = cambio la 2.

| # | Dove cambiarla |
|---|----------------|
| 1 | `CHAT-WAIT-03` (le mete); design §1 |
| 2 | `CHAT-WAIT-03` (l'ordine); design §2 |
| 3 | `CHAT-WAIT-03` (dopo una risposta); design §3 |
| 4 | `CHAT-WAIT-04`; design §6 |

---

# ⌘J: la prossima chat che ti aspetta

Card `fe2c73e0`, dalla matrice dei gap rispetto a Claude Code e jcode (card
`e6b76521`, card consigliata 5; riga «/catchup e /back» di jcode). Aperta su
decisione di Attilio del 28/09.

## Why

Con dieci chat di agenti aperte il gesto più frequente è «dove mi stanno
aspettando?». Oggi la risposta si cerca a occhio nella sidebar, riga per riga, e
ha tre buchi.

1. **Nessun tasto.** ⌘J è libero: in `shared/shortcuts.ts` non c'è (il gruppo
   «Chat» sta a `:158-169`) e `useKeyboardShortcuts.ts:254` ricorda che la «J»
   è stata liberata quando la palette «New…» è passata su ⌘N. Sul telefono la
   fila in fondo (`client/src/components/Sidebar/MobileChromeBar.tsx`) ha
   quattro porte e nessuna porta a chi aspetta.
2. **La sezione «Attende te» non vede le domande dell'app.** La vista per stato
   (`TopicTree.tsx:779-799`) passa a `groupSidebarItemsByState` solo
   `awaitingFeedbackTopics`, che nasce dalle fasi degli hook Claude Code
   (`client/src/state/signals.ts:174`). Una chat del runtime di default ferma su
   `ask_user_question` o su un permesso del bridge arriva come `state: "waiting"`
   da `GET /api/topics/streaming` (`server/routes/topics.ts:1110-1162`) e finisce
   solo in `awaitingInputTopics` (`useSignalsSync.ts:57-74`). Risultato: la riga
   è ambra (`useTopicAttentionTier`, `signals.ts:1094-1100`) ma sta sotto «Al
   lavoro», perché il suo stream è ancora aperto. CHAT-WAIT-01 chiede che anche
   fuori dalla chat il segnale dica «ferma», e CHROME-07 che la vista raggruppi
   chi aspetta.
3. **Nessun ordine condiviso.** L'ordine della sidebar esiste solo dentro
   `TopicTree` (`buildSidebarItems.ts:731-744`, poi Fissati e sezioni). Un tasto
   che ne calcolasse un altro direbbe «prossima» di una chat che a schermo sta
   sopra.

## What changes

- **Un elenco, due porte.** Funzione pura `waitingQueue` in
  `client/src/lib/waitingQueue.ts`: le righe ambra nell'ordine in cui la
  sidebar le mostra. `TopicTree` la calcola, la pubblica in un piccolo store
  (`client/src/state/waitingQueue.ts`) e risponde all'evento
  `topics:next-waiting` con lo stesso gestore del clic sulla riga.
- **Il passo.** Funzione pura `nextWaiting(queue, focused, last)`: la successiva
  dopo quella a fuoco, la prima dopo l'ultima, e dopo una risposta la successiva
  di quella appena lasciata. Nessuna meta: un avviso, niente movimento.
- **⌘J.** Voce `Mod+J` nel gruppo «Chat» del registro, con `native: { chars: ['j'] }`
  così arriva anche con una pane browser a fuoco; gestore accanto a ⌘E in
  `useKeyboardShortcuts.ts`, che annuncia l'evento e basta.
- **Telefono.** Porta «In attesa» nella fila in fondo, col numero della coda.
- **«Attende te».** La vista per stato legge l'unione `awaitingFeedbackTopics ∪
  awaitingInputTopics`, la stessa che dipinge l'ambra.

## Non-goals

- Nessun ⌘⇧J («precedente»). Si aggiunge se serve, sulla stessa funzione.
- L'ordinamento della lista per attività non cambia: le domande dell'app non
  salgono in cima alla vista a lista (il boost di `buildSidebarItems.ts:731-744`
  legge solo non letti e fasi degli hook).
- Un piano scritto solo in prosa a turno chiuso non è una meta:
  `findPendingPlan` (`client/src/components/Chat/planDetection.ts:81-110`) lo
  trova solo dentro la chat aperta, e la sidebar non lo colora.
- Nemmeno il piano che l'app chiede col runtime nativo. In plan mode la CLI non
  espone `ExitPlanMode` (`server/lib/plan-approval.ts:5-8`), quindi a fine turno
  il piano diventa una domanda `waiting_for_input`
  (`server/routes/chat.ts:1983-2001`) e subito dopo il turno si chiude
  (`endStreamAndAnnounce`, `:2315-2317`). Lo stream esce da `activeStreams`
  (`server/utils.ts:2151`), lo scatto `GET /api/topics/streaming` legge solo
  quella mappa (`server/routes/topics.ts:1128`) e `stream:end` toglie il topic
  dalle domande aperte (`client/src/state/useSignalsSync.ts:146-150`): la riga
  non è ambra. Farne una meta vuol dire dare l'ambra a un turno chiuso, cioè
  toccare lo scatto e i segnali: una change sua, con i suoi test. Il piano che
  passa da `ExitPlanMode` con gli hook (`cli` e terminali Claude Code) diventa
  `awaiting-approval` (`server/lib/claude-session-state.ts:151`) ed è una meta.
- I sotto-agenti annidati sotto una chat o un terminale non sono mete.
- Nessuno scroll speciale sulla domanda: la chat si apre come col clic sulla riga.

## Rapporto con le altre change

- **`chat-claude-code-parity`**: nessun requisito in comune. Il suo CHAT-PERM-01
  ha portato lo stato `awaiting_permission` (`shared/types.ts:273-275`,
  `isAwaitingHuman`), che lo snapshot degli stream legge già come «waiting»:
  questa change lo consuma, non lo tocca. Lì non c'è navigazione fra chat.
- **`remappable-shortcuts`** (non approvata): se arriva, questa voce diventa un
  comando con il suo id come le altre; la «J» è libera anche lì.

## Impact

`shared/shortcuts.ts`, `desktop-tauri/src-tauri/src/shortcuts_generated.rs`
(rigenerato), `desktop-tauri/src-tauri/src/chords.rs` (test),
`client/src/hooks/useKeyboardShortcuts.ts`, `client/src/lib/waitingQueue.ts`
(nuovo), `client/src/state/waitingQueue.ts` (nuovo),
`client/src/lib/buildSidebarItems.ts`, `client/src/components/Sidebar/TopicTree.tsx`,
`client/src/components/Sidebar/MobileChromeBar.tsx`, `client/src/App.tsx`, i18n
(`client/src/lib/i18n-it.ts`, `i18n-en.ts`). Test: vedi `tasks.md`.
