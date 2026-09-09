# Topics: multi-provider e uso senza CLI

## Esito funzionale

Topics permette di collegare OpenAI e Anthropic dalle impostazioni anche su una nuova installazione. La chiave viene verificata leggendo il catalogo dei modelli, salvata sul server e sostituita soltanto dopo una verifica riuscita. Il form non restituisce la chiave salvata. La scelta di provider e modello nella chat viene rispettata; cambiare il modello API predefinito vale dal turno successivo.

| Uso | OpenAI / GPT | Anthropic / Claude |
| --- | --- | --- |
| Chat API senza CLI | Disponibile con chiave OpenAI | Disponibile con chiave Anthropic |
| Agente che modifica file, esegue comandi e test | Codex, con runtime disponibile sul server | Topics nativo con login Claude esistente, oppure Claude Code / jcode |
| Abbonamento personale | Codex può usare il login ChatGPT | Il motore nativo usa credenziali del login Claude esistente |
| Tutti gli agenti nativi, senza CLI da installare | Non ancora: manca un trasporto OpenAI per il ciclo di esecuzione nativo | Il motore esiste, ma l'accesso iniziale dipende ancora dal login Claude esistente |

L'accesso Codex tramite ChatGPT e l'accesso con chiave API hanno fatturazione distinta. La chiave API non consuma automaticamente l'abbonamento ChatGPT. Riferimento: [autenticazione Codex](https://developers.openai.com/codex/auth).

## Esperienza delle impostazioni

La sezione Provider AI presenta prima le connessioni API, con le azioni per collegare, verificare e sostituire la chiave. Gli account e gli agenti già collegati restano visibili nella stessa pagina. Le opzioni avanzate contengono esecuzione locale, MCP e checkpoint e si montano solo quando vengono aperte.

Il catalogo dei task mostra soltanto modelli di agenti in grado di lavorare sui progetti. Un provider API per la chat non viene presentato come agente di coding. Un task GPT usa Codex nella propria cartella di lavoro. Una sessione già assegnata mantiene provider e modello: le impostazioni non migrano in silenzio un lavoro in corso.

## Architettura consigliata per tutti, senza CLI

1. **Un ciclo di esecuzione nativo comune ai provider.** Tenere in Topics strumenti, permessi, annullamento, cronologia, ripresa e conteggio d'uso. Aggiungere il trasporto OpenAI al motore già esistente, con prove di equivalenza sui task reali. Il contratto deve descrivere capacità effettive, non dedurle dal nome del modello.
2. **Accesso guidato nell'app.** Mostrare “Collega OpenAI” e “Collega Anthropic”, verificare l'accesso e offrire solo modelli utilizzabili. Separare chiaramente account in abbonamento e API a consumo. Il terminale e le scelte sul runtime devono restare opzioni per chi ne ha bisogno. Questa consegna non aggiunge un nuovo OAuth ChatGPT di terze parti.
3. **Esecuzione su un host per l'esperienza solo browser.** Il browser multiplayer controlla uno spazio di lavoro sul server. Prima di estenderlo a utenti indipendenti servono credenziali, autorizzazioni, limiti di spesa e contabilizzazione per membro/organizzazione. Le chiavi salvate ora sono dell'installazione: non costituiscono un sistema di fatturazione o isolamento per utente.

La strada consigliata riusa il motore e l'interfaccia di Topics, con un trasporto per provider. Evita un processo esterno per ogni sessione quando il motore nativo supporta quel provider; non promette una riduzione di memoria o latenza non ancora misurata.

## Affidabilità e peso

- Catalogo OpenAI e diagnostica condividono una richiesta in volo e una cache breve. Una risposta vecchia non può sostituire la configurazione nuova, né sul server né nel client.
- Gli stream interrotti o con errori non risultano completati. Le richieste usano `max_completion_tokens`, compatibile con i modelli di ragionamento; [contratto Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
- Il rinnovo OAuth nativo ha un timeout e richiede il possesso del lock. Un processo che non lo acquisisce non cancella il lock di un altro.
- Il file privato delle chiavi è escluso anche da lettura file, anteprima, media e ricerca del progetto, inclusi collegamenti simbolici. Il diniego vale anche quando la cartella di stato è dentro un progetto aperto.
- Il pannello versione/aggiornamenti viene caricato quando si apre il menu padre. Rispetto alla prima build di questa modifica, toglie 6.770 byte dal JavaScript iniziale; il budget esistente rimane invariato. La build verificata misura 1.414.524 byte iniziali, 439.922 gzip; il percorso critico è 2.015.849 byte, 597.045 gzip.

## Prove e limiti della verifica

Le prove usano risposte API simulate, token fittizi e un server E2E isolato. Nessuna generazione a pagamento o modifica dei task reali è necessaria. Verificano il contratto delle richieste e l'esperienza dell'interfaccia; non certificano quote, accessi o disponibilità dei singoli account reali.

Esito finale: 11 prove browser superate in 34,5 secondi; 57 prove sul confine dei file e sulle route adiacenti superate; 28 prove di regressione su chat e risoluzione del provider superate. Gate statici, typecheck e lint verdi. Il budget del bundle è verde senza modifiche alla soglia.

Comandi principali:

```sh
bun run qa:gate --veloce
bun run build:client
bun run check:bundle
bun test server/providers/openai.test.ts server/providers/snapshot-replacement.test.ts
bun test server/services/api-provider-credentials.test.ts server/routes/providers.configure.test.ts
bun test server/utils-secret-path.test.ts server/routes/media.test.ts server/routes/allowlist-write-gate.test.ts server/lib/path-containment.test.ts
bun test shared/task-coding-models.test.ts server/services/task-dispatcher.test.ts
E2E_PORT=13360 E2E_EVIDENCE=1 E2E_VIDEO=1 bunx playwright test tests/e2e/settings-api-providers.spec.ts tests/e2e/version-bundle-drift.spec.ts --workers=1 --retries=0
```

Log locali: `test-results/multiprovider-settings/`. Video e schermate: `test-results/artifacts-13360/`. I test di autenticazione e dispatch aggiuntivi sono elencati nei file di specifica tramite `@covers MP-AUTH-01` e `@covers MP-TASK-01`.
