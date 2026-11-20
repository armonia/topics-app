# Delta: accounts-orgs — «chi sono» ha un posto, e c'è sempre

## ADDED Requirements

### Requirement: ACCOUNT-04 — La sezione Account NON si nasconde, e dice chi sei e come si esce

L'applicazione SHALL avere UNA sezione, raggiungibile da un solo gesto dalle
impostazioni, che risponde a «chi sono su questa installazione»: il nome, la
faccia, l'indirizzo se c'è, il gruppo se c'è, il dispositivo con cui si sta
guardando, e il gesto per USCIRE.

La sezione SHALL comparire SEMPRE, anche senza nessun servizio degli account
configurato e senza nessun collegamento. Un'installazione senza servizio non è
un'installazione senza identità: ha già una persona proprietaria dal primo avvio.
Nascondere la sezione in quel caso è ciò che fa concludere a chi guarda che
l'identità non esiste.

Il NOME e l'INDIRIZZO della persona proprietaria SHALL essere modificabili
LOCALMENTE, senza rete e senza nessun servizio: è così che due installazioni
diventano due identità distinte senza che nessuno spedisca niente.

L'uscita SHALL essere un gesto presente nell'interfaccia, non solo una rotta.
SHALL essere DISTINTA dallo scollegare un account remoto, e SHALL dire quale
delle due sta per succedere: sono due gesti con due conseguenze diverse e un
solo bottone per entrambi le confonde nel momento peggiore.

Il collegamento di un account remoto SHALL restare FACOLTATIVO e invariato:
quando il servizio non è configurato, quella parte della sezione SHALL essere
assente, non un errore e non una pubblicità.

#### Scenario: nessun servizio degli account configurato
- **GIVEN** un'installazione senza servizio degli account e senza collegamenti
- **THEN** la sezione SHALL esserci e SHALL mostrare l'identità locale

#### Scenario: due gesti diversi
- **GIVEN** un account remoto collegato
- **THEN** uscire e scollegare SHALL essere due gesti distinti, ognuno con la sua conseguenza dichiarata
