# Acceptance: mostrato-nel-messaggio

Ogni barra è un comando che esce non-zero se la regola non vale. Gli scenari e2e girano sul server di prova (:13334), mai su quello vivo; il video si ottiene con `E2E_VIDEO=1`.

## M1 Il segno dell'apertura porta ciò che è stato mostrato (R1, R2, R4, R5)
`bun test` dei file toccati (flusso di apertura e riferimenti ai file sul server, parser del segno in `shared/tool-detail`, `client/src/lib/shell/tauriBrowserOps.test.ts`, resa del segno nel client) esce 0 e copre:
- Efficace: un turno finto apre un'immagine in una sottocartella di media e poi fa una domanda → a domanda ancora aperta il messaggio ha già l'immagine nel segno.
- Completo: pagina web → foto scattata all'apertura, citata dal risultato dello strumento e resa nel segno; pagina che non carica → nessuna foto vuota e il risultato lo dice; PDF → file apribile; file fuori dalle cartelle servite → errore che dice di copiarlo sotto `~/.topics/media`.
- Corretto: percorso con spazi; l'agente scrive anche `MEDIA:` per lo stesso file → mostrato una volta; URL assoluto verso un'origine di questo server con `/api/media` → come il relativo; loopback con un'altra porta → non toccato; pannello nativo, A e poi B sulla stessa origine → la risposta dice B e l'annuncio porta B; reindirizzamento → resta l'URL raggiunto.
- Chi non scrive dove la persona legge: topic di sottoagente, topic di card, sessione di terminale → il risultato nomina la strada che funziona, anche quando `visible` è vero.
- Efficiente: una foto per apertura, non una per client collegato (contatore).

Scenario `tests/e2e/shown-in-message.spec.ts`, sul progetto desktop e su quello telefono (con tocco): l'immagine è nel messaggio col pannello chiuso e una domanda aperta; dopo `restartTestServer` è ancora lì; un tocco la apre nel visore che c'è già. La stessa immagine si carica anche dalla porta «da fuori»; se non è provabile nel server di prova, la traccia lo dice con il motivo.

Mutazioni: segno senza media → il test «apre e poi chiede» è rosso; pagina di prima accettata come caricata → il test «A e poi B» è rosso.

Testo: il golden della superficie degli strumenti e il testo fissato in `server/context/regression.test.ts` si rigenerano di proposito; un test fissa le frasi nuove (percorso per i file locali, anteprima nel messaggio, niente «Do not mention the tool to the user»).

## M2 La domanda porta l'immagine (R3)
`bun test` dei file toccati esce 0 e copre: schema dello strumento; `sanitiseQuestion` tiene `image` e `recommended`; i tre motori (nativo, CLI di Claude, Codex) la passano; i tipi condivisi; domanda con immagini salvata e riletta dopo un riavvio; immagine che non esiste → rifiutata con un errore che la nomina; domanda di una sessione di card → il commento nel thread porta le immagini come allegati.

Notifica: prima la causa della notifica mancata del 19/11 alle 22:44Z, scritta con la prova. Poi un test: una domanda NUOVA dopo un riavvio notifica; la STESSA domanda ripresentata dal bridge no. I test di ATTN-07 restano verdi.

Scenario `tests/e2e/question-with-images.spec.ts`, su desktop, tablet e telefono: quattro opzioni con immagine, si sceglie toccando l'immagine, all'agente arriva il testo dell'opzione; stati: immagine in caricamento, immagine mancante; le immagini si aprono nel visore che c'è già.

Mutazione: `sanitiseQuestion` che butta `image` → rosso.

Accessibilità (axe) sulla scheda: testo alternativo per ogni immagine, ogni opzione si sceglie da tastiera.

A vista: foto della scheda a 375 e 1440 px accanto a quella di oggi.

## Tutte
`openspec validate mostrato-nel-messaggio` esce 0. Serve un delta: `specs/<capability>/spec.md` con `## ADDED Requirements` e `#### Scenario:` ricavati dalle regole (questo file resta la barra).
I test che cambiano di proposito sono nominati qui sopra; tutti gli altri restano verdi.
