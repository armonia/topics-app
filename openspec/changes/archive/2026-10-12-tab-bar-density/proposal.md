# Proposal — tab-bar-density

## Perché

Con lo split stretto le tab restano larghe 150 px (200/300 le browser) e la barra scorre di lato:
in una pane da 300 px se ne vedono due, le altre sono fuori vista e non si capisce nemmeno
quante sono. Attilio, 11/10: «se ci sono più tab e lo spazio è strettissimo, fare le tab tipo
a quadratino o comunque molto piccole, in modo che si riesca a capire e percepire», anche con
una tab sola.

## Cosa cambia

La larghezza delle tab dipende dallo spazio della barra, non solo dal tipo. Tre densità, scelte
da una funzione pura (`tabDensity`), ricalcolate solo quando cambia la larghezza disponibile o il
numero di tab, mai al passaggio del puntatore:

- **piena**: com'è oggi (150 / 200 / 300), finché ci stanno tutte;
- **compatta**: le tab si stringono in parti uguali fino a 76 px (icona + inizio del nome); la tab
  attiva non scende sotto 120;
- **quadratino**: se nemmeno la compatta ci sta, le tab non attive diventano quadrati alti quanto
  la tab (icona; per una chat l'iniziale sul colore del topic, così due chat si distinguono), con
  il segnale di attenzione sull'angolo; la attiva resta leggibile (almeno 96 px, nome e chiusura);
- oltre: lo scorrimento di oggi, che resta l'ultima rete.

Una tab sola non scorre mai: si stringe fino al quadratino. Chiudendo una tab col puntatore nella
barra le altre non si spostano finché il puntatore non esce (come Chrome): la prossima X è sotto
il dito. Nome intero sempre nel tooltip e nell'`aria-label`.

## Barra

`specs/acceptance.md`. In breve: unit di `tabDensity` + `tests/e2e/tab-bar-density.spec.ts` in
WebKit con video, rosso se la densità è forzata a «piena»; le spec delle tab esistenti restano
verdi.

## Fuori

Barra del telefono (una pane alla volta), sidebar, ordine e trascinamento delle tab, la barra della
finestra browser di un topic, nuove impostazioni.

## Deciso da me

Soglie 76 / 120 / 96 px e quadratino = altezza della tab; sulle tab quadratino non attive niente X
(si chiudono dal menu, dal tasto centrale o attivandole), come Chrome: una X da 14 px in un
quadrato da 28 è un clic sbagliato garantito.
