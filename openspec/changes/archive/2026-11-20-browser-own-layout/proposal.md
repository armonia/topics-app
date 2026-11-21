# browser-own-layout — ognuno la sua misura

## Perché

Attilio, 14/10: «l'ultimo browser che attivo fa ridimensionare alla sua dimensione l'altro».
Era il disegno di TOPIC-BROWSER-05: la pagina vera del Mac prendeva la misura del
dispositivo che la usava, e l'altro la vedeva in scala. Scelta sua: ognuno la sua misura.

## Cosa cambia

Su una pagina ospitata dal Mac:

- il Mac non viene più ridimensionato per un altro dispositivo;
- l'iPad impagina la sua copia (il mirror rrweb) alla misura della sua pane, a scala 1: il CSS della
  pagina, media query comprese, decide il layout per quella larghezza;
- un tocco porta l'id rrweb dell'elemento toccato e il punto dentro il suo rettangolo: il Mac lo
  ritrova nel suo layout, anche se lì sta altrove o è nascosto;
- lo scroll viaggia come ancora (l'elemento alla linea di lettura e la frazione dentro di lui), nei
  due sensi: stesso contenuto in cima, misure diverse;
- un interruttore per dispositivo riporta al comportamento di prima («pagina alla misura di questo
  schermo»), per i siti che si impaginano in JavaScript.

## Barra

`specs/acceptance.md`. In breve: e2e WebKit con l'host vero del Mac (1200×800) e una pane
del visore da 1024 di larghezza, sei scenari verdi, rossi sul codice di main; unitari e mutanti sul
punto critico; `qa-gate.sh --veloce` verde; e2e vicine verdi; ciò che è verde resta verde.

## Fuori

- Pagine servite dal Chromium del server (Mac spento): resta TOPIC-BROWSER-05.
- Misure scritte in px dagli script della pagina per la larghezza del Mac: il mirror reimpagina solo
  il CSS. Limite noto, coperto dall'interruttore.
- Selezione trascinando, hover, drag: come oggi.
- Un visore dentro il guscio Tauri (mirror non interrogabile): resta come oggi.

## Deciso da me

- Linea di lettura al 25% dell'altezza visibile, saltando gli elementi fixed e sticky; senza
  elemento utile si ripiega sul rapporto di scroll.
- Il Mac, quando raggiunge l'ancora del visore, rimanda indietro quella stessa ancora: l'eco si
  riconosce esatta e il mirror non salta a fine gesto (la lezione della #313).
- In cima e in fondo vale il bordo, non la linea di lettura: un Mac in cima alla pagina ha il
  visore in cima, anche se alla sua linea di lettura c'è una card che sull'iPad sta 600 px più giù.
- L'interruttore sta nel livello Sessione del foglio della scheda: «Misura: questo schermo» /
  «Misura: del Mac». Nel guscio desktop resta la misura del Mac.
- Un tocco arriva all'elemento toccato, mai a un suo discendente che il Mac disegna lì (un link
  dentro il paragrafo); un elemento che il Mac non ha più non si scambia col pixel del mirror.
- Se ciò che scorre da una parte non scorre dall'altra (un breakpoint sposta lo scroll dalla pagina
  a un contenitore), l'ancora si piazza col contenitore che scorre lì.
- La riga «Resa» del foglio sparisce sotto un host nativo: lì non c'è niente da commutare.
- Un dispositivo che si impagina da sé, usando la pagina, la restituisce al Mac alla sua misura.
