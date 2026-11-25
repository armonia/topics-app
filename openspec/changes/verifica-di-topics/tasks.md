# Tracce

Ogni traccia ha la sua barra in `specs/acceptance.md`. Lo stato lo dà il test, non la casella.

Regole per tutte le tracce:
- Codice e commenti in inglese nei file nuovi (`check:comment-language`).
- Nessun nome, host o account nel codice: ciò che varia sta nelle impostazioni (regola zero).
- Ogni migration è provata contro un DB sintetico, come `tests/integration/migration-074-messages-timestamp-index.test.ts`.

## T1 · Giro dei 5 minuti (dipende da: niente)
`server/services/topics-check.ts`.

Funzioni pure:
- `sampleTopics(db, now)` → un campione;
- `voices(samples, settings)` → le tre voci con il numero in ore perse e la causa più probabile scritta in una frase.

Il resto:
- Tabella dei campioni, tenuta 7 giorni.
- Timer da 5 minuti, avviato al boot come gli altri giri.
- Riga «Verifica di Topics» nella vista Automazioni, con il dettaglio delle tre voci.
- Impostazioni: soglie e `checks` (elenco `{name, command, tier}`, default vuoto). Ogni comando gira con un tetto d'orologio, e exit ≠ 0 vale rosso.
- Le cause che la voce 1 deve saper nominare:
  - card in attesa di una persona;
  - posti a 0;
  - nodo appeso;
  - rimbalzi;
  - pavimento di memoria;
  - pin «solo Mac».

## T2 · Cure delle cause note (dipende da: T1)
`server/services/topics-check-cures.ts`.

Una funzione per causa riconosciuta. Ognuna è reversibile e scrive una riga sulla card o sul nodo toccato. Dove il dispatcher ha già la cura, la chiama:
- `reassignFromForbidden` per un nodo senza posti;
- l'interruttore del nodo appeso;
- il pin di sei ore per le card che rimbalzano.

Una causa senza cura nota, o una cura che non toglie il rosso al giro dopo, apre una card d'indagine:
- nella board scelta nelle impostazioni;
- una per chiave di problema;
- con un tetto al giorno, default 3;
- spenta finché la board non è scelta.

## T3 · Giro giornaliero (dipende da: T1)
Una volta al giorno, all'ora scelta nelle impostazioni:
- le tre voci sulle 24 ore;
- una sola chiamata al modello scelto (default il più economico disponibile), con: le firme d'errore del log del giorno mai viste nei 7 giorni prima, le automazioni senza prova con il loro ultimo esito, le card ferme con il motivo che il giro dei 5 minuti ha scritto.

Esce un verdetto in una riga sulla riga della Verifica. Un rosso apre una card come in T2.

## T4 · Meno sentinelle (dipende da: T1, T2 e T3 attive da 3 giorni)
Fuori da questo repo: le sentinelle esterne che rifanno gli stessi conti vengono tolte, oppure leggono la voce della Verifica.

Il censimento del 22/11 ne ha trovate di questo tipo:
- card ferme contate da due giri diversi con soglie diverse (3 h e 12 h);
- un giro di verifica che gira a vuoto ogni 5 minuti da una versione ormai vecchia;
- due controlli di salute del Mac che fanno lo stesso lavoro, uno mensile e uno settimanale.

Il diff netto sulle sentinelle deve essere negativo.
