# T15 — i rossi che tornano nelle barre: le perdite d'ordine della suite

**GOAL.** Tre test diventano rossi a caso nelle barre di cinque tracce su sei, sempre «rossi della base», mai
corretti perché fuori da ogni recinto. Una CI che diventa rossa a caso insegna a ignorare i rossi. Per ciascuno:
causa e fix, oppure «non riprodotto» con i numeri (protocollo di T11, in `tracks/T11-test-instabili.md`).

- **Base:** `cloud/quality-pass-integrata` @ `35462d916` più questo brief: ramo `cloud/t15-base`.

## I tre

1. **`server/attention/system-notices.test.ts`** «a freeze and its thaw are one system row»: rosso negli shard
   unit nelle barre di T6, T9, T11, T12 e T14, verde da solo. Pista di T14: lo stato dell'attenzione
   (`topic:front`) resta fra i file di `server/attention/`. Trova il file che non pulisce: composizione e
   ordine dello shard da `scripts/test-unit-shards.ts`, poi bisezione dei file che lo precedono.
2. **La guardia del preload del client**: un test lascia `localStorage` globale prima di
   `undoCausalRestamp.test.ts` (rosso `(unnamed)` nella barra di T14). `bun run check:test-globals` per trovarlo.
3. **`board-recapture-preview` RECAPTURE-01** nell'e2e: rosso 3 tentativi su 3 nelle VM di T2, T2b, T10 e T11,
   verde in CI. Prima di tutto: è la VM (una dipendenza che manca) o il test? Se è la VM, scrivi in `_comuni.md`
   (Setup) cosa manca e come si installa, e basta.

Il fix va nel test che sporca (la sua pulizia), non in quello che cade. Se la perdita è nel codice di
produzione e non nel test, dillo e correggi col minimo.

## Barra

- **B1:** per 1 e 2, il contesto più piccolo che riproduce: prima ≥ 1/N rossi, dopo 0/N, stesso N ≥ 10, e una
  guardia o un test che diventa rosso se il file che sporcava torna a farlo.
- **B2:** `bun run test:unit:shards` exit 0 due volte di fila sul fix (Bun latest); sulla 1.3.8 nessun rosso
  che non sia rosso anche su main nella stessa corsa (`_comuni.md`, Setup 2).
- **B3 mutazione** (copia scratch, mai il file vero): senza la pulizia il contesto torna rosso.
- **B4 verde resta verde:** la barra comune di `_comuni.md`.

## Consegna

Ramo `cloud/t15-perdite-ordine`, REPORT in `openspec/changes/cloud-quality-pass/reports/T15.md`: in testa i tre
con causa, prima/dopo e comando, poi B1-B4.

**FUORI.** Retry, skip, sleep, timeout più lunghi; `tests/e2e/chat-accordion-no-shift.spec.ts` e la chat (li ha
T13); migrazioni, workflow CI, `.bun-version`.
