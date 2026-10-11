# Chat — the native runtime delegates through child chats

## MODIFIED Requirements

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
- **Sub-agente.** Il runtime NON SHALL offrire un `task` che giri DENTRO il turno
  del padre finché non ha un turno annidato sicuro (limite di PROFONDITÀ, BUDGET
  nel registro d'uso, CANALE verso la UI, PROPAGAZIONE dell'annullamento). La
  delega SHALL passare invece da `spawn_agent`, il cui figlio è una chat a sé
  sul motore (SUBAGENT-18): le quattro condizioni le ha già come ogni chat — la
  profondità dalle righe `subagents` (SUBAGENT-15), l'uso nel registro della
  sua chat, la chat stessa come canale, il suo Stop, e lo Stop del padre che
  arriva ai figli al lavoro (SUBAGENT-19). Al tetto di profondità il runtime
  NON SHALL dichiarare gli strumenti dei sotto-agenti.

Dove cambiarla: scelta 1 di `subagent-nativi`.

#### Scenario: Nessuna credenziale, nessuno strumento di ricerca dichiarato
- **GIVEN** un'installazione senza credenziale di ricerca
- **WHEN** un turno nativo compone l'elenco degli strumenti
- **THEN** nessuno strumento di ricerca proprio compare fra quelli dichiarati
- **AND** il modello risolve la ricerca con gli strumenti MCP presenti, se ce ne
  sono

#### Scenario: Nessuna ricorsione spedita per sbaglio
- **GIVEN** un turno nativo
- **WHEN** il modello cerca uno strumento per delegare DENTRO il proprio turno
- **THEN** non lo trova
- **AND** delega con `spawn_agent`, che apre una chat figlia visibile, con la sua
  profondità e il suo Stop

#### Scenario: La delega del motore è una chat figlia, non un turno annidato
- **GIVEN** una chat sul motore
- **WHEN** compone l'elenco degli strumenti
- **THEN** nessun `task` compare, e `spawn_agent` sì
- **AND** il figlio che `spawn_agent` apre è una chat legata al motore

#### Scenario: Al tetto di profondità niente delega
- **GIVEN** la chat di un nipote (profondità 2)
- **WHEN** compone l'elenco degli strumenti
- **THEN** nessuno dei cinque strumenti dei sotto-agenti compare
- **AND** una chiamata costruita a mano a `spawn_agent` è rifiutata all'esecuzione
