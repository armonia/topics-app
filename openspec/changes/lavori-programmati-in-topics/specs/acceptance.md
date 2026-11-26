# Acceptance: lavori-programmati-in-topics

Ogni barra è un comando che esce non-zero se la regola non vale. I test girano con un orologio finto e, dove serve, su due motori aperti sullo stesso file SQLite.

## T1 Nucleo
`bun test shared/schedule.test.ts server/schedule` esce 0 e copre:
- orari: cron a 5 campi con fuso, i due cambi d'ora (ora ripetuta: un giro solo; ora che non esiste: nessun giro inventato) in due fusi diversi; `every` senza deriva (`next = scheduled_for + N` su 100 giri con tick in ritardo); `at`; `at` nel passato rifiutato (R2, R5, R8);
- lancio una volta sola: due motori sullo stesso DB fanno avanzare lo stesso lavoro, ne esce UN giro (R4);
- stati: lancio che fallisce → `failed_to_start`, e l'occorrenza dopo parte lo stesso (R4);
- occorrenze perse: fermo di 3 ore → un giro per un cron dentro le 6 ore, una riga `missed` col conteggio e la causa per un `every 10`, e poi il lavoro riparte (R7, R8);
- sovrapposizione: `skipped`; un `every` che sfora riparte appena finito (R9);
- tetto: 20 lavori scaduti insieme partono a scaglioni (R10);
- card: tre settimane di fermo creano una card sola; card precedente aperta → saltata; card e giro nella stessa transazione (R6, R8).
Mutazioni: tolto il `WHERE status='pending'` dal passaggio a `starting`, il test dei due motori è rosso; con `next = started_at + N` il test della deriva è rosso.
Migrazione: un test la esegue su un DB sintetico con righe in `scheduled_cards` e `scheduled_card_instances` e ritrova gli stessi lavori e la stessa prossima occorrenza.
Spegnimento: un test prova che dopo l'inizio di `gracefulShutdown` nessun giro nuovo parte (R3).
Ciò che è verde resta verde: `tests/e2e/board-scheduled-cards.spec.ts` e `tests/integration/primary-role-two-servers.test.ts` passano; la prova a due server legge `scheduled_job_runs` del secondo server, non una colonna che il motore nuovo non scrive.
`openspec validate lavori-programmati-in-topics` esce 0.

## T2 Comandi e API
`bun test server/schedule/command` esce 0 con comandi veri e brevi:
- esito, stdout e stderr separati e salvati, stdin consegnato, variabili del lavoro presenti (R11, R14);
- tempo massimo: il comando viene fermato, il giro è `timeout`, scritto prima dello stop; un comando senza tempo massimo non si può creare (R13);
- riaggancio: un motore nuovo sullo stesso stato adotta un comando vivo e lo chiude una volta; uno provato morto senza codice diventa `interrupted` e riparte UNA volta; con la sonda di vita che non risponde il comando NON viene rilanciato (R12);
- un gruppo registrato ma assente da `scripts.json` viene riconciliato (R12);
- cancellare un lavoro col giro in corso lo ferma, `cancelled` (R25).
Mutazione: con `ps -o lstart` al posto dell'identità del gruppo, il test della sonda che non risponde è rosso.
`bun test server/routes/scheduled-jobs.test.ts`: crea, modifica, cancella, esegui subito, giri; un ospite riceve 403.
`run_command` e il Run di una persona restano verdi dai loro test.

## T3 Consegna e avvisi
`bun test server/schedule/deliver` esce 0 con un adattatore finto che registra argomenti, stdin e ambiente:
- parte stdout, una volta, con la chiave; vuoto e `NO_REPLY` non partono; stderr mai; codice non-zero → errore e stdout parte (R22);
- argomento vuoto → coppia opzione+valore tolta; destinazione `owner` dall'impostazione (R21);
- adattatore che esce non-zero → tre tentativi poi `delivery_failed`; riavvio fra invio e registrazione → nessun secondo invio (R23);
- nessun adattatore configurato → nessun processo, il giro dice «non consegnato»;
- tre errori di fila → un avviso, non due nello stesso giorno, rimandato nelle ore di silenzio; `skipped` in mezzo non tocca la serie (R24).
Mutazione: tolto lo stato `delivering`, il test del riavvio è rosso.
La riga in campanella ha un soggetto e compare nel conteggio (test sul modulo dell'attenzione).

## T4 e T5 Agenti
`bun test server/schedule/agent` esce 0 con la porta della chat finta:
- un turno per occorrenza anche con due tick; la copia della ripresa al boot non apre un secondo giro e il giro si chiude con l'esito della copia (R15, R18);
- il turno non conta come persona: non chiude le domande aperte, non entra nel conto per persona come messaggio umano (R16);
- `AUTOMATION_FAILED` in prima riga → errore, testo consegnato; `NO_REPLY` in fondo → niente consegna (R17);
- guasto passeggero → ritento a 5, 15, 45 minuti, nessun errore scritto, mai oltre il giro dopo (R19);
- freno della board attivo → ricorrente `skipped`, `at` in attesa (R8, R27);
- `at` riuscito → chat archiviata (R20).
Mutazione: con `isProviderHeld` al posto di `dispatchBrakes()` il test del freno della board è rosso.

## T6 Interfaccia
Scenario e2e con video: `tests/e2e/scheduled-jobs.spec.ts`. Senza hub configurato: creare un lavoro a comando dalla vista, vedere le prossime tre occorrenze cambiare con l'orario, farlo scattare con l'orologio di prova, leggere esito e uscita nella storia, metterlo in pausa, eseguirlo subito, cancellarlo. Controllo di accessibilità sulla vista. Foto a 375, 768 e 1440 px accanto alla vista di prima.

## T7 e T8 Passaggio e pulizia
`bun test server/schedule/shadow`: un lavoro in ombra scrive `would_run` e non lancia niente; le rotte vecchie rifiutano un id che è di Topics.
Dopo T8: `/usr/bin/grep -rn "cron list\|cron enable\|cron run" server` non trova niente, e `bun test` dei file toccati resta verde.
