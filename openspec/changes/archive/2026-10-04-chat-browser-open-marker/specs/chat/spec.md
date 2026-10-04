# Chat — il browser aperto dall'agente si vede nel turno

## ADDED Requirements

### Requirement: CHAT-BROWSER-01 — Un'apertura del browser lascia un segno nel turno, e il segno non si piega

Una chiamata riuscita di `open_browser_pane` (anche col prefisso `mcp__topics__`) o di
`browser_open` SHALL essere resa nel transcript come un **segno di browser aperto** al
posto della riga generica di tool MCP. Il segno SHALL mostrare: il favicon della
pagina (un'icona di globo finché manca), un titolo (il nome dato dall'agente, altrimenti
il titolo della pagina, altrimenti il dominio), il dominio, e lo stato corrente della
pagina (nella finestra della topic, in una tab, chiusa, non a schermo). Il segno NON
SHALL contenere una webview, uno stream o un'immagine della pagina.

Il segno SHALL stare nel punto del turno in cui la chiamata è avvenuta e SHALL restare
visibile anche dopo:

- NON SHALL entrare nella riga di sintesi di un gruppo di tool (`CHAT-TOOL-02`): il
  gruppo si spezza attorno al segno e i suoi conteggi non lo includono;
- NON SHALL essere nascosto dal riepilogo di un turno finito: come un'immagine, resta
  fra ciò che si vede, prima della risposta, nell'ordine in cui è comparso;
- nella chat di un task (`CHAT-TOOL-06`), dove l'accordion ripiega messaggi interi e
  non riordina, i segni di un tratto piegato SHALL comparire nella riga di riepilogo
  dell'accordion, con lo stesso titolo e lo stesso clic.

Dentro uno stesso messaggio, aperture successive sullo stesso contesto SHALL produrre
un segno solo, nella posizione della prima, che mostra l'ultima pagina aperta e quante
sono; aperto, il segno SHALL elencarle in ordine. Aperture su contesti diversi SHALL
restare segni distinti.

Un'apertura fallita (tool in errore) NON SHALL diventare un segno: resta la riga di tool
di sempre, col suo errore, dentro il gruppo.

#### Scenario: l'apertura si vede nel punto del turno in cui è successa
- **GIVEN** un turno finito con 12 tool call, di cui la settima è `open_browser_pane` riuscita su `http://localhost:5173/` con titolo «Vite App», e una risposta finale
- **WHEN** l'utente apre la chat
- **THEN** fra il riepilogo piegato del lavoro e la risposta si vede un segno con titolo «Vite App» e dominio `localhost:5173`
- **AND** la riga di riepilogo conta 11 azioni, non 12

#### Scenario: fuori dalla riga «N azioni» mentre il turno scorre
- **GIVEN** un turno in streaming con tre `Read`, un `open_browser_pane` riuscito e altri tre `Read`
- **WHEN** i tool sono completati
- **THEN** il transcript mostra il gruppo dei primi tre, il segno, e il gruppo degli ultimi tre, in quest'ordine

#### Scenario: tre aperture sullo stesso contesto fanno un segno solo
- **GIVEN** un messaggio con tre `open_browser_pane` riuscite sullo stesso `contextId`, su `/a`, `/b` e `/c` dello stesso sito
- **WHEN** il messaggio si disegna
- **THEN** c'è un solo segno, che mostra la pagina `/c` e dice «3 pagine»
- **AND** aprendolo si leggono le tre pagine in ordine

#### Scenario: due contesti, due segni
- **GIVEN** un messaggio con due `open_browser_pane` riuscite con `name` «App» e «Report» su due contesti diversi
- **WHEN** il messaggio si disegna
- **THEN** ci sono due segni, «App» e «Report»

#### Scenario: un'apertura fallita non finge di essersi aperta
- **GIVEN** una `open_browser_pane` in errore «navigation failed: goto: net::ERR_CONNECTION_REFUSED»
- **WHEN** il messaggio si disegna
- **THEN** non c'è nessun segno di browser aperto
- **AND** la chiamata è una riga di tool in errore, contata negli errori del suo gruppo

