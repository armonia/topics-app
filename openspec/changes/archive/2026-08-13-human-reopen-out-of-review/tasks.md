# Tasks — human-reopen-out-of-review

- [x] `update()`: il ramo che marca la riapertura parte anche da `review`, non solo da `done`; `done_actor` si spegne solo uscendo davvero da `done`.
- [x] `markReopened()`: accetta `review` come stato di partenza (porte a SQL grezzo: rilascio orfani, attesa, consegna di sistema).
- [x] `reviewDecision` / `reject`: marca la riapertura con firma umana e azzera lo scatto della consegna, come già fa `update()` per lo stesso salto.
- [x] Chip «riaperta»: il tooltip non dice più «Era in Done», perché adesso la card può venire da review.
- [x] Test: i quattro percorsi (`review→in_progress`, `review→todo`, rifiuto in review, `done→todo`), il ritiro di sistema che NON deve marcare `human`, e il cancello del dispatcher che smette di chiudere una card trascinata fuori da review.
