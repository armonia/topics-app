# Spec delta — tab-is-the-chrome

### Requirement: BROWSER-CHROME-01 — La tab e' l'unica chrome della pane

Una pane browser SHALL avere UNA sola superficie di chrome: la sua tab. NON
SHALL esistere una riga dell'indirizzo separata, ne' un popover separato che
ripeta indirizzo e comandi.

La tab SHALL avere tre stati: a riposo il TITOLO della pagina; attiva
l'INDIRIZZO leggibile; al FOCUS un input con l'indirizzo modificabile, i
suggerimenti e i comandi della pane.

Il motivo e' misurato, non estetico: finche' la riga dell'indirizzo e' esistita
come superficie separata, e' stata corretta CINQUE volte per lo stesso sintomo
— restava accesa quando non serviva — e ogni cura ha chiuso una via lasciandone
altre. Una superficie che non esiste non puo' restare accesa.

Lo stato di focus NON SHALL essere un popover portato fuori dalla tab: un
popover dentro un contenitore che si chiude muore al primo click, ed e' una
trappola gia' pagata in questo repo.

I pixel liberati dalla riga SHALL andare alla pagina su TUTTI i rami di
rendering (nativo, iframe, streaming), sempre — non condizionatamente.

#### Scenario: pagina caricata
- **GIVEN** una pane su una pagina caricata
- **THEN** NON SHALL esserci nessuna riga dell'indirizzo, e la tab SHALL dire il titolo

#### Scenario: pane aperta da un agente
- **GIVEN** una pane aperta da un agente per la via `browser:force-open`
- **THEN** la tab SHALL portare il titolo e NON SHALL comparire nessuna riga

#### Scenario: focus sulla tab
- **GIVEN** una tab attiva che riceve il focus
- **THEN** SHALL diventare un input con l'indirizzo modificabile e i suggerimenti
- **AND** Escape SHALL riportarla allo stato attivo senza navigare
