# Acceptance: daily-driver

La change è finita quando le tre condizioni qui sotto sono vere insieme, eseguite allo stesso modo
all'inizio e alla fine.

## 1. Comandi che escono non-zero

```bash
./scripts/qa-gate.sh --veloce                      # ciò che è verde resta verde
bun run test:unit:shards
bun run check:route-latency                        # 8 rotte, budget di D1
bun run measure:ws-idle -- --budget 1024           # client fermo ≤ 1 KB/s
bun run build:client && bun run check:bundle       # entry eager compresso ≤ 400 KB
bun run check:growth                               # con lo scenario di D2
E2E_TIER=pr npx playwright test --project=chromium
```

Più la barra di ogni traccia nel suo file. Una traccia chiusa dal suo cancello d'ingresso (D3)
conta come finita se il REPORT ha il numero che l'ha chiusa.

## 2. Scenari spec-flow con video

Il `.webm` di ogni scenario è la prova; un resoconto a parole non lo è.

- **DD-01, la giornata tipo.**
  - L'app si apre e il primo topic è interattivo entro 1,5 s.
  - Il passaggio fra cinque topic disegna ognuno entro 100 ms dalla copia locale.
  - Una card parte, l'utente commenta due righe del diff, l'agente corregge, la CI è verde e il
    land porta su main.
- **DD-02, fuori casa.**
  - Il telefono, abbinato col QR, apre un topic attraverso il relay e vede lo streaming della chat.
  - Il payload sul relay non contiene il testo in chiaro.
- **DD-03, il browser condiviso.**
  - Il Mac apre una pagina, l'iPad la prende e la scorre, il Mac la riprende.
  - L'agente esegue un'azione sulla pagina, e la pagina di stato del browser dice chi la possiede
    in ogni momento.
- **DD-04, il riavvio.** SIGTERM al server durante DD-01: il turno della card e la chat continuano,
  nessuna pane cambia.

## 3. Mutazioni sui punti critici

Sempre in una copia, mai nel file vero. Ognuna deve far diventare rosso il test indicato.

| Mutazione | Deve fallire |
|---|---|
| TTL di 5 s rimesso nella cache dello stato git | il contatore di spawn di D1 |
| Frame per topic mandati di nuovo a tutti | `measure:ws-idle -- --budget 1024` |
| Virtualizzazione del transcript tolta | l'e2e dei nodi DOM di D2 |
| Condizione della CI tolta dal land | lo scenario dei controlli di D5 |
| Cifratura tolta dal client del relay | il test del payload di D6 e DD-02 |
| Riattaccatura del turno tolta dal dispatcher | l'e2e del SIGTERM di D7 e DD-04 |

## 4. D2a, riposo in background

- Con topic, board e lista sessioni aperti, Chromium cambia davvero `document.visibilityState`
  a `hidden`; in 10 secondi il numero di callback di timer resta entro il tetto fissato dalla
  misura post-fix, con i timer WebSocket e i salvataggi pendenti inclusi.
- Al ritorno visibile un dato aggiornato mentre la pagina era nascosta compare entro 1 secondo.
- L'e2e stampa il metodo di background, il conteggio e le prime sorgenti client; la misura iniziale
  sul codice pre-fix deve superare il tetto.

## 5. D3b, addon dentro il binario

### Requirement: D3B-01 — il modulo N-API si carica nel server compilato

Il server compilato carica il modulo N-API incorporato e stampa versione e commit di HEAD con
`--native-selftest`. `server/lib/native-addon.test.ts` copre anche il modulo assente, un repository
normale, una worktree collegata e una cartella non Git.
