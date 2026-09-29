# Layout — una tab, tre zone

## ADDED Requirements

### Requirement: TABSLOT-01 — Il nome di una tab non sparisce e non si sposta

Una tab della barra SHALL avere tre zone, in quest'ordine: l'icona, il nome, lo
slot. L'icona e lo slot SHALL avere una larghezza fissa. Il nome SHALL prendere
lo spazio che resta, e SHALL mai scendere sotto i 56 px. A riposo nessun altro
elemento SHALL stare fra il nome e lo slot.

Un cambio di stato SHALL NON spostare il nome: un segnale che compare, che
cambia testo o che sparisce, e il passaggio del mouse, lasciano il bordo
sinistro e la larghezza del nome dove erano. I comandi che al passaggio
compaiono in più dello slot (il menu ⋯ del browser) SHALL coprire la coda del
nome, senza stringerlo.

#### Scenario: tutti i segnali insieme
- **GIVEN** una tab di progetto con icona, attenzione, lavoro in corso, spillo e condivisione con un'organizzazione
- **THEN** il nome SHALL essere largo almeno 56 px

#### Scenario: lo stato cambia, il nome resta
- **GIVEN** una tab di chat
- **WHEN** passa da riposo a lavoro, poi ad attenzione, poi al passaggio del mouse, poi a fermata
- **THEN** il bordo sinistro e la larghezza del nome SHALL restare identici in tutti gli stati

### Requirement: TABSLOT-02 — Lo stato sta sempre a destra, in un solo slot

Lo slot SHALL essere l'ultima zona della tab, largo 20 px, allo stesso x in ogni
stato, e SHALL essere riservato anche quando è vuoto. Ogni segnale SHALL stare
dentro i suoi 20 px, anche «99+» e in qualunque font dell'interfaccia (DejaVu
Sans della CI Linux compreso); il numero esatto SHALL stare nel nome
accessibile della tab. A riposo SHALL mostrare
UN solo segnale, secondo questa precedenza:

1. pausa (un comando che Topics ha fermato): il fiocco;
2. lavoro: l'anello di caricamento; se c'è anche attenzione, l'anello SHALL
   girare attorno al numero;
3. attenzione: il numero, o il pallino quando il numero non ha senso;
4. niente.

Sulla tab di un progetto aperto (selezionata) i segnali aggregati dei figli
restano spenti, come prima: li mostra la sua barra.

#### Scenario: lo slot non si muove
- **GIVEN** una tab di chat
- **WHEN** passa da vuota a lavoro, ad attenzione, al passaggio del mouse
- **THEN** lo slot SHALL avere lo stesso x e la stessa larghezza in ogni stato

#### Scenario: un numero a tre cifre
- **GIVEN** una tab di chat con 150 messaggi da leggere
- **THEN** lo slot SHALL mostrare «99+» dentro i suoi 20 px anche nel font più largo (Verdana, DejaVu Sans), e il nome accessibile della tab SHALL dire 150

#### Scenario: lavoro e attenzione insieme
- **GIVEN** una tab di progetto chiusa con 13 cose in attesa e un figlio al lavoro
- **THEN** lo slot SHALL mostrare il 13 con l'anello attorno, e nient'altro

### Requirement: TABSLOT-03 — I segnali di contorno non costano il nome

Sulla tab SHALL NON comparire lo spillo del fissaggio, il tempo di lavoro, il
segno «ha aperto un browser» né quello del cloud: la riga di sidebar li mostra,
e il nome accessibile della tab li dice.

Il marcatore di progetto (CHROME-14), l'avviso di condivisione con
un'organizzazione, gli errori della console di un browser e il tipo di un
browser (agente al volante, connessione assente o lenta, pagina pesante,
Chromium vero, condiviso) SHALL stare in un segno d'angolo sull'icona, largo
zero: quando un segno compare o sparisce il nome SHALL NON spostarsi. Se ne
vale più d'uno, vince l'avviso di organizzazione, poi gli errori, poi il
marcatore di progetto. Su un browser vince uno stato della pagina (agente,
connessione, pesante), poi gli errori, poi i fatti (Chromium vero, condiviso).
I download di un browser SHALL stare nel suo menu ⋯.

