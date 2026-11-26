# Regole del motore

Ogni regola ha un numero: le tracce e i test la citano. Dove una regola nasce da un rilievo della verifica del 20/11, il file:riga è quello che il verificatore ha letto.

## Nucleo
**R1. Modello.** Tabelle `scheduled_jobs` e `scheduled_job_runs`. Un lavoro: `id, name, project_id?, schedule, action, deliver?, policy, enabled, next_run_at, created_by`. `schedule` = `cron {expr, tz}` | `every {minutes}` | `at {at}`; il fuso è sempre scritto sul lavoro, quello di default è un'impostazione. `action` = `card` | `command` | `agent`.

**R2. Un solo calcolo degli orari** in `shared/schedule.ts`: il parser a 5 campi che c'è in `scheduled-cards.ts`, più `every` e `at`. Lo usano server, client (anteprima delle prossime occorrenze) e validazione. Nessuna dipendenza nuova.

**R3. Chi decide.** Il server primario, a ogni tick (15 s). Il timer del motore si ferma PER PRIMO in `gracefulShutdown` (oggi quello delle card non si ferma mai: `boot/dispatcher.ts:474` non compare in `timers-shutdown.ts:122-133`). Il tick scrive il suo battito (`last_tick_at`).

**R4. Stati del giro.** `pending` (occorrenza presa, azione non partita) → `starting` → `running` → `ok | error | timeout | cancelled`; senza azione: `skipped | missed`; lancio fallito: `failed_to_start`; processo perso: `interrupted`. Da `pending` a `starting` si passa solo con `UPDATE … WHERE status='pending'` e una riga cambiata: due tick, o un server vecchio rimasto vivo accanto al nuovo, non lanciano due volte. Le righe `pending` e `starting` le fa avanzare OGNI tick, non solo il boot. Una `starting` senza riferimento al processo o al turno oltre un minuto diventa `failed_to_start` e non blocca le occorrenze dopo.

**R5. Chiave d'occorrenza** = istante UTC di `scheduled_for`. Indice unico `(job_id, occurrence_key)`, inserimento con `ON CONFLICT DO NOTHING`, e `next_run_at` si sposta SEMPRE (mai un rollback che riprova all'infinito). L'ora ripetuta del cambio d'ora si scarta con un controllo esplicito sull'ora locale, prima dell'inserimento. «Esegui subito» ha chiave `manual:<uuid>` e non sposta `next_run_at`. Il rilancio di R12 ha chiave `<chiave>#r1`.

**R6. «In corso» si legge dalla cosa vera**, non dalla riga: il gruppo di processi per un comando, il turno aperto della chat per un agente, la card ancora aperta per una card.

## Occorrenze perse
**R7. Al massimo una occorrenza in attesa per lavoro.** Le altre perse diventano UNA riga `missed` col conteggio e la causa: `down | stall | provider | cap | paused`.

**R8. Finestre per azione e causa** (default, modificabili per lavoro):
- `card`: sempre un recupero, anche dopo settimane (come oggi).
- `command` a cron: l'ultima occorrenza entro 6 ore.
- `at`: 24 ore, una volta, solo se mai partito. Un `at` nel passato si rifiuta alla creazione.
- `every N`: `next = scheduled_for + N` (non `started_at + N`: niente deriva del tick). In ritardo al boot → un solo giro subito. Dopo `missed` o `skipped` il prossimo è il primo slot dopo adesso. Primo giro di un lavoro nuovo: creazione + min(N, 5 minuti).
- `agent` ricorrente fermo per quota o freno: finestra zero, riga `skipped`, il prossimo parte al suo orario (un brief delle 7:30 non parte alle 11). Un `at` con agente invece aspetta, fino a 12 ore.

**R9. Sovrapposizione.** Lavoro ancora in corso alla scadenza: l'occorrenza si salta (`skipped`, causa `overlap`). Per `every`: appena il giro finisce, se il prossimo è già scaduto parte subito.

**R10. Tetto di giri contemporanei**, per comandi e per turni di agente (impostazioni con default): dopo un fermo le occorrenze in finestra partono a scaglioni, non tutte al primo tick.

