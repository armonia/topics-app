# D5d — Domanda a lato

## Giro 4 (la e2e, il finto CLI)

**Barra prima:** clip CI `38673960214` rossa, ma col prodotto del giro 3 che fa la cosa giusta: nel trace del secondo tentativo il pannello mostra una risposta, `MAIN-ANSWER-PROBE` invece di `SIDE-ANSWER-PROBE`, e il fork si cancella dopo la risposta (DELETE 200). Il primo tentativo cade prima, a «main-hold» (`streamingIndicator` mai visto).

**Causa:** `tests/e2e/helpers/fake-claude-btw.ts` leggeva la domanda solo dai blocchi (`content` array). Un messaggio normale arriva al CLI come stringa (`buildUserTurnContent`, i blocchi solo con uno slash context), quindi il finto vedeva sempre una domanda vuota: rispondeva `MAIN-ANSWER-PROBE` anche al fork, e «main-hold» non tratteneva mai il turno (l'indicatore era un lampo che la e2e prendeva o no). Gli altri finti (`fake-claude-queue-turns.ts` e i fratelli) leggono già tutte e due le forme.

**Correzione:** il finto legge la stringa e i blocchi. `bun run typecheck:e2e` exit 0. La clip rifatta è la barra.

## Giro 3

**Barra prima:** e2e CI run `38672203747` rossa: `POST /side-question` 201, fork avviato, poi DELETE dopo 34 ms; il client leggeva prima della chiusura del turno. Mutazione in `/private/tmp/d5d-giro3-mutation` con l’implementazione del giro 2: `bun test /private/tmp/d5d-giro3-mutation/sideQuestion.test.ts` exit 1 atteso, 0 pass e 1 fail (`no-answer` prima che arrivasse la risposta).

**Barra dopo:** `bun test client/src/components/Chat/sideQuestion.test.ts` exit 0, 4 pass e 15 asserzioni; `bun run typecheck` exit 0, 5/5; `bun run lint` exit 0, 4 warning preesistenti; `bun run check:bloat` exit 0; `git diff --check` exit 0. `ChatPane.tsx`: 2179 righe, tetto 2212.

### Fatto

- `/btw` si sottoscrive al registro turni e allo store della sessione; dopo l’invio accettato aspetta la chiusura del turno e mostra l’ultimo messaggio assistente non parziale aggiunto in quel turno. Turno chiuso senza testo produce `no-answer`.
- La chiusura del pannello abortisce l’attesa e rimuove entrambi gli ascoltatori. `runSideQuestionFork` garantisce una sola cancellazione del fork; test: 0 ascoltatori rimasti, 1 chiamata di chiusura.
- Tetto scelto: 120 secondi sull’intera richiesta, cronologia e invio compresi. Una richiesta oltre il limite si traduce in `no-answer`, così il cleanup esistente può cancellare il fork.

### Trovato e non fatto

- E2E browser/video non rilanciata localmente, come stabilito dal brief; la rilancia la CI. La run 38672203747 è la prova del difetto iniziale.

### Rifiutato

- Nessun altro difetto nello scope; ChatPane non è stato modificato e resta sotto il tetto.

## Giro 2

**Barra prima:** 0/4 requisiti del giro 2 dimostrati; il working tree conteneva il giro 1. I comandi non erano stati eseguiti prima di iniziare questo giro.

**Barra dopo:** `bun test server/lib/side-question.test.ts server/routes/fork.side-question.test.ts server/lib/chat-fork.test.ts client/src/components/Chat/sideQuestion.test.ts client/src/components/Chat/slashCommandRouting.test.ts client/src/components/Chat/slashCommands.i18n.test.ts` exit 0, 67 pass e 359 asserzioni; `bun run typecheck` exit 0, 5/5 compreso `typecheck:e2e`; `bun run typecheck:e2e` exit 0; `bun run lint` exit 0, 4 warning preesistenti; `git diff --check` exit 0. Mutazione in copia che salta la cancellazione di `messages`: test rosso, 1 pass e 1 fail, exit 1 atteso. E2E browser/video demandata alla CI.

### Fatto

- Una sola `deleteSideQuestion` elimina il transcript CLI e tutte le righe SQLite collegate a id, sessionKey o soggetto, incluse `messages`, `chat_forks`, unread, attività, `subject_attention` e notifiche per target/gruppo. DELETE e pulizia automatica usano la stessa funzione.
- La pulizia parte alla creazione del router (avvio server) e prima di ogni nuova domanda: elimina i rami oltre 10 minuti senza turno attivo; i test confermano che quello di 2 minuti e quello con turno attivo restano.
- La biforcazione a lato non copia messaggi; conserva il riferimento al messaggio di origine in `chat_forks`. Transcript assente o punto non corrispondente produce 409 con motivo, mostrato nel pannello. Il test verifica zero messaggi nella sessione laterale.
- `isSideQuestionTopicId` è condiviso da lista, incremento unread, activity bump e ingresso/uscita dell'attenzione. Questi erano i percorsi trovati che avrebbero prodotto indicatori, notifiche in app o push.
- Il testo d'errore usa `DANGER_TEXT`, la coppia cromatica del tema già adottata dai chip di stato.

### Trovato e non fatto

- E2E con video non eseguita localmente, come impone il brief. La spec del giro 1 passa `typecheck:e2e`; la CI «Clip di consegna» deve fornire il video.

### Rifiutato

- Nessun altro segnale persistente o laterale è emerso nell'audit dei call site.

## Giro 1 (stato già presente)

**Barra prima:** `/btw` assente; 0/3 invarianti; nessun pannello o turno effimero. Baseline `bun run typecheck` e `bun run lint` exit 0; il test preesistente del fork aveva 1 errore di permesso scrivendo sotto HOME. Con HOME isolata, il test passa.

**Barra dopo:** test mirati exit 0, 135 pass, 756 assert; `bun run typecheck` exit 0 (5/5, incluso `typecheck:e2e`); `bun run lint` exit 0 (4 warning client già presenti); `git diff --check` exit 0. La mutazione in copia che invia la risposta al transcript principale è stata rilevata: 1 pass, 1 fail, exit 1 atteso. Spec E2E tipizzata, prova browser/video demandata alla CI come richiesto.

## Fatto

- `/btw <domanda>` è disponibile solo per Claude Code. Apre un pannello laterale chiudibile, usa il contesto fino all'ultima risposta completata e mostra lì la risposta; il turno principale può continuare senza interruzioni o accodare la domanda.
- Il backend crea una biforcazione `--fork-session` con sessione temporanea distinta, mai `--resume` sulla sessione principale. Alla chiusura elimina il transcript CLI temporaneo e il topic nascosto; gli ID `side-question-` sono esclusi dalla lista chat anche dopo un reload.
- Spec CMD-10 e scenari aggiunti. I test coprono transcript principale invariato e comando assente per provider non supportati. L'E2E verifica risposta laterale, conteggio messaggi via DOM e API, turno principale attivo e argomenti di fork.

## Trovato e non fatto

- E2E browser con video non eseguita localmente, come stabilito dal brief; `bun run typecheck:e2e` è verde. Resta la prova video in CI.
- Il primo test baseline ha incontrato `EPERM` nel tentativo di scrivere sotto HOME; rieseguito con HOME isolata, il test del fork passa.

## Rifiutato

- Nessun provider oltre Claude Code, cronologia delle domande a lato, commit o push: fuori ambito o vietati dal brief.
