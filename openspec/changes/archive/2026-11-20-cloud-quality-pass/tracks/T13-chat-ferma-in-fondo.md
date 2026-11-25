# T13 — la chat in fondo che non si ferma: `chat-accordion-no-shift` «tool-result-clamp» in CI

**GOAL.** Il test cade al primo tentativo in metà delle CI, su main e sull'integrazione. Trova la causa e
correggila (nell'app o nel test, decidi con le prove), oppure consegna «non riprodotto» con i numeri.

- **Base:** `cloud/quality-pass-integrata` @ `7a10aad77` (contiene main con #244, le strisce della chat
  nel trascritto) più questo brief: ramo `cloud/t13-base`. Main per i confronti: `origin/main` @ `4494c4d0f`.

## Cosa si sa già (dal coordinatore)

- **Firma.** `tests/e2e/chat-accordion-no-shift.spec.ts:479` «tool-result-clamp: open and close, at the
  bottom and in the middle», `TimeoutError: page.waitForFunction: Timeout 30000ms exceeded` alla riga 507:
  gli ultimi 15 frame della sonda non hanno mai lo stesso `scrollTop`/`scrollHeight` al fondo vero.
  Succede PRIMA di ogni clic, nella fase «AT THE BOTTOM: the reader follows the output, nothing touched».
  Il retry passa in 7,8-9 s. Dopo #244 i numeri di riga possono essere cambiati.
- **Frequenza (primo tentativo rosso, dai log CI).** Basate su main: 8 corse su 13, anche su `main` stesso
  (run 37508090467 e 37504718894). Integrazione: 3 su 7. Chromium, `E2E_TIER=pr`, retries 2.
- **Il contesto conta.** In CI la suite PR gira in 8 shard pianificati per durata
  (`scripts/e2e-plan-shards.ts 8`, `scripts/e2e-shard-run.ts`, job e2e di `.github/workflows/ci.yml`),
  **un worker per shard, un server di test e un DB per shard**: la spec gira dopo tutte le altre del suo
  shard, sullo stesso DB. Nella corsa di main il rosso era il test 62 dello shard, dopo `tool-group`,
  `tool-row` e `tool-row-lazy` della stessa spec. T12 l'ha ripetuto DA SOLO (`-g tool-result-clamp
  --repeat-each=10`, quattro `yes` di carico): 0/40 sulla testa, 0/40 su main.
- La sonda dei frame di V3: `accordion-debug.patch` sul ramo `cloud/v3-verifica-integrata-evidenza`,
  cartella `openspec/changes/cloud-quality-pass/evidence/V3/`.

## Protocollo

1. **Riproduci nel contesto della CI**: lo shard che contiene la spec, con la stessa composizione e lo
   stesso ordine del piano, un worker, `E2E_TIER=pr`, `--retries=0`, Chromium. Se lo shard intero costa
   troppo, bisezione: la spec intera, poi la spec con i file che la precedono nello shard. N ≥ 10 corse
   del contesto più piccolo che riproduce. Tetto: se dopo 2 ore di VM non è riprodotto, fermati e consegna
   «non riprodotto» con i contesti provati e i numeri.
2. **Sonda** quando è rosso: la sequenza dei frame (st, sh, ch), cosa cambia e con che ritmo.
3. **Causa, poi fix.** Se la chat davvero non sta ferma (un elemento che cambia altezza a ogni giro, il pin
   che rincorre, stato rimasto da un test prima), il fix va nell'app: è un difetto che l'utente vede. Se
   la chat è ferma ma la condizione del test non regge in quel contesto, il fix va nel test, col perché.
4. **Prova:** nello stesso contesto prima ≥ 3/N rossi e dopo 0/N, stesso N; un test deterministico se la
   causa è nell'app; il video del caso rosso e di quello corretto (Chromium headless va bene).

## Barra

- **B1:** riproduzione prima/dopo come al punto 4.
- **B2:** la spec intera verde 3 volte di fila con `--retries=0`, sulla testa e sul fix.
- **B3 mutazione** (copia scratch, mai il file vero): senza il fix, il contesto che riproduce torna rosso.
- **B4 verde resta verde:** la barra comune di `_comuni.md`.

## Consegna

Ramo `cloud/t13-chat-ferma`, REPORT in `openspec/changes/cloud-quality-pass/reports/T13.md`: in testa la
causa con la prova (o «non riprodotto» con i numeri), poi B1-B4.

**FUORI.** Alzare timeout o retry, `test.skip`/`fixme`, sleep; riscrivere le strisce della chat (#244, lavoro
di un'altra sessione: se la causa sta lì, correggi col minimo e dillo); migrazioni, workflow CI,
`.bun-version`.