## Comandi
**R11. Stesso registro dei processi, terza origine `job`** (`routes/processes-commands.ts`). Serve: un involucro che prende argv e scrive il file del codice d'uscita; stdin dal testo del lavoro; stderr in un file suo; niente `followOf`; righe `job` protette in `trimRecent` e chiuse alla creazione del router come i giri di una persona; file stderr compreso nello sweep; processi di un lavoro esclusi da `list_processes` e Stop degli agenti. A comando finito il gruppo riceve SIGHUP. Ambiente: la base degli agenti più le variabili del lavoro, più `TOPICS_JOB_ID` e `TOPICS_JOB_RUN_ID`.

**R12. Riaggancio al boot.** Testimone di vita = identità del gruppo di processi (`processGroupIdentityMatches`, `processGroupAlive`), non `ps -o lstart` con 3 s di tempo (`processes-persist.ts:79-115`: sotto swap un comando vivo risulta morto). Si riconciliano anche i gruppi che `scripts.json` non conosce. Vivo o con codice scritto → il giro si riaggancia e si chiude una volta. Provato morto senza codice → `interrupted` (non è un errore) e UN rilancio, col contatore scritto in SQLite prima; mai se il lavoro è marcato non ripetibile.

**R13. Tempo massimo** di default 3600 s, sempre scritto sul lavoro. Lo applica il motore al tick E l'involucro stesso, così vale anche a loop fermo. Prima di fermare si scrive `timeout` in SQLite. È un errore; l'uscita parziale non si consegna.

**R14. Storia.** Alla chiusura la coda di stdout e di stderr va in SQLite. Si consegnano i primi 4000 caratteri di stdout. La storia dei giri resta 30 giorni.

## Agenti
**R15. Un turno dalla porta della chat, iniettata all'avvio** (come `route` in `process-exit-wake`): il motore non importa lo strato HTTP. Chiave anti-doppione `job:<id>:<chiave>`. La chat del lavoro NON nasce con `initialMessage` (manda senza chiave, come una persona) e il suo id si salva nella transazione del giro.

**R16. Segno del turno**: un tipo nuovo `scheduled-job`, escluso da `sentByPerson` (`routes/chat.ts:838`), presente nei segni della riga e nel filtro del conto per persona; la copia fatta dalla ripresa al boot lo eredita.

**R17. Regole del turno** (blocco generico iniettato, senza nomi di persone): tre esiti dal testo finale, fatto / niente da dire = finisce con `NO_REPLY` / non riuscito = prima riga `AUTOMATION_FAILED`; dove va una domanda per il proprietario; niente lavoro in background con risveglio, perché il giro si giudica dal testo finale. `AUTOMATION_FAILED` → giro in errore, il testo parte lo stesso.

**R18. Riavvio a metà turno.** Lo stato si legge dalla chat: turno aperto o in ripresa → si aspetta; altrimenti l'ultima fine registrata chiude il giro. La catena delle copie della ripresa si segue (`resendOf`). `409 stream_in_flight` sulla chat del lavoro = sovrapposizione (R9).

**R19. Guasto passeggero** (rete, provider giù, riavvio): ritento dopo 5, 15 e 45 minuti, mai oltre il giro successivo, senza scrivere errori. Tetto di durata del turno per lavoro; allo scadere il turno si ferma e il giro è `timeout`.

**R20. Chat.** Per lavoro: `fresh` (contesto nuovo a ogni giro, default dei lavori nuovi) o `keep` (stessa chat). La chat di un `at` riuscito e senza domande aperte si archivia; così quella di un lavoro spento o cancellato.

## Consegna e avvisi
**R21. Un adattatore solo**: impostazione dell'app con ripiego sulla variabile `TOPICS_OWNER_ALERT_COMMAND` (già decisa nella change `limiti-consumo-progetto`). È un comando come lista di argomenti più variabili d'ambiente, coi segnaposto `{channel} {chat} {thread} {title} {jobId} {runId} {key}`; testo su stdin; un argomento che resta vuoto toglie la coppia opzione+valore; l'eseguibile si risolve con percorso assoluto. Vuoto di default: l'esito resta in Topics. Una destinazione `owner` viene dall'impostazione «avvisi del proprietario».

**R22. Cosa parte.** Stdout del comando o risposta finale dell'agente. Vuoto o `NO_REPLY` → niente. Codice diverso da zero → errore, stdout parte lo stesso; stderr mai. La riga `AUTOMATION_FAILED` non si consegna. Un comando fallito senza uscita dice una riga sola, e solo se il giro prima era andato bene.

