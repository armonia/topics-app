# T10b — il feed della board, giusto anche su Bun 1.3.8

**GOAL.** Le ottimizzazioni di T10 (`cloud/t10-task-feed` @ fa4e45601) restano, ma il feed è
identico a quello di base su **Bun 1.3.8 e sulla latest**: oggi sulla 1.3.8 ogni task è spazzatura.

## Il difetto (misurato sul Mac, 08/10, Bun 1.3.8)

`server/lib/wide-rows.ts` costruisce gli oggetti da `statement.values()` con i nomi di
`statement.columnNames`. Sulla 1.3.8, **oltre 62 colonne `columnNames` esce al contrario**
(`c74, c73, …, c0`), mentre `.values()` resta nell'ordine della SELECT. Il feed ne proietta 75:
nel feed vero `id` contiene la descrizione, `descriptionPreview` l'uuid, `status` è null.

- `bun test server/services/tasks.test.ts` sulla 1.3.8: **base 17a60e4c5 185/185, T10 164/185**.
- `bun test server/lib/wide-rows.test.ts` sulla 1.3.8: T10 rosso (il test morde, nessuno l'ha
  girato sulla 1.3.8: la VM ha la 1.4.2, la CI `bun-version: latest`).
- Banco di T10 sulla 1.3.8: byte del feed **+25%** (259.143 → 325.101) invece di −10%: è la
  descrizione intera finita in `id`. Su 63 colonne bastano 3 righe per vederlo:
  `CREATE TABLE t (c0 TEXT, …, c62 TEXT)` → `db.query("SELECT * FROM t").columnNames`.

Due runtime in produzione: il server sul Mac gira con **Bun 1.3.8**, gli installer desktop
compilano `server.ts` con la **latest** (`tauri-release.yml`). Il codice deve essere giusto su
tutte e due, quindi **non deve dipendere dall'ordine di `columnNames`** (il conteggio è giusto,
l'ordine no).

## Cosa fai

1. La 1.3.8 accanto alla tua (vedi `_comuni.md`, Setup 2): `npm i --prefix /tmp/bun138 bun@1.3.8`.
2. Correggi `allWideRows` e il suo chiamante. Strada suggerita, decidi tu: i nomi li dà chi ha
   scritto la proiezione (`listColumns` in `server/services/tasks.ts` li conosce già: le colonne
   della tabella più `description_preview`); nomi sconosciuti (il ramo `*` di ripiego) o un
   conteggio diverso da `statement.columnNames.length` → `.all()`. Restano `toFeedTask`, i 19 campi
   di `FEED_OMITTED_TASK_FIELDS`, `sliceCodePoints`.
3. Il test di `wide-rows` copre il caso oltre 62 colonne confrontando con `.all()` (c'è già) e
   gira giusto sulle due versioni. Se la strada nuova cambia la firma, il test segue.

## Barra (si esegue uguale all'inizio e alla fine)

- **B1 verde resta verde, su 1.3.8 E latest:** `server/services/tasks.test.ts`,
  `server/lib/wide-rows.test.ts`, `server/lib/code-points.test.ts`, i test di `shared/board-feed`,
  poi la suite unit del server intera. Nessun test verde su base 17a60e4c5 è rosso su T10b, per
  ciascuna versione (se qualcosa è rosso già su base con la 1.3.8, lo nomini e resta fuori).
- **B2 mutazione** (su una copia scratch, mai sul file vero): rimetti i nomi da
  `statement.columnNames` come in T10 → B1 rosso sulla 1.3.8.
- **B3 uguaglianza:** sullo stesso DB seminato (150 task, descrizioni da 1200 caratteri come il
  banco di T10), `list` di T10b deep-equal a `list` di base, su 1.3.8 e latest. Il feed HTTP è
  `list` meno i 19 campi omessi: verificalo su almeno una risposta della rotta.
- **B4 misura** con il banco di T10, base contro T10b alternati, almeno 3 coppie, **su 1.3.8 e
  su latest**: p50/p95 di `/api/all-boards/tasks`, byte raw e gzip, chiavi per task. Barra: byte
  raw ≤ base −8% su entrambe; p50 non peggiore di base. Numeri veri, anche se deludono.

## Consegna

Ramo `cloud/t10b-task-feed`, REPORT in `openspec/changes/cloud-quality-pass/reports/T10b.md`:
B1–B4 con i comandi e gli output, le due versioni di Bun scritte accanto a ogni numero, e la
correzione dei numeri di `reports/T10.md` misurati solo sulla 1.4.2.

**FUORI.** Workflow CI, `.bun-version`, aggiornare Bun su qualsiasi macchina, migrazioni, altre
rotte, il client.
