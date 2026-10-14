# D0 · Misure: ogni numero dell'«istantaneo» diventa un cancello

Regole comuni (setup, barra di base, recinto, consegna): `tracks/_comuni.md` di questa change.

**GOAL.** Ogni obiettivo di velocità del piano ha un comando che esce non-zero quando non è
rispettato, e un numero di partenza preso con quel comando.

## Perché

I cancelli di velocità ci sono, ma guardano altrove. `check:route-latency` misura quattro rotte
(`/api/topics`, i messaggi di un topic, il feed dei task, `dispatch-capacity`). Le più lente in
produzione sono altre: nelle 24 ore del 13-14/10 (`baseline.md`) `git/status` ha 6.008 chiamate con
p95 di 385 ms, `files` p95 349 ms, `system/status` p95 397 ms, `scripts` p95 173 ms. Nessun cancello
le vede.

Sul socket non c'è nessun cancello: un client fermo riceve 6,9 KB/s di payload, mentre ad agosto lo
stato stabile era 2,7 KB in cinque minuti (intestazione di `server/lib/ws-compression.ts`).
È tornato indietro senza che niente diventasse rosso.

## Cosa si fa

1. **Rotte.** `check:route-latency` misura anche:
   - `git_status`: GET `/api/git/status` su un repo fixture da 200 file con 20 modifiche;
   - `files`: GET `/api/files` su un albero fixture da 5.000 voci;
   - `scripts`;
   - `system_status`.

   Il ratchet resta quello che c'è.
2. **Socket a riposo.** `measure:ws-idle`, nuovo, nello stile di `measure:ui-state-init`.
   - Un client si collega a `/ws` come fa l'app e non apre niente.
   - Ascolta 60 s su un server seminato con 100 sessioni esterne, di cui poche cambiano stato ogni
     10 s, e una chat che scrive in streaming.
   - Le 100 sessioni vengono dal censimento di produzione del 14/10: 114 sessioni, 12 attive,
     46 KB a frame. Con 20 il frame pesava un quarto e il banco usciva verde.
   - Stampa i byte per tipo di frame e i byte al secondo, ed esce 1 sopra `--budget`.
3. **Webview.** `scripts/measure-webview.sh`, solo Mac e fuori dalla CI.
   - Campiona `footprint` e la CPU del processo WebContent di Topics ogni 30 s per 10 minuti, con
     l'app in background e 5 topic aperti.
   - Il numero va in `baseline.md`.
4. **Avvio a freddo e input.**
   - Un mark `app:interactive` nel client, e la sua lettura dopo il lancio dell'app.
   - Per l'input, la traccia di `check:ink`, che c'è già.

## Barra

```bash
bun run check:route-latency                       # 8 rotte; esce 0 sulla baseline nuova
bun run measure:ws-idle -- --budget 1024          # oggi esce 1: è il rosso che D1 deve spegnere
```

- **Il cancello morde.** In una copia (mai nel file vero) si aggiunge `await Bun.sleep(100)` nella rotta
  `git/status`: `check:route-latency` deve uscire 1.
- **`measure:ws-idle` è ripetibile:** tre esecuzioni di fila danno byte al secondo entro il 10% l'una
  dall'altra.

## Fuori

Nessuna ottimizzazione: questa traccia misura e basta. Niente framework di benchmark nuovi: si
allargano i cancelli che ci sono.
