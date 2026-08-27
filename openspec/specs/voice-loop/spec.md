## Purpose

La board che PARLA: annuncia a voce un task arrivato in review e accetta una
risposta parlata. Non è la dettatura (`openspec/specs/dictation/`, che porta la
voce dentro un campo di testo): qui la voce è il canale in entrambe le
direzioni, e chi ascolta ha le mani occupate.

## Background

TRE PEZZI, E OGNUNO SBAGLIA IN MODO SUO. Un annuncio che si sovrappone al
precedente non è "due annunci", è rumore da cui non si estrae nessuno dei due.
Una parola d'attivazione che matcha su un pezzo di parola apre il microfono
della board su una conversazione che non la riguardava. E un classificatore
remoto che casca deve lasciare la board che risponde lo stesso: il giro vocale
non è un servizio che deve stare su, è un suggerimento con le parole chiave
sempre dietro.

Il default è SPENTO (`settings.voiceMode === 'off'`), e finché è spento non
deve costare niente: i moduli si caricano al primo giro vero, non nel bundle
di partenza.

### Requirement: VOICE-01 — La coda degli annunci parla UNO alla volta, e lo stesso task non si annuncia due volte

Due `task:review-ready` a un secondo di distanza non devono produrre due turni
parlati sovrapposti. La coda sostituisce un annuncio con lo stesso `taskId`
invece di accodarlo, serve in ordine di arrivo, e sopra una soglia raggruppa in
un solo annuncio riassuntivo — che nomina cosa aspetta e NON apre un turno di
microfono, perché non c'è un task solo a cui rispondere.

#### Scenario: lo stesso task annunciato due volte
- **WHEN** un `taskId` già in coda torna
- **THEN** l'annuncio viene sostituito, non duplicato

#### Scenario: sopra la soglia
- **WHEN** la coda supera la soglia di raggruppamento
- **THEN** esce un annuncio riassuntivo, e nessun turno di microfono lo segue

### Requirement: VOICE-02 — La parola d'attivazione si riconosce sulla PAROLA, e ciò che conta è il seguito

In modalità `wake-word` la board agisce solo su ciò che viene DOPO la frase di
attivazione. Assente la frase, il turno non era per la board e si scarta
(`null`, non stringa vuota: sono due esiti diversi). Maiuscole e accenti non
contano. Una frase d'attivazione vuota non matcha mai — altrimenti ogni turno
sarebbe per la board.

#### Scenario: frase assente
- **WHEN** la trascrizione non contiene la frase di attivazione
- **THEN** l'estrazione torna `null` e il turno si scarta

#### Scenario: frase presente da sola
- **WHEN** la trascrizione è solo la frase di attivazione
- **THEN** il seguito è vuoto, che è un esito diverso da `null`

### Requirement: VOICE-03 — L'intento si classifica con un ripiego che regge da solo

La risposta parlata diventa `approve`, `feedback` o `close`. Il percorso remoto
(Groq) è un miglioramento, non una dipendenza: senza chiave, con una risposta
malformata o col servizio giù, si ripiega sulle parole chiave e il giro
funziona lo stesso. Ogni esito DICHIARA da dove viene (`source`), perché
«ha deciso il modello» e «ha deciso una parola chiave» non si leggono uguale in
un registro. Un congedo resta `close` anche quando contiene un assenso, e
qualunque altra cosa è `feedback` col testo intero — mai un testo tagliato.

#### Scenario: senza chiave
- **WHEN** manca `GROQ_API_KEY`
- **THEN** classifica per parole chiave e `source` è `keyword`

#### Scenario: il servizio remoto cade
- **WHEN** la chiamata a Groq fallisce o risponde malformata
- **THEN** l'esito è quello delle parole chiave, non un errore
