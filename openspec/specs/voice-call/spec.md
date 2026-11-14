## Purpose

Le telefonate con l'assistente: un canale (oggi jarvis-channels su WhatsApp) porta solo l'audio, Topics fa la
chiamata. Voce Gemini Live, cervello sui provider di Topics, voce veloce per i riconoscimenti e i passi del lavoro,
registrazione ed esito. Nasce dalla change `openspec/changes/chiamate-vocali/` (porta fedele di `src/voice/` di
jarvis-channels, commit 80f1fd26); ogni regola nasce da una chiamata vera andata storta (10-14/11).

## Requirements

### Requirement: CALL-01 — L'audio della chiamata: ricampionamento, rilevatore di voce, velocità, fondo, registrazione

Da 24 a 16 kHz senza fischi, a pezzi di qualunque misura; fotogrammi rifatti da 60 ms qualunque sia la lunghezza
che arriva; silenzio della stanza mai mandato a Gemini; un'eco sotto -30 dBFS non interrompe; velocità senza
cambiare l'altezza; le due voci mescolate in un WAV mono con la lunghezza vera.

#### Scenario: un'eco dell'assistente rimandata dal telefono
- **WHEN** arrivano fotogrammi di voce fra -47 e -35 dBFS mentre l'assistente parla
- **THEN** il rilevatore li conta come voce ma non come interruzione

### Requirement: CALL-02 — La sessione Gemini Live: setup, lettura dei messaggi, ripresa

Il setup chiede audio, trascrizione italiana col vocabolario, contesto limitato e ripresa; la lettura riconosce
audio, `generationComplete`, `turnComplete`, interruzioni, strumenti, consumo, maniglia di ripresa, anche nei frame
binari; la connessione si riaggancia alla stessa sessione e si arrende dopo quattro tentativi senza una sessione pronta.

#### Scenario: la generazione finisce prima del turno
- **WHEN** Gemini manda `generationComplete`
- **THEN** la chiamata lo riceve come fine della generazione, senza aspettare il `turnComplete`

### Requirement: CALL-03 — Il cervello e la voce veloce

La frase va al modello configurato con la trascrizione della telefonata; della risposta vale il primo oggetto JSON;
la voce veloce dice un riconoscimento a tono che nomina solo ciò che la frase chiede, e racconta i passi del lavoro.

#### Scenario: una parola capita male non si ripete
- **WHEN** il telefono ha sentito «avvoli» al posto di «avvisi»
- **THEN** il riconoscimento non la ripete

### Requirement: CALL-04 — Il ciclo della chiamata

Saluto, interruzione verificata, intercalari, cervello, riconoscimento a tono nel momento libero, «ancora un
secondo», passi del lavoro con le tre guardie (lista che cresce, lui che non ha appena parlato, frase già presa),
domanda doppia, risultati in due o tre frasi, chiusura che non chiude in faccia, velocità, gruppo, per conto.

#### Scenario: un passo pronto mentre lui parla
- **WHEN** la frase sui passi del lavoro è pronta e lui riprende a parlare
- **THEN** il passo si butta (`passo_saltato`) e non si dice

### Requirement: CALL-05 — Il ponte fra un canale e Topics

`/ws/voice/bridge` come in `openspec/changes/chiamate-vocali/protocollo.md`: `start`, audio PCM16 a 16 kHz in
fotogrammi da 20 ms nei due versi, `handoff` confermato da `handoff_ok` entro 5 s, `progress`, `reply`, `hangup`,
`outcome` ultimo prima di chiudere, registro come `log`.

#### Scenario: una chiamata intera da un finto canale
- **WHEN** il canale apre, manda audio, conferma il compito e porta il risultato
- **THEN** riceve audio a ritmo reale, il compito, la chiusura e l'esito, in quest'ordine
