# Tasks — model-picker-compact

## 1. Accordion + rimozione columns

Intestazione-bottone (prima riga), `aria-expanded`, aperta la sezione della
scelta corrente o la prima; la ricerca apre tutto; le intestazioni sono
fermate di tastiera. Resta il scroll-into-view della riga scelta (AC-05).
Il layout `columns` morto esce (prop, rami, test).

Barra: `bun test ModelList.test.tsx` verde con i nuovi casi +
`bun run typecheck` + `bun run lint` + `bun run check:bloat`.

## 2. Compattazione testi

`routingLine` a una riga (it+en); hint Automatico in `sr-only` su
desktop-compact (full e telefono la mostrano). Unit aggiornato.

Barra: unit verde + `check:comment-language` +
`check:identifier-language` verdi.

## 3. e2e

Riscrittura per l'accordion: toggle, default-aperto, ricerca, Precedenti,
connect-box, muse. File: model-selector, model-selector-revision,
model-panels-providers, picker-keyboard-nav (ritocco), muse-provider-picker.

Barra: i 5 verdi su CI (chromium, Linux).

## 4. Spec

Emendamenti MSEL-02 (accordion), MSEL-07 (riga sola + frase Automatico come
descrizione accessibile), MSEL-08 (intestazioni come fermate).

Barra: `bun run check:spec-coverage` verde.

## 5. Evidenza

Mutazione locale sul default-aperto (unit rosso, poi revert); screenshot
AC-34 dagli artifact CI rivisti.

Barra: mutazione vista rossa + nota di revisione nel report.
