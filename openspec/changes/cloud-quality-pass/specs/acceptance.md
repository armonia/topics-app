# Acceptance: cloud-quality-pass

Una traccia è consegnata quando tutti e quattro i blocchi sotto escono come scritto sul suo ramo,
nella VM cloud, e lo stesso ramo passa la CI quando diventa PR.

## 1. Comandi che escono non-zero se qualcosa si rompe

```bash
./scripts/qa-gate.sh --veloce            # exit 0: typecheck, lint, cancelli statici della CI
bun run test:unit:shards                 # exit 0
bun run build:client && bun run check:bundle   # exit 0 (2 = public/ vecchio: non vale)
E2E_TIER=pr npx playwright test --project=chromium <spec dell'area>   # exit 0
```

Lo stato di partenza è quello di T0 (`baseline.md`). Un rosso già presente in T0 non blocca una
traccia, ma la traccia non ne aggiunge: confronto riga per riga con T0 nel REPORT.

## 2. Numeri prima → dopo

Ogni traccia ha la sua tabella (file in `tracks/`): numero, comando, target. Prima e dopo si
misurano con lo stesso script, nella stessa VM, due corse ciascuno, con `uptime` accanto. Un
banco che esce 2 non ha misurato: il numero manca e si scrive perché.

## 3. Scenari con video

Con `E2E_EVIDENCE=1 E2E_VIDEO=1`, prima e dopo:

- **Topic**: aprire una topic con 200+ messaggi già visitata, scorrere fino in cima, seguire un
  turno in streaming. Atteso: i messaggi ci sono al primo frame, lo scroll non salta.
- **Task**: aprire la board con 60+ card, aprire tre schede di fila, trascinare una card fra due
  colonne, archiviare un task con tab aperte. Atteso: la scheda è leggibile al click, il drag
  non scatta, le tab del task archiviato vengono rilasciate.

I video stanno sui rami `cloud/<traccia>-evidenza`.

## 4. Mutazione sul punto critico

Il test che difende il fix più importante della traccia va rosso quando il fix viene tolto:

- T1: togliere l'idratazione da cache fa fallire la spec del primo frame.
- T2: `TOPICS_DRAG_JANK_MS=40 bun run check:drag` esce non-zero.
- T3: un import statico rimesso dopo aver abbassato `scripts/bundle-baseline.json` fa uscire
  `check:bundle` non-zero.
- T4: un export nuovo mai usato fa uscire `check:deadcode` non-zero.
- T5: il test del processo esterno appeso va rosso senza il timeout.
- T6: ogni cancello tenuto ha la sua mutazione rossa nella tabella del REPORT.

Dopo ogni mutazione: `git checkout -- <file>` e `git status` pulito prima del commit.
