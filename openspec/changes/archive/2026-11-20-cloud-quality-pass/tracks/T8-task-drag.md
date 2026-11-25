# T8 · Task: trascinare una card costa poco

Change `cloud-quality-pass`, traccia T8. Ramo di consegna: `cloud/t8-task-drag`.
Parti da `cloud/quality-pass-integrata`: T1 (topic dalla copia locale), T5 (server), T3 (avvio del
server) e T2 (board) sono già fusi lì, i loro REPORT sono in `reports/`. Le regole comuni (setup,
barra, recinto, prova, consegna, modelli) sono in `tracks/_comuni.md`: leggile prima di partire.

**GOAL.** Il drag di una card sulla board costa meno main thread: almeno −30% per passata in
`tests/e2e/board-drag-frames.spec.ts` (T2: ~800 ms per 60 mosse, script ~320 ms), senza perdere
niente del drag di oggi (anteprima, regioni, touch, niente selezione di testo).

**FUORI.** Cambiare libreria di drag, ridisegni, funzioni nuove, la scheda del task (T2).

## Dove guardare

- I componenti della board (card, colonne, contesto del drag), `dndStableProps`: cosa ridisegna a
  ogni mossa. Il contatore di render di `tests/e2e/board-update-renders.spec.ts` (T2) si adatta al
  drag.
- Layout forzati durante il drag (misure del DOM in loop), stili che invalidano il layout dove
  basterebbe un `transform`, collision detection che scorre tutte le card a ogni mossa.

## Misure (prima e dopo, stessa VM, due corse)

| Numero | Comando | Target |
|---|---|---|
| main thread per passata (60 mosse) | `npx playwright test tests/e2e/board-drag-frames.spec.ts --project=chromium` | −30% |
| render per mossa | campo nuovo, come quello di T2 per `task:updated` | −50% |
| frame time del drag, p95 | `bun run check:drag` | < 16,7 ms; exit 2 = non misurato, scrivilo |
| il drag di oggi | `tests/e2e/board-drag-frames.spec.ts board-touch-drag drag-preview drag-regions drag-no-text-selection` | tutte verdi |

## Prova

- Video prima/dopo di un drag fra colonne con 60+ card.
- Mutazione sul punto critico del fix: il numero torna su o un test va rosso.
- E2E di area: `tests/e2e/board-*.spec.ts tests/e2e/drag-*.spec.ts`.
