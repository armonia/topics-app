# T11 — i test instabili che tornano in ogni traccia

**GOAL.** I test qui sotto sono stati rossi «sotto carico» e verdi «da soli» in almeno due sessioni
diverse di questa change. Ogni sessione ha pagato il tempo di riprovarli e nessuna li ha guardati. Per
ciascuno: **la causa provata** (il test aspetta il tempo invece di una condizione, oppure il prodotto
ha una corsa vera) e **il rimedio con la prova**, o la prova che non si riproduce.

## I test (base: `cloud/quality-pass-integrata` @ `7a27c7112`)

| # | Test | Sintomo | Visto in |
|---|---|---|---|
| 1 | `tests/integration/terminal-revive-race.test.ts` «due revive concorrenti: un solo create…» | rosso negli shard, verde da solo (2/2, 3/3) | REPORT T9, T2b, T7b |
| 2 | `tests/integration/subagent-native-engine.test.ts` | «timed out waiting for the reconcile list» negli shard, verde da solo 8/8 | REPORT T3, T6, T2b |
| 3 | `server/services/ci-evidence.test.ts` › `spawnCapped` | rosso negli shard, verde alla corsa dopo | REPORT T3, T9 |
| 4 | `tests/e2e/board-card-choices.spec.ts` «quattro stati, quattro decisioni in un click» | «element is not stable / detached from the DOM» sul menu delle scelte, verde al retry | REPORT T2b, T8 |
| 5 | `tests/e2e/chat-streaming-indicator.spec.ts:426` «at the bottom the line comes and goes…» | flaky sulla base e sul ramo nell'e2e d'area | REPORT T7b |
| 6 | `tests/e2e/board-motion-contract.spec.ts:249` | timeout a carico 12-14 (WebKit sul Mac), verde rilanciato | verifica di T8 |

L'1 è un test di concorrenza vero (il bridge finto ritarda l'ack apposta): un rosso sotto carico può
essere il prodotto che perde la serializzazione delle revive. **Non dare per scontato che sia il test.**

## Cosa fai, per ogni test

1. **Riproduci sulla base, sotto un carico che scrivi e tieni uguale fino alla fine** (per esempio 4
   processi `yes > /dev/null`, oppure gli shard che girano in parallelo; `uptime` nel log). Ripeti il
   test N volte: unit e integrazione N ≥ 30, e2e N ≥ 20 (`--repeat-each`, `--retries=0`). Conta i rossi.
   0 rossi su N: raddoppia N una volta; ancora 0 → «non riprodotto» con i numeri, e quel test non si tocca.
2. **Causa**, con la riga: cosa aspetta il test, cosa succede sotto carico, perché è rosso. Se è il
   prodotto: un test che lo fa rosso in modo deterministico (senza carico), poi il fix.
3. **Rimedio**: il test aspetta la condizione vera (un evento, uno stato, un frame), non il tempo.
4. **Dopo**: stesso carico, stesso N, **0 rossi**. Una sola corsa a N, niente «quasi».

## Barra (si esegue uguale all'inizio e alla fine)

- **B1 per test:** rossi/N prima e dopo, con il carico e il comando. Barra: dopo 0/N su ogni test
  riprodotto.
- **B2 verde resta verde:** la barra comune di `_comuni.md` (qa-gate `--veloce`, `test:unit:shards`,
  e2e d'area `board-*` e `chat-*` in Chromium). Nessun test verde sulla base è rosso dopo.
- **B3 se tocchi il prodotto:** il test deterministico è rosso sulla base e verde dopo; una mutazione
  che toglie il fix lo rifà rosso (copia scratch, mai il file vero).

## Consegna

Ramo `cloud/t11-test-instabili`, REPORT in `openspec/changes/cloud-quality-pass/reports/T11.md`: in
testa una tabella con una riga per test (rossi/N prima, rossi/N dopo, carico, causa in una riga, file:riga
del rimedio), poi B2 e B3. Un commit per test, il messaggio dice la causa.

**FUORI.** `retries` (nel test o nella config), `test.skip`/`fixme`/quarantene, timeout alzati senza una
misura che mostri quanto dura davvero il lavoro sotto carico, `sleep`/`waitForTimeout` come rimedio,
workflow CI, migrazioni, cambi al prodotto senza il test deterministico di B3.
