# Hub in Topics, traccia R4: esito

Il codice sta nel repo dell'hub (come R1): crate `tools/usage-hub/rust/hub-service`, ramo `topics/r4-proxy`, commit `d1258dc0`, sopra `1cc2ad47` di R1. Nessun servizio vivo toccato: il binario rifiuta ancora 3336, 3335 e 3360, e ogni prova gira su porte alte contro `fake-anthropic`, con account e token inventati in una cartella temporanea.

## Barra: `sh bar-r4.sh`, exit 0

- `cargo test`: 22 test verdi (logica di `lib.mjs`, header, identità Claude Code, refresh, impostazioni).
- Header inoltrati uguali a `buildForwardHeaders` di `lib.mjs`, eseguito con node sullo stesso ingresso: 9 header su 9, blocco d'identità per primo, query conservata.
- 100 richieste `/v1/messages` in parallelo, metà in streaming: 100 su 100, ogni SSE completo, 0,4 s.
- 429 sull'account attivo: servito dal successivo, evento `auto-switch`. 20 richieste insieme su un token scaduto: 20 risposte 200 con **una** chiamata OAuth (il servizio di oggi ne farebbe una per richiesta, in fila).
- Fail-open: proxy spento, nessun account, account illeggibili: la richiesta passa dritta con le credenziali del chiamante.
- Scrittore unico: un secondo servizio sulla stessa cartella di stato rifiuta di partire (exit 1); `r4-bench --writer-check` vede uno scrittore, e due con un processo estraneo che apre un file in scrittura (mutazione, exit 1).
- `golden-diff` sulle 7 fotografie di `:3336` e `:3335` (sessioni escluse, vedi sotto): 7 uguali; una fotografia alterata fa uscire 1.
- Footprint fisico (`footprint -p`): 1,3 MB a vuoto; 10 minuti sotto carico (un messaggio ogni 250 ms, uno su due in streaming, le API interrogate ogni 60 s): 1916 messaggi su 1916, massimo 3,2 MB contro il limite di 60 MB (oggi hub 204 MB più switchboard 71 MB).

## Cosa vale il confronto con le fotografie

Il servizio Node non si può avviare sul banco senza leggere e scrivere il Keychain vero (`/api/switch` e la rotazione scrivono le credenziali attive), quindi il confronto vecchio contro nuovo sullo stesso stato non c'è. Il `golden-diff` confronta le fotografie vive con il servizio nuovo su uno stato costruito per attraversare gli stessi casi (account scaduto, refresh rifiutato, 429, sonda dei limiti, cap per account): prova le chiavi e i tipi, non i valori.

## Non portato (in R4 non c'era o resta per C1)

- Backend Keychain delle credenziali attive: sul banco sono un file della cartella di stato. Va scritto in C1, prima dello scambio.
- Scoperta automatica di un login nuovo (`account-discovered`), modalità `balance` e coda di serializzazione (`balance` sceglie come le altre strategie), blocchi per modello (`model-blocks.json`: un 429 su un modello ferma l'account intero), account a chiave API come ripiego, rotta OpenAI `/chat/completions`, monitor delle sessioni con riassunti Haiku (`/api/sessions`), `/api/remove`, `/api/api-profiles`, `/api/logs/stream`, hook git dei token, notifiche desktop. Rispondono 501.

## Trovato strada facendo

Col proxy spento la sessione non cade su Anthropic: `ANTHROPIC_BASE_URL` punta a `127.0.0.1:3336` in `settings.json` e nel profilo della shell, e senza nessuno in ascolto Claude Code riceve ECONNREFUSED. Il fail-open di oggi esiste solo dentro il proxy. Lo scambio di C1 deve tenerne conto (riavvio automatico del servizio, o un ripiego lato chiamante).

Card: 6d7717c3-3a68-4e41-a3d6-aed0227553f5.
