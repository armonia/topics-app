# Delta: chat — i tool che al runtime nativo mancavano

## ADDED Requirements

### Requirement: CHAT-NTOOL-01 — Il piano del turno esiste anche senza la CLI

Il runtime nativo SHALL offrire uno strumento per scrivere la lista di cose da
fare del turno, e SHALL emetterlo nella forma che il client già disegna: una
chiamata di nome `todo_write` che porta `todos` come elenco di
`{ content, status, activeForm? }` con `status` in `pending | in_progress |
completed`. La chiamata NON SHALL toccare il disco né eseguire alcunché: il suo
risultato è la lista nel trascritto, da cui discendono la card e la striscia
appiccicata sopra il compositore (CHAT-TODO-01).

Lo strumento SHALL rifiutare una forma che renderebbe una card vuota o muta
(elenco assente o vuoto, `content` vuoto, `status` sconosciuto) con un messaggio
che nomina il valore ricevuto e i valori buoni. SHALL rispondere, quando accetta,
con il conteggio per stato. Più di un passo `in_progress` SHALL essere segnalato
e NON SHALL essere rifiutato.

Lo strumento SHALL essere concesso anche al livello di autonomia `ask`: quella
modalità chiede di proporre un piano, e negarle lo strumento del piano lo
ridurrebbe a prosa che nessuna parte dell'interfaccia mostra.

La MISURA di questa requirement è la striscia sopra il compositore: su una
sessione nativa che sta lavorando a un compito di tre o più passi, deve essere
piena come su una sessione CLI, non vuota.

#### Scenario: La lista arriva alla striscia, non solo al trascritto
- **GIVEN** una chat servita dal runtime nativo
- **WHEN** il modello chiama `todo_write` con tre voci, una `in_progress`
- **THEN** la chiamata è riconosciuta come `detail.type = 'todo'` al confine
  dello stream (nessun JSON grezzo a schermo)
- **AND** la striscia sopra il compositore mostra la voce in corso e il conteggio

#### Scenario: Una lista che renderebbe una card vuota non passa
- **GIVEN** un turno nativo
- **WHEN** il modello chiama `todo_write` con `todos: []`, oppure con una voce
  dal `content` vuoto
- **THEN** il risultato è un errore leggibile, non una card vuota in chat
- **AND** il turno prosegue (l'errore torna come risultato del tool, non come
  eccezione)

#### Scenario: Uno stato inventato dice quali sono quelli buoni
- **GIVEN** un turno nativo
- **WHEN** una voce arriva con `status: "quasi"`
- **THEN** il messaggio d'errore nomina `"quasi"` e i tre stati ammessi
- **AND** nessuna parte della lista viene mostrata a metà

#### Scenario: Due passi in corso si segnalano, non si rifiutano
- **GIVEN** un turno nativo
- **WHEN** la lista arriva con due voci `in_progress`
- **THEN** la lista è accettata e mostrata
- **AND** il risultato contiene la nota che ne va tenuta una sola

#### Scenario: In «chiedi prima» il piano si scrive lo stesso
- **GIVEN** una topic con autonomia `ask`
- **WHEN** il modello chiama `todo_write`
- **THEN** la chiamata è consentita
- **AND** `write_file`, `edit_file` e `bash` restano rifiutati nello stesso turno

### Requirement: CHAT-NTOOL-02 — Un URL diventa testo leggibile, o una spiegazione

Il runtime nativo SHALL offrire uno strumento che scarica un URL e ne restituisce
il contenuto in una forma che valga i token che costa. HTML SHALL essere
convertito in markdown conservando titoli con il loro livello, elenchi come
righe, blocchi di codice con la loro indentazione e link con l'indirizzo risolto
in assoluto sulla pagina di partenza; JSON SHALL essere restituito indentato;
testo semplice intatto.

Lo strumento SHALL accettare soltanto `http` e `https`, e SHALL rifiutare ogni
altro schema PRIMA di qualunque accesso: `file:` e `data:` sarebbero una lettura
di disco arbitraria dentro un livello in cui gli strumenti di file sono murati
nella workspace. SHALL leggere il corpo con un tetto MENTRE arriva, senza mai
materializzare in memoria una risposta di dimensione arbitraria. SHALL avere un
limite di tempo, e SHALL interrompersi quando il turno viene annullato.

Ciò che non è testo SHALL essere NOMINATO (tipo e dimensione) invece di essere
restituito al modello. Una risposta di errore HTTP SHALL portare lo stato E il
corpo della spiegazione del server. Una pagina il cui contenuto è costruito in
JavaScript SHALL dichiarare che non c'è testo leggibile e perché, invece di
tornare vuota.

Lo strumento SHALL essere concesso anche al livello `ask`: è una GET senza corpo,
non scrive niente, ed è ciò che serve per proporre un piano invece di indovinarlo.

