# T19 — la coda del turno non si perde: un figlio che esce mentre siamo staccati, e la riadozione sotto scrittura

**GOAL.** Due buchi che T18 ha trovato e lasciato, sullo stesso percorso (chat `claude-code` via il demone
`ai-bridge`), con la stessa conseguenza per Attilio: una risposta che manca anche dopo un «aggiorna».

1. **Il figlio esce mentre il server è staccato.** L'`exit` del demone è un broadcast e arriva anche a chi non
   è attaccato, quindi `onSessionClosed` (`server/providers/claude-code.ts`) chiude il turno; ma i byte scritti
   dopo il distacco (il `result`, il testo finale) non sono mai stati piegati, e la riga nel DB resta senza.
   La sonda di T18 (`probeStreamLag`) guarda solo i figli vivi, quindi qui non arriva.
2. **La fase 2 della riadozione** (server riavviato, turno riadottato) riattacca da un offset più basso mentre
   l'attacco dello scan è ancora vivo: i frame dal vivo arrivati fra lo scan e la fase 2 possono essere
   ripiegati dal replay (lì il riavvolgimento è voluto e la guardia di `onData` di T18 lo lascia passare).
   T18 non l'ha riprodotto.
3. **Una riadozione fallita lascia il cursore dove si è fermato lo scan** (trovato dal verificatore di T18, non
   riprodotto). `finalizeFailedReattach` tiene il processo vivo e nella mappa apposta, perché il riaggancio
   alla riconnessione lo guarisca da solo. Però `consumedOffset` resta dove lo scan muto si è fermato, anche 0, e
   i flag di replay sono spenti. Un riattacco da lì (il riaggancio prima di T18, ora anche la sonda entro ~8 s)
   può far adottare righe vecchie come un turno «woken» (`isWokenTurnLine`): la storia ricompare come un
   messaggio nuovo. Rimedio atteso: dopo una riadozione fallita il prossimo riattacco è «live» (da `endOffset`,
   come `attachLive` per un figlio `resumed`), senza bloccare l'autoguarigione. Il flag `attachPending` (fix del
   coordinatore dopo T18) non va riusato qui: lo bloccherebbe per sempre.

- **Base:** `cloud/quality-pass-integrata` con T18 dentro, più questo brief: ramo `cloud/t19-base`.

## Cosa si sa già (dal coordinatore)

- `server/ai-bridge.mjs`, `onDead`: il demone manda `{type:'exit', id, exitCode, endOffset}` e, se la sessione
  non è stata uccisa (`killing`), **tiene sessione e store** «for a late attach (Case 1); the sweep reaps it».
  Con `killing` chiude il fd e cancella lo store subito.
- `server/lib/ai-bridge-client.ts` (~riga 469): `case "exit"` → `onExit(exitCode)`; l'`endOffset` del frame
  oggi non arriva al provider.
- Il demone in produzione resta acceso fra i deploy (quello di ieri): un server nuovo deve parlare anche con
  un demone che forse non mette `endOffset` nell'`exit` (verifica con `git log -S endOffset -- server/ai-bridge.mjs`
  da quando c'è), e in quel caso comportarsi come oggi.

## Vincoli

- Nessun delta duplicato, nessun cambio in cosa produce un turno sano: cambia solo che la coda arriva.
- Un turno fermato dall'utente (`aborting`) o un figlio ucciso (store già cancellato) si chiudono come oggi,
  e il log dice perché la coda non c'era.
- Le regole comuni di `_comuni.md` (setup, barra comune, Bun 1.3.8 per il codice server, consegna).

## Barra

- **B1 coda dopo un'uscita da staccati:** test col demone vero e una CLI finta: ci si stacca, la CLI scrive il
  testo finale e il `result` ed esce. Prima: il turno si chiude senza testo finale (rosso). Dopo: testo e
  `result` piegati una volta, turno chiuso come completato (verde). Numeri prima e dopo.
- **B2 store sparito:** uscita con lo store già cancellato (kill): il turno si chiude come oggi e il log dice il
  motivo; nessuna attesa appesa.
- **B3 demone vecchio:** `exit` senza `endOffset`: comportamento di oggi, nessun errore.
- **B4 riadozione sotto scrittura:** il test che T18 non ha scritto (server riavviato, figlio che scrive di
  continuo durante scan e fase 2): ogni numero una volta. Se è già verde, resta e lo dici; se è rosso,
  correggi col minimo.
- **B4b riadozione fallita:** il caso 3 riprodotto (scan interrotto, poi un riattacco della sonda o del
  riaggancio): prima righe vecchie come turno nuovo (rosso), dopo nessuna riga vecchia ripiegata (verde).
- **B5 mutazione** (copia scratch): togliere il fix fa tornare rossi B1, B4b (e B4 se lo correggi).
- **B6:** la barra comune di `_comuni.md`.

## Consegna

Ramo `cloud/t19-coda-del-turno`, REPORT in `openspec/changes/cloud-quality-pass/reports/T19.md`.

**FUORI.** Il provider nativo, la board, il client, i workflow CI, `.bun-version`, le migrazioni, il
protocollo del demone (niente campi nuovi: il server nuovo deve parlare col demone vecchio).
