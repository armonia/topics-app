# Rilettura dei 14 requisiti promossi dalle change archiviate

27/08/2026. I quattordici requisiti che il 25/08 sono stati portati dentro
`openspec/specs/` per riparare il denominatore di `check:spec-coverage` sono
stati riletti uno per uno contro il codice di oggi. Il cancello conta i
COLLEGAMENTI fra requisito e test: non legge la prosa, e un requisito promosso
alla cieca ha un pallino verde sopra.

Metodo, per ciascuno: testo SHALL e scenari, poi il test che lo dichiara
(`@covers` o annotazione per-test), poi il codice di produzione che quel test
esercita. Una sola domanda: **questo testo descrive quello che il codice fa
oggi?** I test unitari e di integrazione che coprono questi id sono stati
eseguiti (115 pass, 0 fail); gli e2e sono stati letti, non eseguiti.

Esito: **11 DESCRIVE ANCORA, 3 DESCRIVE MALE, 0 NON DESCRIVE PIÙ.** Nessuna
promessa persa dal codice, quindi nessun difetto aperto. Le tre riscritture sono
nel testo dei requisiti, in questo stesso commit.

## I quattordici verdetti

| Id | Verdetto | Perché |
|---|---|---|
| CCPROV-01 | DESCRIVE ANCORA | Il provider dichiara ancora `streaming`, `tools`, `sessions`, `abort`; `GET /api/providers` risponde con l'array e ogni voce porta `name`, `connected`, `capabilities` (più `isDefault`, che non contraddice niente). |
| CCPROV-02 | **DESCRIVE MALE** | Due frasi sbagliate, riscritte. Vedi sotto. |
| CCPROV-05 | DESCRIVE ANCORA | Il PATCH scrive la colonna `provider` e `GET /api/topics` la rilegge; il workspace risolve worktree `ready` ed esistente, poi il project path, poi niente (7 test unitari verdi). La funzione vive in `server/providers/claude-code.ts`, non in un file omonimo al suo test. |
| CHAT-RND-01 | **DESCRIVE MALE** | Mancavano due casi di degradazione a testo semplice. Vedi sotto. |
| CHAT-CONV-01 | DESCRIVE ANCORA | `POST /api/messages/:id/regenerate` forka il fratello sotto l'anchor, tronca lì il prompt, rifiuta il non-assistant con 400 e lo stream vivo con 409; l'azione è nascosta su un messaggio parziale. In più oggi il prompt porta le misure del turno sostituito: è `CHAT-CONV-04`, si aggiunge, non contraddice. |
| CHAT-CONV-02 | DESCRIVE ANCORA | `DELETE /api/messages/:id` fa sottoalbero, rinumerazione densa e riaggancio del puntatore attivo in una transazione sola e restituisce il thread attivo; il bottone si arma prima di cancellare. |
| CHAT-CONV-03 | **DESCRIVE MALE** (per difetto) | Il testo prometteva meno di quello che il codice fa. Vedi sotto. |
| REAL-TC-01 | DESCRIVE ANCORA | `tool-call-row-<id>`, `tool-call-name`, `tool-call-args`, `tool-call-result`, `tool-call-error`, `data-status="error"`: ci sono tutti, e le righe sono ordinate per offset. `Read` è uno dei tool la cui etichetta coincide col nome, quindi lo scenario resta letterale. |
| REAL-TC-02 | DESCRIVE ANCORA | `media-image` con il suo `src`, `media-file` e `media-file-name` sono ancora gli id che spedisce il client. |
| REAL-TC-03 | DESCRIVE ANCORA | La verifica aspetta 30 secondi un `tool-call-row-` con nome non vuoto e salta con l'annotazione "Gateway unavailable" invece di fallire. |
| TOPIC-WT-01 | DESCRIVE ANCORA | Migrazione 018: colonna NULLABLE con `ON DELETE SET NULL`; la rotta di cancellazione ripulisce anche gli snapshot `ui_state`, così un worktree cancellato non torna da una sincronizzazione. 11 test di integrazione verdi. |
| RES-ATTR-06 | DESCRIVE ANCORA | Le fonti sono registrate a parte e montate da `App.tsx`, i byte si dichiarano stima. Nota aggiunta al requisito: la prima frase si sovrappone a RES-ATTR-09. |
| RES-ATTR-07 | DESCRIVE ANCORA | Soglia di un megabyte, sessioni aggregate con il nome della più pesante nel dettaglio, una riga per radice del server, nome grezzo per un tipo sconosciuto: tutto in `client/src/lib/featureUsage.ts`. |
| RES-ATTR-08 | DESCRIVE ANCORA | `attribuisciMedia` è agganciata allo sweep di `routes/chat.ts`, la soglia del nome corto è otto caratteri, gli argomenti non serializzabili cadono da soli. Ma il NUMERO era ambiguo: vedi «Il numero riusato». |

