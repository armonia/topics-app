# Verifica di solidità del progetto

8 settembre 2026. Base: `32b1cbb49`, versione 2.2.294. Intervento su
`codex/senior-pass-20260908`, in checkout isolato. Nessun rilascio o modifica al
database operativo. Le evidenze locali sono in `test-results/senior-pass/`.

Il seguito sulla conversazione dei task, sui costi degli aggiornamenti multiplayer
e sulla velocità dei controlli è documentato in
[PERFORMANCE-REVIEW.md](PERFORMANCE-REVIEW.md), con misure e verifiche dedicate.

## Fatto

| Correzione | Prova |
|---|---|
| La CLI di build rifiuta argomenti incompleti e destinazioni sovrapposte al checkout, anche tramite symlink. Evita che `--out` senza valore cancelli i sorgenti. | Fixture sacrificabili: 13 fallimenti prima; 15 casi verdi dopo, più 6 test di pubblicazione. `build-cli-red.log`, `build-cli-green.log`. |
| Creazione, rinomina e upload risolvono gli antenati reali anche quando la destinazione non esiste. I collegamenti esterni o pendenti vengono respinti; quelli interni funzionano. | `server-boundaries-red.log` e `server-boundaries-green.log`: riproduzioni prima/dopo, nessuna scrittura esterna nelle fixture. |
| Revoca e riduzione dei permessi chiudono anche le connessioni terminale e browser del dispositivo. Tutti i trasporti conservano l'identità del cancello HTTP; il broadcast della chat conserva il proprio insieme. | 9 casi sui confini di sicurezza e 138 test mirati verdi: `server-focused-tests.log`. |
| Una migration fallita resta non registrata; l'inizializzazione fallita chiude il DB e non pubblica il singleton. | 3 regressioni riprodotte; 10 casi verdi con registri legacy. Retry nello stesso processo verificato indipendentemente: `migration-independent-review.log`. |
| Un errore durante la lettura del corpo HTTP libera la richiesta condivisa, consentendo un nuovo tentativo. | Test con stream interrotto e risposta successiva sana, con cache attiva e disattiva: `frontend-unit-red.log`, `frontend-unit-green.log`. |
| Le statistiche non vengono interrogate automaticamente a scheda nascosta; tornano aggiornate alla riapertura. Il refresh esplicito resta disponibile. | Test del vero hook: richieste automatiche durante montaggio/tick nascosti da presenti a zero; verifica ripresa e pulizia dei listener. |
| Escape restituisce il focus alla scheda profilo dopo la chiusura del menu. | Asserzione Playwright fallita prima, verde dopo: `frontend-focus-red.log`, `frontend-menu-green.log`. |
| Dipendenze aggiornate e risoluzione CodeMirror unificata, senza alzare budget o allentare lint. Baseline sicurezza vuota e test del cancello valido anche da zero avvisi. | Audit dipendenze: 41 voci prima, 0 dopo su root/client/landing. Fixture vulnerabile riconosciuta e respinta: `security-empty-baseline-green.log`. |
| Il comando di audit con `--json` produce un documento JSON valido su stdout anche quando tutti i controlli passano. Output testuale ed exit code 0/1/2 restano invariati. | Parsing fallito prima; 10 test verdi dopo, compresi successo, violazione e misura non disponibile: `security-json-red.log`, `security-json-green.log`. |
| README e CONTRIBUTING installano anche le dipendenze del client e costruiscono dalla root prima dell'avvio. | Installazioni con lockfile congelato e build completate; eliminato il comando `start` lanciato dalla cartella sbagliata. |

