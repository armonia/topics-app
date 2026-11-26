# Tracce

Lo stato di una traccia lo dà git e il suo test, non una casella. Ogni traccia è una card della board e una PR. Le regole citate (R…) stanno in `design.md`, le barre in `specs/acceptance.md`.

## T1 Nucleo: un motore, gli stati del giro, le card programmate come primo tipo di lavoro
Regole R1–R10. Tabelle nuove con la migrazione che copia `scheduled_cards` e `scheduled_card_instances`; `shared/schedule.ts`; motore col tick, gli stati e le finestre; azione `card` con la card creata nella stessa transazione del giro; timer fermato per primo allo spegnimento; `last_tick_at`. Spariscono il parser privato e il servizio vecchio delle card; il controllo sulla board continua a funzionare.
Dipende da: niente.

## T2 Comandi e API
Regole R11–R14, R25, R28. Azione `command` sul registro dei processi con origine `job`; API `/api/scheduled-jobs`.
Dipende da: T1.

## T3 Consegna, avvisi, strumenti per gli agenti
Regole R21–R24, R26. Adattatore unico con ripiego su `TOPICS_OWNER_ALERT_COMMAND`; riga in campanella con soggetto suo; strumenti MCP. Scrive nella spec dove sta la consegna di un lavoro rispetto a OUTBOUND-03.
Dipende da: T2.

## T4 Agenti: turno, segno, esito dal testo, riavvio
Regole R15–R18, R20.
Dipende da: T3.

## T5 Agenti: ritenti, tetto di tempo, freni della board
Regole R19, R27.
Dipende da: T4.

## T6 Interfaccia: creare e seguire un lavoro
Vista Automazioni: creare e modificare un lavoro (orario con anteprima delle prossime occorrenze, azione, consegna, progetto), storia dei giri con esito, durata, causa di un giro saltato, «esegui subito», pausa. Funziona senza hub. A vista.
Dipende da: T2.

## T7 Passaggio: quello che serve dentro Topics
Regole R32, R33 per la parte di Topics: modo ombra (`would_run`), rotte vecchie che rifiutano gli id di Topics, ogni id una volta nella vista.
Dipende da: T5.

## T8 Pulizia dopo il passaggio
Regola R34. Parte solo quando nessun lavoro gira più nel motore esterno.
Dipende da: T7 e dal passaggio fatto.

## Fuori da questo repo (servizio dei canali)
- Invio con chiave anti-doppione, uscita non-zero quando le regole d'uscita fermano il messaggio, opzione «non è l'invio di un turno». Serve a T3 per consegnare una volta sola.
- Importatore, confronto degli orari, sequenza di passaggio e di ritorno (R31–R33); i comandi `cron-*` che restano diventano client dell'API di Topics, con lo stesso formato d'uscita di oggi.
- Togliere il motore cron dal servizio, dopo T8.