#### Scenario: Una pagina di documentazione arriva come markdown
- **GIVEN** un turno nativo
- **WHEN** il modello chiama `web_fetch` su una pagina HTML con titolo, elenco e
  un link relativo
- **THEN** il risultato contiene il titolo, i titoli interni con il loro livello
  e una riga per voce di elenco
- **AND** il link porta il suo indirizzo assoluto (seguibile con una seconda
  chiamata)
- **AND** il contenuto di `<script>` e `<style>` non compare

#### Scenario: Uno schema che uscirebbe dal perimetro non tocca la rete né il disco
- **GIVEN** un turno nativo, a qualunque livello di autonomia
- **WHEN** il modello chiama `web_fetch` con `file:///etc/passwd`
- **THEN** la chiamata è rifiutata prima di aprire alcunché
- **AND** il messaggio dice quali schemi sono ammessi e quale strumento usare per
  un file locale

#### Scenario: Un binario è nominato, non riversato addosso al modello
- **GIVEN** un URL che risponde `image/png`
- **WHEN** il modello lo chiede con `web_fetch`
- **THEN** il risultato è un errore che nomina il tipo di contenuto
- **AND** nessun byte del binario entra nel contesto

#### Scenario: Un errore HTTP porta la spiegazione del server
- **GIVEN** un URL che risponde 401 con un corpo che spiega cosa manca
- **WHEN** il modello lo chiede
- **THEN** il risultato contiene lo stato e il testo della spiegazione
- **AND** è marcato come errore, così il modello non lo legge come contenuto

#### Scenario: Una pagina dipinta dal browser lo dichiara
- **GIVEN** un URL che risponde HTML senza testo (il contenuto lo costruisce uno
  script)
- **WHEN** il modello lo chiede
- **THEN** il risultato dice che non c'è testo leggibile e che questo strumento
  non esegue JavaScript
- **AND** il modello ha di che scegliere un'altra strada invece di ripetere la
  stessa chiamata

#### Scenario: Mezzo mega non entra in un contesto
- **GIVEN** un URL che risponde 500 kB di testo
- **WHEN** il modello lo chiede con un tetto di 5.000 caratteri
- **THEN** il risultato sta dentro il tetto e dichiara di essere troncato
- **AND** il resto della risposta non viene scaricato

#### Scenario: Un turno annullato non apre la connessione
- **GIVEN** un turno il cui segnale è già annullato (spegnimento o stop
  dell'utente)
- **WHEN** viene eseguito un `web_fetch`
- **THEN** nessuna richiesta parte
- **AND** il risultato dice che il turno è stato annullato, non che la rete è
  guasta

### Requirement: CHAT-NTOOL-03 — Uno strumento che a runtime fallisce NON si dichiara

Il runtime nativo NON SHALL dichiarare al modello strumenti che, sulla macchina
in cui gira, non possono funzionare. Uno strumento dichiarato è un invito a
usarlo: quando risponde «credenziale assente» costa due giri prima che il modello
si arrenda, e il turno esce peggiore che se lo strumento non fosse mai esistito.

In particolare, e finché le condizioni qui sotto non cambiano:

- **Ricerca web.** Il runtime NON SHALL offrire un `web_search` proprio finché non
  esiste una credenziale di ricerca risolvibile (chiave in Impostazioni o
  variabile d'ambiente documentata). La capacità NON è assente dal prodotto: la
  flotta MCP nativa monta i server configurati dall'utente, quindi un server di
  ricerca configurato arriva al modello come `mcp__<server>__<tool>` senza che
  questo repository conosca nessuna chiave.
- **Sub-agente.** Il runtime NON SHALL offrire un `task` finché non ha un turno
  annidato sicuro, cioè finché non esistono e non sono provati: un limite di
  PROFONDITÀ (distinto dal tetto dei giri, che vale dentro un turno solo), un
  BUDGET del figlio che rientra nel registro d'uso del padre, un CANALE verso
  l'interfaccia che alimenti la card del sub-agente (oggi ce l'ha solo lo stream
  della CLI), e la PROPAGAZIONE dell'annullamento dal padre al ciclo e ai tool
  del figlio.

#### Scenario: Nessuna credenziale, nessuno strumento di ricerca dichiarato
- **GIVEN** un'installazione senza credenziale di ricerca
- **WHEN** un turno nativo compone l'elenco degli strumenti
- **THEN** nessuno strumento di ricerca proprio compare fra quelli dichiarati
- **AND** il modello risolve la ricerca con gli strumenti MCP presenti, se ce ne
  sono

#### Scenario: Nessuna ricorsione spedita per sbaglio
- **GIVEN** un turno nativo
- **WHEN** il modello cerca uno strumento per delegare a un sub-agente
- **THEN** non lo trova
- **AND** il turno prosegue con gli strumenti che ci sono, invece di aprire un
  annidamento senza fondo, senza budget e invisibile in chat