#### Scenario: un'apertura che non dichiara l'errore ma non ha caricato niente
- **GIVEN** nella chat di un task una `open_browser_pane` il cui risultato comincia con «navigation failed: goto: net::ERR_CONNECTION_REFUSED» e prosegue con «Browser context ready at …» (lì la navigazione non è fatale e la chiamata non è in errore), oppure una `browser_open` del percorso SDK che risponde `{error}` su una pane nativa
- **WHEN** il messaggio si disegna
- **THEN** non c'è nessun segno di browser aperto
- **AND** la chiamata resta la riga di tool generica che era

#### Scenario: nella chat di un task il segno sta nel riepilogo dell'accordion
- **GIVEN** la chat di un task con un tratto di lavoro piegato che contiene una `open_browser_pane` riuscita con `name` «Darkroom»
- **WHEN** l'utente guarda l'accordion chiuso
- **THEN** la riga di riepilogo mostra «Darkroom» col favicon della pagina
- **AND** i messaggi dell'accordion restano nel loro ordine

### Requirement: CHAT-BROWSER-02 — Il segno porta alla pagina, e la riapre se è stata chiusa

Un clic sul segno SHALL portare l'utente alla pagina di quel contesto nella superficie
in cui vive ora, in quest'ordine: una tab del layout (focalizzata), una tab del task
(il task si apre), la finestra della topic della chat che si sta guardando (la scheda
si attiva e la finestra, se nascosta, torna ridotta). Se la pagina non vive in nessuna
superficie, il clic SHALL riaprirla nella finestra della topic sullo stesso contesto e
sull'ultimo URL del segno; se quella chat non può ospitare una finestra (sotto 768 px,
chat dentro una finestra di progetto) SHALL aprirla come tab, come fa oggi un link.

Lo stato scritto sul segno SHALL essere derivato dalle superfici vive e aggiornarsi
quando la pagina cambia superficie o si chiude, senza ricaricare la chat. Il segno SHALL
essere raggiungibile da tastiera, con l'URL intero come nome accessibile.

#### Scenario: la pagina è nella finestra della topic
- **GIVEN** un segno il cui contesto è una scheda della finestra della topic, con la finestra nascosta
- **WHEN** l'utente clicca il segno
- **THEN** la finestra torna ridotta con quella scheda attiva
- **AND** il layout non cambia

#### Scenario: la pagina è diventata una tab
- **GIVEN** un segno il cui contesto è stato portato nel layout come tab
- **WHEN** l'utente clicca il segno
- **THEN** quella tab prende il focus e la finestra della topic non si apre

#### Scenario: la pagina è stata chiusa
- **GIVEN** un segno il cui contesto non è più in nessuna superficie
- **WHEN** l'utente guarda il segno
- **THEN** lo stato dice «chiuso»
- **WHEN** l'utente lo clicca
- **THEN** la pagina si riapre nella finestra della topic sullo stesso contesto
- **AND** lo stato diventa «nella finestra»

#### Scenario: lo stato segue la pagina
- **GIVEN** un segno con stato «nella finestra»
- **WHEN** l'utente chiude la scheda dalla finestra
- **THEN** il segno dice «chiuso» senza ricaricare la chat

### Requirement: CHAT-BROWSER-03 — Le righe già scritte diventano segni con quello che hanno

Il segno SHALL comparire anche sulle chiamate già salvate prima di questa change, con il
dettaglio registrato come tool MCP generico: il client SHALL riderivarle dal nome del
tool e dagli argomenti. Senza titolo nel risultato il segno SHALL mostrare il dominio
dell'URL; senza `contextId` SHALL usare il contesto predefinito della topic della chat
per il clic. Nessun dato storico SHALL essere riscritto.

#### Scenario: una riga vecchia senza risultato
- **GIVEN** una `open_browser_pane` salvata ad agosto con `args.url` = `http://127.0.0.1:3535/p/profilo` e nessun risultato
- **WHEN** la chat si apre
- **THEN** si vede un segno col dominio `127.0.0.1:3535`
- **AND** nessuna riga del DB cambia

#### Scenario: una riga vecchia col titolo nel risultato
- **GIVEN** una chiamata salvata col risultato `Opened browser pane at https://example.com/ (title: Example Domain)` e senza `contextId`
- **WHEN** la chat si apre
- **THEN** il segno mostra «Example Domain» e il dominio `example.com`
