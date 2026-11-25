# Verifica di Topics: Topics si accorge da solo quando non fa il suo lavoro, e ripara ciò che sa riparare

## Da decidere
Niente: deciso il 22/11. Costo previsto:
- costruzione una tantum: 4 card Sonnet;
- giro dei 5 minuti: zero token;
- giro giornaliero: una lettura AI al giorno;
- indagini: al massimo 3 al giorno, solo sui rossi che il codice non sa curare.

## Deciso da me
- 21/11: «di queste cose dovresti accorgertene da solo… in generale su tutto Topics, forse abbiamo già le automazioni».
- 21/11: «dovrebbe essere un'unica automazione di verifica di tutto Topics», con livelli di controllo sensati; «poi consuma token?».
- 22/11: «ne facciamo sia uno ogni 5 minuti con tutte cose deterministiche e uno al giorno sia deterministiche che non… da valutare bene per ogni automazione… non può essere automatico in caso di problemi direttamente?»

## Perché
Il 21/11 Topics ha perso ore di lavoro senza che nessuno se ne accorgesse:
- un nodo cloud ha dato 0 posti su 4 per 9 ore su 12;
- 27 card sono state mandate a un PC spento;
- una card ha girato 11 volte in 35 minuti fra due nodi.

Il censimento del 22/11 ha contato 300 automazioni, di cui 69 riguardano Topics. Un controllo è rosso da 7 giorni, con card in corso ferme da 26 a 82 ore, e nessuno agisce. Sentinelle in più non servono: serve un giro che misura il risultato (ore perse) e, quando è rosso, agisce.

## Cosa cambia
Una riga **«Verifica di Topics»** nella vista Automazioni, con due giri.

**Ogni 5 minuti, solo codice (zero token).** Il server legge il proprio DB e tiene tre voci, ciascuna misurata in ore perse:
1. **Le card avanzano.** Card in todo che non partono. Card in corso senza un turno vivo né una domanda aperta a una persona. Rimbalzi fra macchine, contati dalle note «Spostata su …».
2. **I nodi danno i posti promessi.** Posti dichiarati ma non usabili mentre c'è coda: nodo svuotato, appeso, o spento ma scelto.
3. **Le automazioni dichiarate superano la loro prova.** Elenco nelle impostazioni (nome, comando di prova, giro). Il default è vuoto e funziona lo stesso.

**Una volta al giorno: gli stessi conti sulle 24 ore, più una lettura AI.** La lettura copre ciò che il codice non sa giudicare:
- errori mai visti nel log del giorno;
- automazioni senza prova: il loro esito ha senso?;
- card ferme: per un buon motivo o no?

Ne esce una riga col verdetto. Se è rossa, diventa una card.

**Ripara da solo ciò che sa riparare.** Ogni causa nota ha la sua cura nel codice. La cura è reversibile ed è scritta sulla riga e sulla card toccata. Una causa sconosciuta, o una cura non reversibile, apre **una** card d'indagine nella board scelta: una per problema, con un tetto al giorno.

## Scelte tecniche (le ho prese io)
- Codice in `server/services/topics-check.ts`: funzioni pure più un timer. Una tabella di campioni ogni 5 minuti, tenuta 7 giorni.
- Le cure sono funzioni con un nome e un test ciascuna. Dove il dispatcher ha già la cura, la Verifica la chiama e non la riscrive.
- Configurazione generica (regola zero): soglie, elenco delle automazioni con prova, board delle indagini, tetto giornaliero e modello della lettura stanno nelle impostazioni. Default: riga visibile, cure attive, indagini spente finché non si sceglie una board.

## Barra
In `specs/acceptance.md`, una per traccia. Ciò che è verde resta verde.

## Fuori
- Il controllo che il server è vivo: resta fuori da Topics, perché un Topics fermo non può dirlo da sé.
- Pagine nuove: solo la riga e il suo dettaglio nella vista Automazioni.
- Cure irreversibili fatte in automatico.

## Non ancora specificato
- Quali automazioni senza prova meritano una prova vera. Si decide dopo una settimana di lettura giornaliera.
