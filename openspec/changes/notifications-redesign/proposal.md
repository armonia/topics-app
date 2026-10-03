## Da decidere

Notifiche: 5 scelte prima del codice.
1. «Ti serve» è solo una persona in mezzo (domanda, permesso, piano da approvare, card in review o parcheggiata) e resta accesa finché rispondi; «ha finito» si spegne guardandolo, perché oggi una chat letta ferma su `awaiting-user` resta a 1 su riga, tab, campanella e Dock fino al turno dopo e il «segna tutto» non la spegne (BELL-1, B2) (o: anche «ha finito» resta acceso finché non scrivi, come chiede oggi NOTIF-ONE-02 scenario 4).
2. Un agente che aspetta il proprio lavoro in background tace finché quel lavoro gira (solo il glifo grigio) e avvisa una volta, quando l'ultimo compito è tornato e il turno chiude senza altro in volo, perché nella tua sessione 317 fini turno su 353 avevano ancora un Agent, un Bash o un Workflow vivo e ognuna oggi diventava «tocca a te» (o: nessun avviso nemmeno alla fine, solo quando ti serve davvero).
3. Il «visto» è tuo, non del dispositivo né della finestra: guardare una chat sul Mac la spegne sul telefono e nelle altre finestre e resta spenta dopo un ricarico, perché oggi il visto vive in memoria per finestra e un ricarico riaccende ogni chat già letta (B4) (o: visto per dispositivo, il telefono tiene la sua campanella).
4. Il tasto della sidebar diventa una inbox: elenca le cose accese («Ti aspettano», poi «Finite») con la loro azione, aprirla non spegne niente e la cronologia passa in una seconda linguetta senza numero, perché oggi il numero somma righe di spinte mai partite (382 su questa macchina, D3) e avvisi di swap (D5) e aprirla non spiega cosa c'è (o: resta contatore più cronologia, e aprirla segna tutto visto come oggi).
5. Banner del Mac e spinta al telefono partono solo all'ingresso in «ti serve» o «finito», e la spinta solo se nessuna finestra desktop è sveglia da 2 minuti, perché col Mac davanti il telefono che suona è un doppione (o: la spinta parte sempre, come oggi).

