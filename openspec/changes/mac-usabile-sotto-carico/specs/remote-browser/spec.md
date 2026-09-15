# Delta: remote-browser (mac-usabile-sotto-carico, tornata 4)

## ADDED Requirements

### Requirement: BROWSER-HEAVY-01 - Il consumo di una pane nativa si misura una volta per campione

Il 15/09/2026, con Mail in primo piano, la home di armonia-site su :4600 costava
16,9% di un core nel suo WebContent, 27,5% nella GPU e 55,3% su tutto Topics. La
riga per webview di `perf_metrics` doveva dirlo e non poteva: il campione leggeva
il contatore di CPU di ogni pid, e subito dopo la raccolta per webview lo rileggeva
sugli stessi pid, misurando i ~100 us fra due syscall (0,0 in 32 campioni su 40, da
61 a 468% negli altri, sulla stessa pane al 18,6%).

Dentro un campione di `perf_metrics` il contatore di CPU di ogni processo SHALL
essere letto UNA volta, e ogni consumatore dello stesso campione (totali, split
renderer/GPU, righe per webview) SHALL usare quel valore. Un processo senza delta
SHALL risultare non misurato (`null`), mai zero.

Su Windows ogni pane ha il suo ambiente WebView2 (`isolate: true`): la riga della
pane SHALL essere la somma dei processi del suo ambiente dalla stessa lettura unica,
con `pid` = processo browser dell'ambiente. Su Linux la lista resta vuota.

#### Scenario: la riga della webview e' il numero del campione
- **GIVEN** un processo figlio che brucia un core, mappato come webview
- **WHEN** due campioni lo leggono a 500 ms di distanza
- **THEN** la `cpu_percent` della sua riga SHALL essere uguale al valore del campione per quel pid, e almeno 20

### Requirement: BROWSER-HEAVY-02 - Una pane pesante si decide sul tempo, non su quante volte si e' guardato

Una pane SHALL essere pesante quando i campioni che contano, tutti ad almeno 8% di
un core, coprono almeno 10 s dal primo all'ultimo. Un campione SHALL contare solo se
la pane e' mostrata e non in pausa da almeno 8 s, se la pagina non sta caricando e se
non ha navigato negli ultimi 10 s. Un campione nullo, che non conta, o fra le due
soglie SHALL ricominciare la serie senza togliere il verdetto. Il verdetto SHALL
restare in pausa, SHALL cadere dopo 55 s di campioni vivi sotto il 3% e SHALL
ripartire da capo su una pagina nuova (origin + path). Un pid riportato da due pane,
o da una pane e da una finestra, non SHALL essere attribuito a nessuna.

#### Scenario: la cadenza del lettore non sposta il verdetto
- **GIVEN** la stessa pane al 17% letta ogni 5 s e ogni 2 s con campioni in cache duplicati
- **THEN** il verdetto SHALL arrivare nello stesso istante

#### Scenario: il guscio vecchio non produce pesanti
- **GIVEN** la serie della doppia lettura (32 zeri, 7 picchi, mai tre di fila)
- **THEN** nessuna pane SHALL essere pesante

### Requirement: BROWSER-HEAVY-03 - Una pane pesante resta viva solo col fuoco suo

Risposta del proprietario (3), letta alla lettera il 15/09 17:20: il fuoco e' quello
della pane. Una pane pesante SHALL restare viva solo se e' la pane a fuoco della sua
superficie e la sua finestra non e' nota come senza fuoco; un'anteprima pesante di
fianco alla chat in cui si scrive SHALL andare in pausa, anche nella finestra browser
del topic, il cui fuoco e' l'ultimo tocco (pointerdown o focus) dentro la finestra
contro uno fuori. Un agente che la guida, un'operazione in volo, l'inspector aperto
(su WebView2 letto dalla finestra in primo piano, che appartiene ai processi della
pane) o un elemento a schermo intero la SHALL tenere viva; un'esenzione trovata a
fine sosta SHALL riarmare la sosta, non annullarla. Il fuoco della
finestra SHALL arrivare dal guscio con un evento `topics:window-focus` su tutte e tre
le finestre (principale, pop-out, finestra gruppo); finche' nessuno risponde vale
come a fuoco. Fra la perdita del fuoco e la pausa SHALL passare una sosta di 2 s, e un
ritorno dentro la sosta non SHALL costare niente.

#### Scenario: l'agente al volante
- **GIVEN** una pane pesante guidata da un agente, in una finestra senza fuoco
- **THEN** la tab SHALL mostrare il glifo dell'agente e la pane non SHALL andare in pausa

#### Scenario: una pane in pausa dietro un'altra tab
- **GIVEN** una pane in pausa la cui tab non e' piu' quella attiva
- **WHEN** il verdetto pesante cade
- **THEN** la pane SHALL tornare viva senza che la vista nativa venga mostrata

### Requirement: BROWSER-HEAVY-04 - La pausa e' un fermo immagine chiaro, e il ritorno non ricarica

La pausa SHALL prendere il fermo immagine mentre la vista e' ancora a schermo,
disegnarlo a 1x, e SOLO dopo nascondere la vista nativa. La pane in pausa SHALL
mostrare il fermo con una scheda statica (titolo, una riga col consumo, «Riprendi»)
e la tab SHALL mostrare il glifo della pausa; la pane pesante viva SHALL mostrare il
glifo del consumo. L'agente resta il primo glifo e resta il bottone per riprendere il
controllo. Il ritorno SHALL mostrare lo stesso documento senza `browser_reload`,
`browser_navigate`, `browser_open` o `browser_close`, anche con un overlay aperto sopra
la pane in quel momento: la vista resta parcheggiata sotto il fermo finche' l'overlay
non si chiude. Un freeze chiesto su una pane in pausa non SHALL fotografare la vista
nascosta.

#### Scenario: ritorno con un overlay aperto
- **GIVEN** una pane in pausa e un menu aperto sopra il suo posto
- **WHEN** la pane torna viva
- **THEN** la vista SHALL restare parcheggiata senza nessuno screenshot
- **AND** alla chiusura del menu SHALL tornare al suo posto

### Requirement: BROWSER-HEAVY-05 - I poll di una pane tacciono quando nessuno la guarda

I poll di una pane nativa SHALL fermarsi con il documento nascosto e con la finestra
senza fuoco. I due eval (120 ms e 800 ms) SHALL fermarsi anche con la pane in pausa,
e i drain nativi (stato, errori, nuove schede, download) SHALL girare solo con la
pane a schermo, usata da un agente o, per i download, con un download in corso; con un
agente ingaggiato i drain SHALL girare anche con la finestra senza fuoco, perche' un
link aperto dall'agente in una nuova scheda non aspetti il ritorno della persona. Al
riaprirsi di ogni cancello SHALL arrivare una lettura di recupero, e nessuna mentre
un altro cancello e' ancora chiuso.

#### Scenario: download in corso
- **GIVEN** un download partito da una pane che poi esce di scena
- **THEN** il drain e l'avanzamento SHALL continuare finche' il download e' in corso
