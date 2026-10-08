# T7 · Topic: ogni immagine ha il suo spazio prima di caricarsi

Change `cloud-quality-pass`, traccia T7. Ramo di consegna: `cloud/t7-topic-immagini`.
Parti da `cloud/quality-pass-integrata`: T1 (topic dalla copia locale), T5 (server), T3 (avvio del
server) e T2 (board) sono già fusi lì, i loro REPORT sono in `reports/`. Le regole comuni (setup,
barra, recinto, prova, consegna, modelli) sono in `tracks/_comuni.md`: leggile prima di partire.

**GOAL.** Un'immagine in un messaggio occupa il suo spazio finale prima di caricarsi. Aprire una
topic visitata con una risposta-immagine arrivata mentre eri via non sposta la vista (CLS ≤ 0,01,
oggi 0,034 come misurato da T1); lo stesso per un'immagine che arriva dal vivo durante un turno.

**FUORI.** Migration nuove: se le dimensioni vanno salvate, stanno nei dati che il messaggio ha già;
se serve una colonna, va in «Trovato e non fatto». Ridisegni. Cambi che rompono la compatibilità:
client nuovo con server di oggi e viceversa devono funzionare (dimensioni assenti = comportamento di
oggi).

## Dove guardare

- `tests/e2e/topic-visited-first-frame.spec.ts` (verso riga 406, la risposta con immagine di misura
  ignota) e gli helper `armObserver`, `collectShifts`, `settledUntilQuiet`.
- I componenti del client che disegnano le immagini dei messaggi e il punto del server dove un
  messaggio con immagine si salva o si trasmette. Per PNG, JPEG, WebP e GIF le dimensioni stanno nei
  primi byte del file: nessuna dipendenza nuova se non serve davvero.

## Misure (prima e dopo, stessa VM, due corse)

| Numero | Comando | Target |
|---|---|---|
| CLS della risposta-immagine arrivata da via | lo scenario di T1 nella sua spec | ≤ 0,01 |
| CLS di un'immagine che arriva dal vivo | spec nuova, stesso osservatore | ≤ 0,01 |
| nessun peggioramento | `tests/e2e/refresh-cls.spec.ts`, `tests/e2e/pane-return-cls.spec.ts`, `bun run check:growth` | verdi, numeri pari |

## Prova

- Mutazione: togli il box dato dalle dimensioni, la spec va rossa; rimetti con `git checkout`.
- Video prima/dopo dello scenario con immagine (`E2E_EVIDENCE=1 E2E_VIDEO=1`).
- E2E di area: `tests/e2e/topic-*.spec.ts tests/e2e/chat-*.spec.ts tests/e2e/*cls*.spec.ts`.