L'aggiornamento SDK include la correzione documentata in
[GHSA-p7fg-763f-g4gf](https://github.com/advisories/GHSA-p7fg-763f-g4gf).
Il conteggio degli avvisi riguarda il database delle vulnerabilità interrogato in
questa verifica; non equivale a dimostrare l'assenza di ogni vulnerabilità.

**Validazione complessiva.** Baseline: suite da 15.018 test conclusa con exit 0. Controlli statici,
TypeScript e lint finali: barra verde (`final-static-qa.log`). Suite finale unità
e integrazione: exit 0, 15.051 test su 1.258 file, 538 secondi. Browser: 217 test verdi, 1 saltato
per gateway AI non disponibile, su 32 file selezionati dal diff e dai flussi
principali (`final-e2e.log`). Build client, server e CLI riuscite. Bundle finale:
8.101.314 byte contro 8.089.677 iniziali; entro il budget invariato. Verificato
anche il contenuto precompresso e l'assenza dell'overlay di sviluppo.
L'ultimo fix del JSON è stato poi verificato con tutti i 25 test dello strumento
di sicurezza, compresi quelli che interrogano il registro delle dipendenze:
25 pass, 0 fail (`final-security-tests.log`).

Il riepilogo `final-qa.log` conserva un rosso del controllo sui nomi perché il
debito era diminuito: la baseline è stata abbassata e il controllo rieseguito
con esito verde in `final-static-qa.log`. Anche le tolleranze su `any` e commenti
sono state ridotte. La verifica da tastiera dispone di
[video](test-results/artifacts-13335/profile-menu-il-menu-utent-475d1-chiude-un-livello-per-volta-chromium/video.webm)
e trace della build finale (`menu-evidence.log`: 1 test superato).

## Copertura degli undici assi

| Asse | Esito concreto |
|---|---|
| Architettura | Identità WebSocket condivisa con il cancello HTTP; registro di revoca separato dal broadcast. |
| Ingresso nel progetto | Sistemati i comandi di installazione e build documentati. |
| Correttezza | Ripristino delle richieste condivise dopo errore del body e del focus dopo Escape. |
| Performance | Zero polling automatico a pagina nascosta; misurato il bundle prima e dopo. |
| Modularità | Risoluzione dei percorsi riusata da server e CLI; upgrade dei tre trasporti raccolto in un helper. |
| Dati | Migrazioni fallite non marcate come riuscite; mantenuta la compatibilità dei registri legacy. |
| Affidabilità | Retry dell'inizializzazione DB verificato; pubblicazione del client mediante staging preservata. |
| Frontend | Test browser di menu, sidebar, touch, board, chat, file, terminale e impostazioni; geometria verificata dal DOM. |
| Sicurezza | Corretti confini filesystem e revoca socket; audit dipendenze senza avvisi. |
| Build e CI | Guard rail, tipi, lint, test, budget bundle e build eseguiti; fixture negativa per il cancello sicurezza. |
| Decisioni tecniche | Mantenuti stack e comportamento esistenti; privilegiati interventi circoscritti con regressioni riproducibili. |

## Trovato e non fatto

- Registrazioni di migration eventualmente già errate per il vecchio bug non
  vengono risanate automaticamente: non esiste una correzione universale che
  preservi i dati. La procedura di backup e recupero specifico è documentata in
  `docs/backup-pre-migration-policy.md`; non è stata applicata al DB vivo.
- La suite browser completa, i pacchetti nativi su Windows/Linux, la firma degli
  installer e i provider esterni reali non sono stati certificati da questo
  intervento. Il caso saltato richiede il gateway per lo streaming AI reale.
- I controlli dei percorsi non costituiscono una sandbox contro un altro processo
  locale che sostituisca un symlink tra controllo e scrittura. La revoca dei tre
  trasporti è verificata con upgrade reali come funzione e socket di test;
  il terminale passa anche i flussi browser, senza prova con un dispositivo remoto.

## Rifiutato

L'aggiornamento indiscriminato di tutta la toolchain introduceva nuove regole
lint e duplicava CodeMirror, portando il bundle a 10.583.969 byte. È stato
sostituito da una risoluzione compatibile e deduplicata. Non sono state aggiunte
eccezioni ai controlli. Una riscrittura del grande `server.ts` senza un difetto
specifico avrebbe ampliato il rischio senza una prova di beneficio. Le proposte
di prodotto ancora aperte non sono state trasformate in funzionalità arbitrarie.

## Assi saltati

Nessuno. I limiti delle verifiche di piattaforma e servizi esterni sono indicati sopra.

## Prossimi passi

1. **(consigliato)** Integrare il branch verificato nel normale flusso di rilascio,
   con backup del database prima dell'aggiornamento operativo.
2. Usare CI e gateway disponibili per completare la matrice nativa e il caso di
   streaming reale prima di una release multipiattaforma.
