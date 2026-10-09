# Proposal: list-paging

## Perché

L'08/10/2026, da chi usa l'app: «dovrebbe esserci infinite scrolling nei topic o dove c'è da
scrollare», e poco dopo «attento anche ai link dei browser all'interno di un topic».
Quattro liste si allungavano solo con un click: le colonne della board («Mostra altre 25»), lo
storico delle notifiche, la cronologia dei commit (+20) e il selettore delle sessioni da
riprendere. E la barra delle schede della finestra browser di una topic, invece di scorrere,
stringeva le schede: misurato su WebKit in una finestra minimizzata (420 px), otto pagine erano
larghe 35 px con 14 px di titolo, quindici 17 px senza titolo, e il «+» era largo 13 px già con tre.

## Cosa cambia

- Board, notifiche, commit, sessioni da riprendere: la riga «mostra altri» carica da sola quando
  entra in vista (`lib/loadOnReach.ts`, `hooks/useLoadOnReach.ts`), una pagina per volta, e resta
  un bottone.
- Finestra browser della topic: la barra scorre di lato, ogni scheda resta larga almeno 88 px, la
  scheda attiva è in vista (anche quando la barra si stringe sotto di lei), il «+» resta intero
  fuori dalla parte che scorre. La logica «tieni in vista la tab attiva» della barra del layout
  diventa un hook condiviso (`useActiveTabInView`).
- Spec: requisito nuovo LIST-PAGE-01, scenari nuovi in TOPIC-BROWSER-01.

## Barra

`specs/acceptance.md`.

## Fuori

La chat (CHAT-HIST-01, la storia che arriva da sola risalendo): resta nella PR #269. La fusione in
cima sotto chi legge regge a vista ferma ma salta di migliaia di px se arriva durante lo
scorrimento animato di tastiera e Home, e a scheda nascosta: va riprogettata, e liste e barra non
ne dipendono. Le liste che caricano tutto in una volta (albero dei topic, file, thread del task)
non sono a click e restano fuori. Nessuna rotta nuova: i cursori esistono.

## Deciso da me

- Liste e barra separate dalla chat, per non tenere ferme due cose pronte dietro una da rifare.
- Dopo ogni pagina arrivata una lista chiede all'osservatore uno sguardo nuovo prima di caricare
  ancora: fidarsi del «in vista» di prima caricava pagine a catena dentro un fotogramma (chiuso
  da tre test unitari, rossi sul comportamento vecchio).
- Il contenitore che scorre si ricontrolla a ogni risposta dell'osservatore: passando da griglia a
  lista lo scorrimento cambia contenitore e la riga no (COLVOL-06, rosso sul bundle di prima).
- La barra delle schede scorre come la barra delle tab del layout (stessa barra di scorrimento
  nascosta, nessun dirottamento della rotella verticale).