**R23. Una volta sola.** Si scrive `delivering` prima di chiamare l'adattatore e gli si passa `{key}` (= id del giro). Si ritenta solo se l'adattatore esce non-zero, 3 volte; un invio che può essere partito non si ripete.

**R24. Avviso di guasto.** Tre errori di fila → un avviso al giorno per lavoro, rimandato al mattino nelle ore di silenzio. `skipped`, `missed` e `interrupted` non sono errori e non toccano la serie. In campanella è una riga con soggetto suo (`job:<id>`), che entra nei conteggi: una riga di sistema non la vede nessuno (`attention/system-notices.ts:8-11`).

## Porte e freni
**R25. API** `/api/scheduled-jobs`: elenco, crea (anche con id e stato iniziale dati), modifica, cancella, esegui subito, giri. Cancellare un lavoro con un giro in corso lo ferma (`cancelled`, niente consegna). Gli ospiti non ci arrivano.

**R26. Agenti.** Strumenti per creare, elencare, eseguire, mettere in pausa, cancellare. Impostazione `ask | auto`, default `ask`: il lavoro nasce in pausa e chiede conferma in campanella. Un lavoro con consegna creato da un agente nasce sempre in pausa. Non è un confine di sicurezza: un agente ha già una shell.

**R27. Freni in un posto solo.** Per l'azione `agent` il motore chiama `dispatchBrakes()` filtrata per provider (`lib/provider-hold.ts:403-417`), non `isProviderHeld`: un lavoro programmato rispetta il muro della board e il freno anticipato, cioè non spende la riserva della persona. Il progetto in pausa (card 79ab687d) e il tetto di R10 si aggiungono lì.

**R28. Fermare le partenze.** Il motore ha pausa e ripresa delle partenze, usate dallo spegnimento e dal riavvio pianificato; le righe `starting` contano come lavoro in volo.

## Processi
**R29. Dove servono ci sono già.** I comandi girano fuori dal server; i canali nel loro servizio. Chi decide resta nel server. Il registro dei processi è di UN processo solo: un motore in un processo a parte dovrebbe chiedere al server di lanciare o avere un registro suo, quindi separarlo è un lavoro, non un cambio di avvio.

**R30. Quando separare lo dicono i numeri.** Con `last_tick_at` e la causa di ogni `missed`: si separa se compare un `missed` con causa `stall`, o se più dell'1% dei giri che potevano partire parte con oltre 2 minuti di ritardo in 7 giorni.

## Passaggio dal motore esterno
**R31. L'importatore sta fuori dal prodotto**: uno script una tantum che parla con l'API (R25). Scrive fuso e tempo massimo espliciti, copia le variabili d'ambiente che servono, risolve la destinazione simbolica nel proprietario, porta per ogni lavoro l'ultimo inizio e l'ultima occorrenza servita. `next_run_at` parte da adesso. Un `at` che ha già girato arriva spento.

**R32. Parità degli orari.** Prima del passaggio si confrontano, per ogni espressione cron, le prossime 20 occorrenze del motore vecchio e del nuovo. Il modo ombra scrive righe `would_run` senza eseguire; «divergono» vale solo per gli istanti pianificati dei cron, con 60 s di tolleranza.

**R33. Mai in due motori, mai in nessuno.** Passaggio e ritorno: si fermano le partenze del motore vecchio, il lavoro si TOGLIE dal suo file (non si mette in pausa: le rotte vecchie lo riaccenderebbero), si aspetta oltre il suo tempo di rilettura, poi si accende di qua. Il ritorno scrive nel registro del motore vecchio i giri fatti di qua, prima di riaccenderlo. Finché convivono, le rotte vecchie rifiutano gli id che sono di Topics e la vista mostra ogni id una volta.

**R34. Dopo.** Si tolgono `routes/cron.ts`, la scrittura dei lavori in `agent-config.ts`, la copia dei giri esterni, e il codice vecchio delle card programmate.

## Regola del prodotto
Niente nomi, percorsi, account, canali o servizi di una persona nel codice. La vista Automazioni funziona anche senza l'hub personale: i lavori di Topics si leggono da `/api/scheduled-jobs`.
