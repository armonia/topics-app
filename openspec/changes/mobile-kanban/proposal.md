# Proposal: mobile-kanban

## Why

Attilio, 05/10/2026, rivedendo Topics dal telefono: «mi fa scrollare verticalmente
la top bar della Kanban [...] la barra di ricerca è troppo piccola nella Kanban [...]
le colonne della Kanban dovrebbero [riempire] lo spazio, a meno che non ci siano
troppe card. Pur poi scrollando, alla fine l'ultima card insomma dovrebbe
preservare lo spazio sotto».

Misura di partenza (WebKit, `ui-audit.js` + axe-core via `auditSurface`, 390x844
col dito e fasce 47/34, 844x390 con fasce laterali 47, 820x1180; temi chiaro e
scuro; bundle di `origin/main` a5e6152ff):

| # | Difetto | Prima | Dopo |
|---|---------|-------|------|
| 1 | La barra scorre in verticale (tutte e tre le finestre) | `overflow-y: auto`, scrollHeight 40 / clientHeight 36 | `hidden`, 52 / 52 |
| 2 | Campo di ricerca piccolo (390) | 231x24, `<input>` 197x24, segnaposto tagliato | 318x44, `<input>` 280x44 |
| 3 | Controlli della barra sotto il bersaglio da dito | 24 px (Orchestratore 21), e la sua banda rubava 80 px al tasto vista | tutti 44 px, nessun furto |
| 4 | Ultima card incollata al composer (390) | 3 px (687 contro 690); con la banda avvisi a 48 px finiva sotto | 16 px, e 16 px anche con la banda |
| 5 | Chip delle card illeggibili nel tema chiaro | «Alta» 1,33:1, «ferma · dispatch spento» 1,12:1 | nessun testo sotto 4,5:1 |
| 6 | Lo scheletro della board più basso della barra vera col dito | 36 contro 52: le colonne saltavano di 16 px all'arrivo | 52 e 52 |
| — | Colonne che riempiono l'altezza | già vero: 744/744 (390), 290/290 (844x390), 1080/1080 (iPad) | invariato, ora con un test |

## Cosa cambia

- `TOOLBAR_CONTROL_H` diventa `h-6 coarse:h-11` (più `TOOLBAR_ICON_W`): 24 px col
  mouse, 44 sotto un dito. La barra dichiara `overflow-y-hidden`.
- Il campo di ricerca sotto `sm` parte da `100vw - 4.5rem`.
- Il bottone Orchestratore indossa l'altezza della riga.
- Il fondo del corpo colonna non è più `pb-36`: la board misura quanto il composer
  entra nella colonna e lo pubblica (`--board-bottom-clear`, `columnClearance.ts`),
  con la banda dei tasti come pavimento.
- I chip colorati di card, `atoms.tsx` e `constants.ts`: testo `-800` nel chiaro,
  `-300` nello scuro come prima.
- Spec: KANBAN-12 MODIFICATO (24/44), nuovi KANBAN-MOBILE-01..05.

## Barra

`specs/acceptance.md`.

## Fuori

- La fila in basso, la barra «Topics» del telefono e il contenitore della ricerca
  (ramo `topics/mobile-chrome-libera`), l'omnibox, i processi del server e le
  notifiche legacy: altri rami.
- Le fasce laterali in orizzontale (sensori a 47 px): la sidebar e la board
  partono dal bordo del vetro. È una regola del guscio (la radice dell'app), non
  della board.
- Il chip `#` dell'id: 18 px nel titolo, col dito risponde su 29x45 (il titolo
  accanto gli prende il resto). Allargarlo sposta la riga del titolo (IDCHIP-01).

## Deciso da me

- «filtrare lo spazio» letto come **riempire**, come chiedeva il compito: le
  colonne lo facevano già, quindi la parte nuova è lo spazio sotto l'ultima card.
  L'altra lettura (colonne che si stringono attorno a poche card, stile Trello)
  cambierebbe anche il desktop e i bersagli di trascinamento, e non l'ho fatta.
- Altezza della barra per **puntatore** (`coarse:`, la variante di casa), non per
  larghezza: una finestra desktop stretta resta compatta, un iPad no.
- Il respiro sotto l'ultima card è 16 px fissi sopra una misura viva, non una
  costante più grande: una costante si sbaglia appena il composer cresce.
- Tinte del chiaro a `-800`: con `-700` «Alta» restava a 4,18:1 e il fermo a 3,89:1.
- Tolte da `usability-audit.spec.ts` le due eccezioni che scusavano la barra a
  24/36 px sul telefono: ora non servono, e lasciarle avrebbe coperto un ritorno.
