## ADDED Requirements

### Requirement: TOPIC-FIRST-01 — Una topic già visitata si apre dalla copia locale, senza aspettare il server

Quando una chat ha la copia locale della sua coda (`messages-cache-*`, la stessa
coda della prima pagina, CHAT-HIST-01), riaprirla (ricarico, avvio, pane rimontata)
SHALL scoprire la lista su quelle righe appena Virtuoso le ha dipinte ferme in
fondo, SENZA aspettare la risposta della prima pagina. La risposta conferma le
righe a schermo, oppure aggiunge in fondo quelle arrivate nel frattempo, come un
messaggio che arriva sotto gli occhi.

La risposta NON SHALL anteporre righe a una lista già scoperta: quando la copia è
più corta della pagina (la fine di un turno la riscrive dimezzandola finché sta nel
tetto in byte), le righe della pagina sopra la prima della copia restano fuori come
storia parziale, e arrivano con il resto (pane nascosta, oppure «Carica i messaggi
precedenti»). Una lista virtuale indirizza le righe per indice: anteporle sotto gli
occhi disegna per un frame le righe sbagliate.

Questo requisito sostituisce, per il solo caso con copia locale, la clausola di
PERF-01 «revealed only once its TAIL is painted, authoritative and whole»: la
coda è dipinta e intera, e diventa autorevole quando arriva la risposta.

#### Scenario: al ricarico i messaggi arrivano dalla copia locale anche se il server tarda
- **GIVEN** una chat di 220 messaggi letta fino in fondo, con la copia locale scritta
- **AND** la richiesta della prima pagina trattenuta per 1,5 s
- **WHEN** la persona ricarica
- **THEN** la pane non è mai vuota: scheletro o righe dal suo primo frame
- **AND** le righe compaiono entro 30 frame (misurati 14-16; prima 75), prima che il server risponda
- **AND** nessuna riga si sposta, né all'arrivo della risposta

#### Scenario: una copia più corta della pagina non fa crescere la lista dall'alto
- **GIVEN** una chat di righe pesanti la cui copia locale tiene 10 righe e la cui prima pagina ne tiene 21
- **WHEN** la persona ricarica e la risposta arriva a lista scoperta
- **THEN** nessun frame perde l'ultimo messaggio e niente si sposta
- **AND** la chat è parziale (`data-history="partial"`): le 11 righe mancanti arrivano con il resto

#### Scenario: una risposta arrivata mentre la persona era via entra in fondo
- **GIVEN** una chat letta, e una risposta testuale arrivata sul server dopo
- **WHEN** la persona ricarica con la prima pagina trattenuta
- **THEN** la risposta compare in fondo, la vista resta in fondo, e il CLS del ritorno è 0
