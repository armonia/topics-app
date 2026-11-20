# Spec delta: tab-menu-unico (remote-browser)

## MODIFIED Requirements

### Requirement: TOPIC-BROWSER-02 — La tab è l'unica chrome, e si apre in un foglio

Una scheda browser SHALL avere una sola superficie di chrome: la sua tab. NON SHALL
esistere una riga dell'indirizzo separata, un menu a tendina dei comandi, né un
portale separato per modificare l'indirizzo. Il tasto destro sulla tab NON SHALL
aprire un menu a tendina: apre lo stesso foglio (`TABSHEET-01`).

Un clic sulla tab attiva, sui suoi tre puntini, oppure ⌘L SHALL aprire il **foglio
della tab** dalla porta dell'indirizzo; il tasto destro, la pressione lunga,
Shift+F10 e il tasto menu SHALL aprirlo dalla porta dei comandi (`TABSHEET-01`).
Il foglio nasce dalla tab, che si espande in lui, e contiene, in quest'ordine,
l'indirizzo (dalla porta dell'indirizzo in un campo già a fuoco e con il testo
selezionato), i comandi di navigazione, i suggerimenti (solo dalla porta
dell'indirizzo), e tutti i comandi della scheda raggiungibili senza un altro menu
a tendina: al primo livello o in un livello del foglio stesso (`TABSHEET-02`,
`TABSHEET-03`) — strumenti, zoom, dispositivo, sessione, dimentica sito, e lo
spostamento tra finestra e tab.

Il foglio SHALL vivere nel sottoalbero React della sua tab e SHALL sparire quando
quella tab sparisce. Il nodo DOM che lo ospita NON è vincolato: il vincolo è la
VITA del pannello, non il suo indirizzo nell'albero.

> Precisazione del 13/09, dopo una misura. La prima stesura diceva «il foglio NON
> SHALL essere un portale fuori dal contenitore della tab», e quella frase
> descriveva il rimedio invece del male. Il male era il vecchio
> `browser-address-dropdown`: un pannello che SOPRAVVIVEVA al proprio ancoraggio,
> perché una pane si chiude, cambia gruppo o torna tab mentre il suo pannello è
> aperto. Stare nel sottoalbero della tab è ciò che lo cura.
>
> Ma il nodo DOM non può stare lì: la striscia delle tab ha un antenato
> TRASFORMATO, e un antenato trasformato diventa il blocco contenitore di ogni
> `position: fixed` dentro di sé. Misurato sull'E2E di `BROWSER-CHROME-INLINE-01`:
> col pannello posato a `top: 8` il suo bordo superiore stava a **y = -3**,
> contro una tab il cui bordo inferiore è a 34 — un'altezza di striscia sopra il
> punto in cui era stato messo, cioè fuori dallo schermo. `createPortal` sul
> `body` tiene la vita React (muore con la tab) e restituisce al `fixed` la
> finestra come riferimento.

> Cosa cambia e perché (04/10). La versione precedente chiedeva «tutti i comandi
> della scheda disposti in chiaro», e lo scenario controllava che console, zoom e
> dispositivo fossero visibili senza aprire niente. Insieme alle voci del tasto
> destro, che ora entrano nello stesso foglio, una colonna in chiaro arriva a 39
> voci. I comandi restano nel foglio, a un livello di distanza; quello che resta
> vietato è un SECONDO menu a tendina.

Mentre il foglio copre la pagina, la pagina SHALL essere un fermo immagine. Invio
SHALL navigare e chiudere; Esc e un clic fuori SHALL chiudere senza navigare. Alla
chiusura la pagina SHALL tornare viva.

La stessa regola SHALL valere per la finestra della topic (`TABSHEET-04`) e per una
scheda in stato tab.

#### Scenario: un clic sulla tab dà l'indirizzo pronto da riscrivere
- **GIVEN** una scheda attiva su `https://example.com/a`
- **WHEN** l'utente fa clic sulla tab
- **THEN** il foglio è aperto, il campo indirizzo ha il fuoco e tutto il testo è selezionato
- **AND** console, zoom e dispositivo stanno nei livelli Strumenti e Pagina dello stesso foglio, e aprirli non apre nessun menu a tendina

#### Scenario: il tasto destro apre lo stesso foglio
- **GIVEN** una scheda su `https://example.com/a`
- **WHEN** l'utente fa tasto destro sulla tab
- **THEN** è aperto il foglio della tab con l'indirizzo visibile e senza fuoco
- **AND** nessun altro pannello di comandi è aperto

#### Scenario: nessuna riga dell'indirizzo, mai
- **GIVEN** una scheda su una pagina caricata, nei rami nativo, iframe e streaming
- **WHEN** l'utente apre la console dal foglio, oppure parte un download
- **THEN** non compare nessuna riga dell'indirizzo sopra la pagina

#### Scenario: Esc non naviga
- **GIVEN** il foglio aperto con l'indirizzo modificato ma non confermato
- **WHEN** l'utente preme Esc
- **THEN** il foglio si chiude, la scheda resta sull'URL di prima e la pagina è di nuovo viva
