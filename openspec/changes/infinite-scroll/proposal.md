# Proposal: infinite-scroll

## Perché

L'08/10/2026, da chi usa l'app: «dovrebbe esserci infinite scrolling nei topic o dove c'è da
scrollare», e poco dopo «attento anche ai link dei browser all'interno di un topic».
Cinque liste si allungavano solo con un click: la chat («Carica i messaggi precedenti»), le
colonne della board («Mostra altre 25»), lo storico delle notifiche, la cronologia dei commit
(+20) e il selettore delle sessioni da riprendere. E la barra delle schede della finestra browser
di una topic, invece di scorrere, stringeva le schede: misurato su WebKit in una finestra
minimizzata (420 px), otto pagine erano larghe 35 px con 14 px di titolo, quindici 17 px senza
titolo, e il «+» era largo 13 px già con tre.

La chat era a click per scelta (CHAT-HIST-01): anteporre righe con `firstItemIndex` di Virtuoso
4.18.1 costava un fotogramma vuoto e un CLS di 0,60 (tag
`archive/experiment-chat-tail-first-virtuoso-prepend`). Virtuoso 4.18.13 compensa lo scorrimento
nello stesso fotogramma.

## Cosa cambia

- Virtuoso 4.18.1 → 4.18.16.
- Chat: risalendo, a sei schermate dalla cima della finestra caricata il resto della storia è
  chiesto e tenuto da parte, a due schermate è fuso; le righe lette restano ferme. La riga «Carica
  i messaggi precedenti» resta: in attesa se chi legge arriva prima della rete, cliccabile se la
  richiesta è fallita.
- Board, notifiche, commit, sessioni da riprendere: la riga «mostra altri» carica da sola quando
  entra in vista (`lib/loadOnReach.ts`, `hooks/useLoadOnReach.ts`), una pagina per volta, e resta
  un bottone.
- Finestra browser della topic: la barra scorre di lato, ogni scheda resta larga almeno 88 px, la
  scheda attiva è in vista, il «+» resta intero fuori dalla parte che scorre. La logica «tieni in
  vista la tab attiva» della barra del layout diventa un hook condiviso (`useActiveTabInView`).
- Spec: CHAT-HIST-01 riscritto, scenario nuovo in TOPIC-BROWSER-01, requisito nuovo LIST-PAGE-01.

## Barra

`specs/acceptance.md`.

## Fuori

L'apertura della chat (coda prima, sipario) resta com'è. Nessuna rotta nuova: i cursori esistono.
Le liste che caricano tutto in una volta (albero dei topic, file, thread del task) non sono a click
e restano fuori; la loro virtualizzazione è un altro lavoro.

## Deciso da me

- Il resto della chat in UNA richiesta (`before`, `limit: 0`, come il click di prima) e non una
  pagina alla volta: il prepend di ottanta righe su 4.18.16 misura le righe ferme, e una richiesta
  sola è meno codice e meno giri.
- Dopo ogni pagina arrivata una lista chiede all'osservatore uno sguardo nuovo prima di caricare
  ancora: fidarsi del «in vista» di prima caricava pagine a catena dentro un fotogramma (visto nel
  ragionamento, chiuso da un test unitario che va rosso sul comportamento vecchio).
- La barra delle schede scorre come la barra delle tab del layout (stessa barra di scorrimento
  nascosta, nessun dirottamento della rotella verticale).
