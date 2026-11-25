# Il sistema degli agenti in due repo

## Deciso da me
22/11: il piano completo, approvato come pacchetto. Il suo dettaglio d'istanza (cartelle, servizi, stato della macchina) sta nel repo dei dati dell'installazione, cifrato, e non qui. Per `topics-app` vale questo: i moduli entrano senza storia, uno alla volta, ognuno solo con il cancello verde.

## Perché
Un'installazione di Topics con i suoi agenti oggi vive in molti repo. Il codice di servizi che ogni installazione userebbe (canali di messaggistica, proxy delle chiamate al modello, gateway MCP, server MCP, script di operazioni, harness) sta fuori da `topics-app`, mescolato con i dati di un'istanza. La forma giusta è di due repo: `topics-app` per il codice, pubblico e generico; un repo dei dati privato e cifrato per ogni installazione.

`topics-app` stesso ha un debito con la regola zero: file non di test che citano il percorso della cartella d'istanza o id di agenti scritti nel codice.

## Cosa cambia in `topics-app`
- **Cartelle nuove:** `services/channels`, `services/hub`, `services/mcp-gateway`, `services/mcp`, `scripts/ops`, `harness/`. Ciò che varia fra installazioni sta nelle impostazioni o nel repo dei dati, con un default vuoto che funziona. Dove c'è di mezzo la privacy il default è chiuso: niente esce verso provider esterni finché non è configurato.
- **Un cancello** `check:instance-strings`, a cricchetto per percorso, che gira sia in CI sia nel pre-push.
- **Un job di CI per modulo**, e il flusso di rilascio di Topics non ricompila `services/`.

## Barra
`acceptance.md`.

## Fuori
- **Lo stato e l'inventario di una singola installazione:** stanno nel suo repo dei dati, mai qui.
- **Le tracce fuori da questo repo** (rendere generici i moduli, installare le copie, scambiare i servizi vivi, ritirare i repo vecchi): si seguono nel repo dei dati e sulla board dell'installazione.
- **Le change da cui dipende, che non si rifanno:** `agents-in-topics-home`, `lavori-programmati-in-topics`, `agenti-e-sistema`, `hub-tutto-in-topics`, `chiamate-vocali` (la voce), `nodo-principale-a-mano`, `limiti-consumo-progetto`.

## Deciso dall'agente
- **Import senza storia.** La storia dei moduli resta cifrata nel repo dei dati. Riscrivere la storia pubblica non serve, perché non ci entra.
- **Il cancello legge dalle impostazioni** gli id degli agenti e i pattern d'istanza: un test pubblico non li scrive.
- **I documenti pubblici descrivono la forma, non una macchina:** niente numeri, nomi di servizi, orari o percorsi di un'installazione.

## Non ancora specificato
- Il perimetro del cancello su `openspec/`: alcune change esistenti citano percorsi d'istanza. O ha una soglia sua o resta fuori.
- I nomi del crate e del binario dei canali e delle etichette dei servizi.
- Come un secondo utente installa i servizi, e quanto dura a freddo la build CI dei canali.
