# T4 - Il banco di convergenza, poi il pane-sync

**GOAL.** Esiste un banco deterministico che riproduce partizioni e riordini, e
il pane store e' l'unica fonte di verita' dello stato delle pane.

## Perche' ora

**Il banco non esiste, e le sette resurrezioni passate si sono trovate in
produzione.** Solo 6 spec e2e usano `openTwoDevices`, tutte sequenziali: A
agisce, B osserva. Solo 2 usano `setOffline`. Le classi di guasto note vivono in
5 file di test a reducer isolato (`reducers/*Resurrection*`,
`staleTombstoneRetraction`, `spacesTombstone`): un difetto per file, trovato
dopo.

**Lo stato delle pane ha due fonti di verita'.** `openPanels` e
`focusedPanelId` sono `useState` seminati da localStorage
(`usePanelLifecycle.ts:389-396`); il pane store e' la seconda fonte. Un ponte a
tre effect le allinea (`:511-575`) alzando `storeSyncInternalRef` e abbassandolo
in `queueMicrotask`. Misurato: 96 call site fra `setOpenPanels(`,
`setFocusedPanelId(` e il flag; `openPanels` compare 240 volte in 24 file; 128
commit su `usePanelLifecycle` dal 01/06, 289 su `App.tsx`.

Sintomi gia' avvenuti, documentati nel repo: la tab che appare, sparisce e
riappare dopo 600 ms (`pane-store-server-authoritative/design.md:103`) e un loop
add/evict fra validazione e HYDRATE a circa **750 Hz** che ha affamato il server
(post-mortem nello stesso file).

E il blob: `pane-store-v2` in `ui_state` pesa 67.521 B riscritti per intero, di
cui il **97,5% sono tombstone e storia** (30.739 B di tombstones, 29.312 B di
closedStack contro 731 pane vive).

`pane-store-server-authoritative` e' a 16/36 su `origin/main`.

## Cosa cambia

1. **Prima il banco.** `tests/sim/sync-convergence.test.ts`: N client reali del
   reducer piu' server in-process, generatore di operazioni (open, close,
   reopen, move, reorder), scheduler che ritarda, riordina e scarta frame.
   Invariante: stesso snapshot e nessuna pane chiusa riaperta.
2. Poi lo stadio 2 di `pane-store-server-authoritative`, sopra l'oplog di T3.
3. Si portano nello store gli intenti di fuoco di deep-link (con scadenza) e la
   proiezione per Spazio attivo. Il fuoco e' in parte locale al dispositivo:
   non e' un puro specchio dello store, e il fix «tutto da selettori» va
   riformulato cosi'.
4. Si migrano i 96 call site, si togliono i tre effect del ponte e i ref-mirror
   usati dagli handler WS.
5. La storia esce dal blob: tombstone e closedStack non si riscrivono interi.

## Barra

- `bun test tests/sim/sync-convergence.test.ts`: 200 seed x 3 client con
  partizioni, 0 divergenze e 0 resurrezioni.
- Il conteggio dei 96 call site del ponte scende a 0.
- `pane-undo` e `cross-window-topic-sync` restano verdi.
- Mutazione: scartare un frame su dieci nel banco lo fa fallire.

## Fuori

Riscrivere lo stato del client. Sono sani `messageStore`, `sessionFlags`,
`attention`, `chatQueue` e la residenza, con 111 file di test su 119 in `state/`.