#### Scenario: la tab fissata
- **GIVEN** una tab fissata
- **THEN** SHALL NON portare lo spillo, e la sua riga fra i Fissati SHALL restare

#### Scenario: il tipo del browser va e viene
- **GIVEN** una tab browser senza tipo
- **WHEN** l'agente prende il volante, e poi lo restituisce
- **THEN** il tipo SHALL comparire sull'angolo della favicon, e il bordo sinistro e la larghezza del nome SHALL restare identici

## MODIFIED Requirements

### Requirement: CHROME-12 — Prima si ferma, poi si chiude, e il segnale di lavoro sta in coda

Al passaggio del mouse, o col fuoco da tastiera, lo slot di una tab (TABSLOT-02)
SHALL diventare UN comando, nello stesso punto del segnale che sostituisce:
FERMARE se la tab ha un turno vivo che si può fermare, altrimenti CHIUDERE.
Fermato il turno, lo stesso slot SHALL diventare CHIUDERE. Nella tab SHALL NON
comparire mai Ferma e Chiudi affiancati. La tab di un PROGETTO SHALL NON offrire
Ferma: un clic accanto alla chiusura fermerebbe tutti i suoi agenti.

Su un dispositivo touch, dove il passaggio del mouse non esiste, il comando
SHALL stare sulla tab selezionata, con la stessa regola.

Il comando di stop SHALL essere lo STESSO del compositore della chat: un secondo
percorso per fermare un turno è un secondo modo di fermarlo a metà.

Nella riga della barra laterale il binario dei comandi resta com'era: Ferma e
poi Chiudi, in quest'ordine, e il segnale di lavoro ULTIMO, nello slot del
comando di chiusura.

Il glifo di caricamento SHALL essere UNO per tutte le superfici e SHALL venire
dal set di icone del prodotto: mai un'emoji, mai un disegno di questa sola
superficie.

Un tempo che SCORRE SHALL distinguersi da un tempo FINITO per il MOVIMENTO, non
per la tinta: il numero vivo SHALL restare nell'inchiostro normale del testo e
SHALL conservare la propria animazione.

#### Scenario: la scheda che streama
- **GIVEN** una tab di chat con un turno in corso
- **WHEN** ci si passa sopra col mouse o ci si arriva da tastiera
- **THEN** lo slot SHALL mostrare Ferma, e nessun Chiudi accanto

#### Scenario: fermare e poi chiudere
- **GIVEN** una tab con un turno in corso
- **WHEN** si preme Ferma nello slot
- **THEN** il turno SHALL terminare, la tab SHALL restare aperta, e lo stesso slot SHALL diventare Chiudi

#### Scenario: la scheda ferma
- **GIVEN** una tab senza turno in corso
- **THEN** lo slot al passaggio SHALL mostrare il solo comando di chiusura

#### Scenario: il progetto
- **GIVEN** una tab di progetto con figli al lavoro
- **WHEN** ci si passa sopra
- **THEN** lo slot SHALL mostrare Chiudi, mai Ferma

### Requirement: CHROME-14 — Una scheda di progetto si legge come tale, in ogni stato

Una scheda di progetto SHALL portare un marcatore di tipo, distinto dall'icona
reale del progetto, e SHALL restare visibile tanto a riposo quanto
SELEZIONATA. Il marcatore SHALL essere un segno d'angolo sull'icona
(TABSLOT-03), largo zero: non SHALL togliere spazio al nome. Un progetto senza
un'icona spedita SHALL mostrare al suo posto l'icona di tipo progetto. Quando il
segno d'angolo è l'avviso di condivisione con un'organizzazione, che solo un
progetto porta, quell'avviso vale anche come marcatore di tipo.

#### Scenario: progetto senza favicon, a riposo
- **GIVEN** una scheda di progetto che non ha un'icona spedita
- **THEN** SHALL portare comunque il marcatore di tipo progetto

#### Scenario: progetto senza favicon, selezionato
- **GIVEN** la stessa scheda, ora selezionata
- **THEN** il marcatore di tipo SHALL restare visibile

#### Scenario: una chat non lo porta
- **GIVEN** una scheda di chat, in qualunque stato
- **THEN** NON SHALL portare il marcatore di tipo progetto
