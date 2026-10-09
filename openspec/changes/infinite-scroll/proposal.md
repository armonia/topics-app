# Proposal: infinite-scroll

**Stato: in corso.** La fusione in cima regge a vista ferma ma non ancora negli altri casi (sotto,
«Da rifare»). Le liste e la barra delle schede della finestra browser sono passate alla change
`list-paging`, che non dipende da questa.

## Perché

L'08/10/2026, da chi usa l'app: «dovrebbe esserci infinite scrolling nei topic o dove c'è da
scrollare». La chat si allungava verso l'alto solo col click su «Carica i messaggi precedenti».

Era a click per scelta (CHAT-HIST-01): anteporre righe con `firstItemIndex` di Virtuoso 4.18.1
costava un fotogramma vuoto e un CLS di 0,60 (tag
`archive/experiment-chat-tail-first-virtuoso-prepend`). Virtuoso 4.18.13 compensa lo scorrimento
nello stesso fotogramma.

## Cosa cambia

- Virtuoso 4.18.1 → 4.18.16.
- Chat: risalendo, a sei schermate dalla cima della finestra caricata il resto della storia è
  chiesto e tenuto da parte, a due schermate è fuso; le righe lette restano ferme. La riga «Carica
  i messaggi precedenti» resta: in attesa se chi legge arriva prima della rete, cliccabile se la
  richiesta è fallita.
- Spec: CHAT-HIST-01 riscritto.

## Da rifare

Misurato su WebKit (09/10): la fusione a riposo tiene la riga letta, ma
- con lo scorrimento animato della tastiera e di Home la fusione cade a metà animazione e la riga
  letta salta di migliaia di px (1709 px fuori al fotogramma dopo la fusione, poi Virtuoso
  compensa a stima);
- a scheda nascosta, con la richiesta in volo, la fusione arriva senza ancora;
- il contatore «↓ N» dei messaggi nuovi conta come nuove le righe aggiunte in cima.

Il progetto: fondere solo a riposo (nessuno scorrimento da ~150 ms, nessun tasto premuto, scheda
visibile), tenendo da parte ciò che arriva prima; ri-ancorare esatto con `placeRowAt` dopo
l'anteposizione; contare nel «↓» solo le righe aggiunte in fondo.

## Barra

`specs/acceptance.md`.

## Fuori

L'apertura della chat (coda prima, sipario) resta com'è. Nessuna rotta nuova: i cursori esistono.
Le liste e la barra delle schede: change `list-paging`.

## Deciso da me

- Il resto della chat in UNA richiesta (`before`, `limit: 0`, come il click di prima) e non una
  pagina alla volta: il prepend di ottanta righe su 4.18.16 misura le righe ferme, e una richiesta
  sola è meno codice e meno giri.
- Liste e barra separate da qui, per non tenerle ferme dietro la fusione da rifare.