## Le tre riscritture

**CCPROV-02 — la card non porta il nome del tool, e non sta all'offset.**
La card mostra un'etichetta normalizzata: una chiamata `Bash` si legge `Shell`,
un tool MCP si legge `server · tool`. E la collocazione si sposta al confine di
paragrafo più vicino; l'offset esatto vale solo quando nel testo non c'è nessuna
riga vuota, che è il caso dei test. Il requisito ora dice l'una e l'altra cosa.

Sotto c'era una copertura che non poteva accorgersene: il test e2e del caso
`Bash` creava un topic chiamato «CC Bash E2E …» e poi asseriva che il `body`
della pagina contenesse «Bash» — soddisfatto dal nome del topic nella sidebar,
con o senza card. Ora l'asserzione è sulla card (`tool-call-name` uguale a
`Shell`). È il tipo di verde che questo lavoro cercava.

**CHAT-RND-01 — due modi di restare in bianco che nessuno aveva scritto.**
La vista con i numeri di riga rende riga per riga e resta senza colori per
costruzione; e mentre un blocco è in streaming il tokenizzatore riceve una copia
differita, così il blocco resta semplice finché la copia non raggiunge il testo a
schermo. Il requisito elenca ora tutti i casi di degradazione, i tre già noti e
questi due.

**CHAT-CONV-03 — il testo prometteva meno del codice.**
La promozione aveva ristretto l'export «al contenuto dei messaggi», perché è
tutto ciò che il test rilegge. Il file esportato porta il nome del topic come
titolo e, per ogni messaggio, un'intestazione con l'autore e l'orario. Un
requisito che promette meno di quello che il codice fa lascia libero il resto di
sparire senza che nessuno se ne accorga: la frase è stata riportata al vero.

## Il numero riusato

`RES-ATTR-08` significava due cose. Nel documento di riferimento è
l'attribuzione degli allegati per NOME (quella che il 7 agosto ha evitato che due
immagini di un'altra sessione finissero in un turno che non le aveva mai viste).
Nella change `feature-weight-inventory`, mai archiviata, lo stesso numero
nominava il recap all'hover — e due commenti nel codice
(`SidebarStatusBar.tsx`, `tests/e2e/feature-weight.spec.ts`) lo citavano ancora
con quel significato. Non sono `@covers`, quindi il cancello non li vede: è
esattamente la malattia «un id, due significati» che la passata del 25/08 aveva
contato. I due commenti ora puntano a `RES-ATTR-04`, dove quella regola vive
davvero.

## Cosa NON è stato fatto

I requisiti restati fuori dalla promozione (le scene di ciclo di vita del
processo di CCPROV, i picker del dialogo Nuovo Topic per TOPIC-WT, la
degradazione sicura di CHAT-RND) non sono stati riletti: non sono in
`openspec/specs/`, e nessun test li dichiara. Restano dove sono, nelle change
archiviate.
