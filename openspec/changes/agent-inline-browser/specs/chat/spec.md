## ADDED Requirements

### Requirement: CHAT-TOOL-05 — Il browser dell'agent è una card inline, non una pane

Un'apertura browser `inline` fatta dall'agent (BROWSER-03) SHALL essere rappresentata
nel thread da una **card di tool browser** al posto della riga muta odierna. La card
SHALL mostrare: favicon, titolo della pagina, host, numero di passi che l'agent ha
fatto su quel contesto, e lo stato (vivo / sospeso / aperto come pane). A fine
utilizzo la card SHALL restare nel thread **collassata**, come traccia permanente, e
SHALL essere riespandibile in qualsiasi momento.

Espansa, la card SHALL mostrare l'ultimo **fotogramma** della pagina, l'URL completo,
la lista dei passi, e i comandi "Apri come pane" e "Chiudi". La card NON SHALL mai
ospitare un motore di navigazione vivo (nessuna webview nativa, nessun pannello
browser montato dentro il messaggio): inline è sempre un'immagine ferma; il vivo
esiste solo dopo la promozione a pane. Il fotogramma SHALL essere salvato come file e
referenziato per path nello stato sincronizzato, mai incorporato come dato nel
documento di stato.

La card SHALL essere **derivata** dallo stato delle sessioni inline del topic: quando
quello stato non è disponibile (thread vecchio, sincronizzazione non ancora arrivata)
la card SHALL degradare a URL + titolo presi dal risultato del tool, senza errori né
spazi vuoti.

Ogni sessione inline (viva o sospesa) di un topic SHALL comparire anche in sidebar
come **riga annidata sotto quel topic**, con titolo della pagina (o host), stato
visibile e la stessa azione di apertura. Una sessione già promossa a pane NON SHALL
comparire due volte: vale la rappresentazione della pane.

#### Scenario: a fine utilizzo la card resta collassata nel thread
- **GIVEN** un agent che ha aperto inline una pagina e ne ha estratto il testo
- **WHEN** il turno finisce
- **THEN** nel thread resta una card browser collassata con titolo, host e numero di passi, e il layout dell'utente non è cambiato

#### Scenario: riprendere dalla card
- **GIVEN** una card browser collassata di una sessione sospesa
- **WHEN** l'utente la espande e clicca "Apri come pane"
- **THEN** si apre una pane vera sulla stessa pagina (stesso `contextId`) e la card indica che la sessione è ora aperta come pane

#### Scenario: nessuna webview dentro il messaggio
- **GIVEN** una card browser espansa in una chat che scorre
- **WHEN** l'utente scorre la conversazione o apre un menu sopra la card
- **THEN** la card si comporta come qualsiasi altro contenuto del messaggio (nessun riquadro nativo che resta sopra gli altri elementi, nessun ritaglio)

#### Scenario: sotto-elemento in sidebar
- **GIVEN** un topic con due sessioni browser inline dell'agent
- **WHEN** l'utente guarda l'albero in sidebar
- **THEN** sotto quel topic compaiono due righe annidate con il titolo delle pagine, e cliccarne una apre quella pagina come pane

#### Scenario: degrado senza stato
- **GIVEN** un thread caricato prima che la sincronizzazione dello stato inline arrivi
- **WHEN** la card viene renderizzata
- **THEN** mostra URL e titolo dal risultato del tool, senza errori