Compreso, senza scelta:
- **Uno stato di attenzione per soggetto, sul server.** Ogni chat, terminale e card ha UNA riga: `working`, `background`, `needs-you` (domanda, permesso, piano, review, parcheggio), `finished` (fatto o errore) o `idle`, più il visto. Il server la compone dai sei assi che ha già e la manda a ogni finestra; tab, riga, progetto, card del gruppo, menu agenti, campanella, Dock, tray e badge PWA la leggono e basta. Spariscono i segni in memoria per finestra (`chatFinishedTopics`, `terminalFinishedIds`, `seenSubjects` come fonte).
- **Il lavoro in background si conta per compito**: Bash e Agent con `run_in_background`, Workflow, CronCreate, Monitor e i `run_command` di Topics. Ogni compito si chiude col suo avviso di fine, non con un booleano: un Monitor scaduto su un terminale non lascia più `watching` per sempre, e un ricarico del server non dimentica i compiti dei terminali.
- **Le domande delle chat passano dal bridge MCP e sono «ti serve»** (D6), come il permesso del permission bridge e il piano da approvare (D8).
- **Un turno risvegliato vuoto non conta niente** (D7): né non-letti né «finito».
- **Errore = «finito» rosso**: si spegne guardandolo, perché il turno è chiuso e niente aspetta te.
- **Chi è davanti non viene avvisato.** Il server sa già quale chat ha il fuoco per finestra (`focus`); il frame porta anche il soggetto (terminali e card) e se la finestra è sveglia. Un «finito» che nasce davanti a una finestra sveglia nasce visto: niente banner, niente numero, niente riga non vista.
- **Avvio senza replay.** A ogni apertura del socket arriva l'istantanea di attenzione; i banner partono solo dalle transizioni dal vivo. La tabella nuova parte vuota: al primo avvio dopo il rilascio nulla di vecchio si accende.
- **La cronologia è solo cronologia.** Le righe del registro le scrive il server, una per transizione accesa, anche quando la spinta non parte; non entrano più in nessun numero. Le vecchie righe restano lì da leggere.
- **Gli avvisi di infrastruttura hanno un soggetto loro.** Congelato/scongelato dello swap e riavvio trattenuto diventano righe «Sistema» in cronologia, una per ciclo, e non accendono la chat (D5).
- **Archiviare o cancellare spegne il soggetto e le sue righe**, dove si scrive e non dove si legge (ARCH-1, B3/C).
- **La card rimessa in coda, cancellata o archiviata si spegne** (D4, F3).
- **Gli agenti di board non accendono il proprio topic**: il soggetto è la card.
- **Silenziato conta e non suona** (MUTE-01 resta com'è).
- **Il Dock e la tray li scrive solo la finestra principale.** Il numero è uguale ovunque, ma una sola mano evita che lampeggi.
- **Il ramo `approval:created` di push-triggers, senza emettitori, si toglie.**
- **Gli ospiti restano senza campanella**, come oggi.

Fuori:
- L'iscrizione del telefono e la sua card nelle impostazioni (PUSH-01…05 restano).
- Suoni, testi dei banner e impostazioni Non disturbare oltre a ciò che serve qui.
- Un visto per persona fra account diversi della stessa installazione: oggi c'è una persona, e il visto è suo.
- I chip delle card nella board e il loro drawer.
- Qualsiasi migrazione di dati: c'è una tabella nuova, che parte vuota.

ok / ok ma 2 no

---

# Notifiche vere e sincronizzate: uno stato di attenzione solo, sul server

Richiesta di Attilio del 03/10 (testo in `.openspec.yaml`).

## Dove cambiarla

| # | Dove cambiarla |
|---|----------------|
| 1 | `ATTN-04`, `ATTN-05`, `NOTIF-ONE-02` (modificato); design §3 |
| 2 | `ATTN-02`, `ATTN-03`, `MONITOR-04` (modificato); design §5 |
| 3 | `ATTN-06`, `NOTIF-ONE-01` (modificato); design §6 |
| 4 | `ATTN-09`, `NOTIF-ONE-01` (modificato); design §9 |
| 5 | `ATTN-11`; design §10 |

## Why

Il server non ha uno «stato di attenzione» di una chat. Ha sei assi indipendenti e
nessuno li compone: il turno (`activeStreams`, in memoria), il lavoro in background
(per figlio CLI, visibile solo nel poll di `GET /api/topics/streaming` ogni 15 s), la
fase Claude (`claude_code_sessions`, guidata dagli hook), l'attesa di una persona
(bridge ask/permission, ascoltati solo dal dispatcher), i non-letti (`unread`) e le
righe del registro (`notification_log`). Il client ne ricompone una parte in tredici
superfici, e ci aggiunge tre segni che vivono in memoria per finestra: «done» di una
chat, «finished» di un terminale, «visto». Ogni superficie sceglie la sua combinazione.
Mappa completa: `evidence/server-states-and-notification-sources.txt`,
`evidence/client-surfaces-map.txt`, `evidence/sync-F-map-and-traced-defects.txt`.

Il risultato è quello che hai visto: una chat che ha detto «lancio i verifier, aspetto»
diventa blu, prende il badge, suona «In attesa di te» e accende campanella e Dock; poi
suona di nuovo quando il lavoro torna. E la campanella conta cose che non ci sono
(spinte mai partite, chat archiviate, avvisi di swap) e non si svuota guardando.

Misura: nella sessione che ha fatto questo lavoro, un terminale con la CLI interattiva,
317 fini turno su 353 avevano ancora un Workflow, un Agent o un Bash vivo, 25 solo un
Monitor, 11 niente (`evidence/bgwait-4-measure-parent-session.out.txt`). Nel log di
produzione ci sono 382 «[Push] not sent tag=chat-end» e 0 consegne: 382 righe di
campanella scritte per una spinta mai partita (`evidence/D3-…`).

### I difetti, con la prova

Riprodotto = test rosso su `origin/main` f93eeb187 in una worktree staccata, sorgente e
output nel file. Tracciato = catena del codice, nessun test.

| Id | Cosa vedi | Causa | Prova | Chi lo chiude |
|----|-----------|-------|-------|---------------|
| D1, bgwait-1 | Un turno che lascia lavoro in background è «finito»: segno, badge, riga «Claude ha finito di rispondere», spinta | `chat.ts:2530` mette `completed` senza guardare `backgroundOfTurn`, calcolato 37 righe sotto solo per il goal loop | `evidence/D1-bg-work-turn-announced-finished.txt`, `evidence/bgwait-1-chat-stream-end-clean-while-bg.txt` (riprodotto) | ATTN-02, ATTN-05 |
| D2, A, bgwait-2 | Fine turno con Bash, Agent, Workflow o cron in background: fase `awaiting-user`, blu | `WATCH_ARMING_TOOLS = {'Monitor'}` (`claude-session-state.ts:171`) | `evidence/D2-…`, `evidence/sync-A-…`, `evidence/bgwait-2-…` (riprodotto) | ATTN-02, MONITOR-04 |
| bgwait-2 (terminale) | Un terminale che ha avuto un Monitor resta `watching` per sempre | `monitorArmed` è un booleano che per i terminali non si spegne mai | `evidence/bgwait-2-…` (riprodotto) | ATTN-03 |
| BG-1, BG-3, B1, bgwait-3 | Glifo grigio «in background» e fill blu con 1 sulla stessa riga; anche con un Monitor `watching` | `chatFinishedEdge`, `deriveAwaitingFeedbackTopics`, `topicAttentionCount`, `chromeAttentionSubjects` non leggono `backgroundWorkTopics` | `evidence/client-surfaces-disagree.run.txt` A1, A3; `evidence/sync-B-…` D1; `evidence/bgwait-3-…` (riprodotto) | ATTN-01, ATTN-02, ATTN-12 |
| BG-2 | Banner «In attesa di te» per un turno chiuso su lavoro in background, poi un secondo banner | `decideChatFinishedBanner` non ha un ingresso per il background | `client-surfaces-disagree.run.txt` A2 (riprodotto) | ATTN-11 |
| BG-4 | Vista per stato: la chat in background sta sotto «Attende te» | `sidebarItemState` legge `awaitingFeedbackTopics` | A4 (riprodotto) | ATTN-12 |
| D6 | Una chat ferma su una tua domanda ha lo spinner di lavoro, e nessuna spinta di attesa | le domande passano da `mcp__topics__ask_user_question`, la macchina delle fasi conosce solo `AskUserQuestion` | `evidence/D6-…` (riprodotto) | ATTN-04 |
| D8 | Un piano da approvare è annunciato come «ha finito» | `stream:end` porta `completed` anche quando apre il pannello del piano | `chat.ts:2144-2162`, `plan-approval.ts:105-111` (tracciato) | ATTN-04 |
| D7 | Un turno risvegliato vuoto alza il non-letto | `finalizeTurnActivity` gira senza condizioni dopo lo scarto | `evidence/D7-…` (riprodotto) | ATTN-05 |
| D3 | Ogni fine turno, anche della chat che guardi, accende campanella e Dock con una riga di una spinta mai partita | `logSent` senza condizioni, riga nata non vista nello stesso tick; la riga «vista» del client cade nel dedupe | `evidence/D3-…` (riprodotto) | ATTN-06, ATTN-11 |
| D4, F3 | Una card parcheggiata e rimessa in coda resta su campanella e Dock | l'auto-visto dei task esiste solo all'uscita da review | `evidence/D4-…` (riprodotto) | ATTN-04, NOTIF-SEEN-01 |
| D5 | «Congelato…»/«Scongelato…» contano sulla chat che aspetta il suo comando | swap-freeze e riavvio trattenuto scrivono `targetKind: 'topic'` | `evidence/D5-…` (tracciato, 30 «froze» nel log) | ATTN-10 |
| BELL-1, B2, F5 | Chat letta: torna «1» uscendo, campanella e Dock la contano, «segna tutto» non la spegne; un terminale con hook nello stesso stato non conta da nessuna parte | il numero conta la fase `awaiting-user`, che nessuna porta del visto tocca; NOTIF-ONE-02 sc. 4 contraddice NOTIF-ONE-01 | `client-surfaces-disagree.run.txt` B1; `sync-B-…` D2 (riprodotto) | ATTN-05, ATTN-06, NOTIF-ONE-01, NOTIF-ONE-02 |
| TERM-1 | Chat e terminale con hook finiti: menu agenti dice 2, campanella 1 | il numero legge solo `terminalFinishedIds` | C1 (riprodotto) | ATTN-01, CHROME-COUNT-01 |
| TERM-2 | Terminale senza hook finito: la card del gruppo è blu, la sua tab e la sua riga no | `spaceAttentionTier` conta `terminalFinishedIds`, il resto no | D1 di `client-surfaces-disagree` (riprodotto) | ATTN-01, ATTN-12 |
| ARCH-1, B3/C | Chat archiviata con una riga non vista: campanella e Dock a +1, la tray ne elenca N-1 | l'archiviazione non segna viste le righe; il numero non filtra gli archiviati | E1; `evidence/sync-C-…` (riprodotto) | ATTN-13, CHROME-COUNT-01 |
| B4 | Letta sul Mac, resta blu nell'altra finestra e sul telefono; un ricarico riaccende ogni chat letta | `seenSubjects` in memoria per finestra, nessun frame lo scrive | `sync-B-…` D4 (riprodotto) | ATTN-06, ATTN-07 |
| D (focus) | Con «notifica anche se a fuoco» spento, la chat con hook che guardi suona lo stesso | `topicIdFromPanel` accetta solo `chat:<id>` | `evidence/sync-D-…` (riprodotto) | ATTN-11 |
| E | Guardare un terminale senza righe non spegne il suo segno nelle altre finestre | `markTargetSeenAndAnnounce` non annuncia se non ha cambiato righe | `evidence/sync-E-…` (riprodotto) | ATTN-06 |
| F1 | Dopo il sonno, campanella e badge PWA restano quelli di prima | la campanella si rilegge solo al montaggio e all'apertura | `sync-F-…` §F1 (tracciato) | ATTN-07 |
| F2 | Banner col nome di una chat archiviata, e niente in campanella | il ramo `session:state` del notifier non guarda `archived` | §F2 (tracciato) | ATTN-01, ATTN-11 |
| WIN-1, F4 | Dock e tray cambiano valore a seconda della finestra che ha scritto per ultima | ogni finestra chiama `set_app_status` con il numero delle sue memorie | `useTabNotifications.tsx:203-210`, `lib.rs:3005` (tracciato, sospetto per F4) | ATTN-08 |

### Le altre change e le spec

- `notifications`: CHAT-DONE-01 e NOTIF-ONE-02 scenario 4 assumono un segno per finestra e
  una fase che conta senza visto; vanno riscritti. NOTIF-ONE-01, CHROME-COUNT-01 e
  NOTIF-SEEN-01 cambiano fonte (lo stato di attenzione al posto delle righe). Gli altri
  requisiti (TAB-BADGE, MUTE, UNREAD, PUSH, QUIET, SEEN-ANY-FOCUS) restano e si leggono
  sopra lo stato nuovo: la «fine pulita» di PUSH-04 e CHAT-DONE-02 è l'ingresso in `finished`.
- `claude-sessions` MONITOR-04: `watching` vale per qualunque lavoro in background, non
  solo per Monitor.
- `human-wait` HOLD-01…05: invariati. Questa change aggiunge un secondo ascoltatore degli
  eventi di attesa (lo stato di attenzione) accanto al dispatcher.

## What changes

- **Server**: un modulo `server/attention/` compone lo stato per soggetto (funzione pura),
  lo salva con epoca e visto in una tabella nuova, lo manda con `attention:init` e
  `attention:updated`, e decide da lì riga di cronologia, banner e spinta. `stream:end`
  porta `background`. La macchina delle fasi tiene i compiti in background per id.
  `push-triggers` smette di annusare ogni frame dentro `broadcastToAll`.
- **Client**: uno store di attenzione alimentato solo da quei due frame; ogni superficie ne
  deriva con le stesse due funzioni (`attentionOf`, `rollupAttention`). Il notifier dei
  banner reagisce solo alle transizioni. La finestra principale scrive il Dock.
- **La campanella** diventa la inbox (scelta 4).

## Non-goals

- Riscrivere la porta dei non-letti o il loro conteggio per messaggio sulle righe.
- Cambiare come la board mostra review e parcheggio sulle card.
- Notifiche per eventi che oggi non ne hanno (commit, CI, menzioni).

## Impact

Server: nuovo `server/attention/` (`compose.ts`, `store.ts`, `wire.ts`), migration
`server/db/migrations/<ts>-subject-attention.sql` (solo `CREATE TABLE`),
`routes/chat.ts` (`background` su `stream:end`, `finalizeTurnActivity` solo con un
messaggio), `lib/claude-session-state.ts` e `lib/claude-session-tracker.ts` (compiti in
background per id), `push-triggers.ts` (ascolta le transizioni), `notification-registry.ts`
e `subject-seen.ts` (porta del visto per epoca), `services/archive-topic.ts`,
`services/tasks.ts`, `server.ts` (frame `focus` con soggetto e veglia, avvisi di swap e
riavvio come «Sistema», istantanea all'apertura), `routes/notifications.ts`,
`lib/grants.ts` (i frame nuovi restano fuori dagli ospiti).

Client: nuovo `state/attention.ts` (store e selettori), `state/useSignalsSync.ts`,
`state/signals.ts`, `state/attentionTotal.ts`, `hooks/useTabNotifications.tsx`,
`hooks/useCompletionNotifier.tsx`, `lib/notify/chatFinished.ts`, `lib/notify/paneSeen.ts`,
`components/Sidebar/NotificationHistoryButton.tsx` (diventa `Inbox`), `TopicItem.tsx`,
`TopicTree.tsx`, `PaneTabBar.tsx`, `TabSlot.tsx`, `useSpaceCards.ts`,
`lib/buildSidebarItems.ts`, i18n.

Desktop: `desktop-tauri/src-tauri/src/lib.rs` (`set_app_status` accettato solo dalla
finestra principale).

Specs: `notifications` (ATTN-01…13 aggiunti; CHAT-DONE-01, NOTIF-ONE-01, NOTIF-ONE-02,
CHROME-COUNT-01, NOTIF-SEEN-01 modificati), `claude-sessions` (MONITOR-04 modificato).
