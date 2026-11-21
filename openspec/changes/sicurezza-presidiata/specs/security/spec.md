# Delta: security — avvisi nuovi visti da soli, segreti mai salvati in chiaro

## ADDED Requirements

### Requirement: SEC-01 — L'audit delle dipendenze gira ogni giorno anche senza push

Un giro quotidiano SHALL rilanciare l'audit delle dipendenze sui lockfile di main contro la
baseline accettata; un avviso nuovo SHALL far uscire il giro non zero nominando pacchetto e
avviso, e SHALL aprire la card come MACHINE-07. Sui server Linux, `reboot-required` presente da
più di 24 ore SHALL dare `warn` nel check `updates`.

MISURA: `bun run check:security --only=dependencies` esce 0 su main; test del parser `reboot-required`.

#### Scenario: avviso nuovo su codice fermo
- **GIVEN** nessun commit nuovo e un avviso `high` pubblicato oggi
- **THEN** il giro quotidiano SHALL uscire non zero e nominarlo

### Requirement: SEC-02 — I segreti negli argomenti e nell'output dei tool si oscurano prima di salvarli

Argomenti e output di ogni tool SHALL passare da un elenco chiuso di regole di oscuratura
prima di essere salvati e prima di essere rimandati al modello: password in `sshpass -p` e nelle
opzioni `--password`/`-p` dei client noti, intestazioni `Authorization`, chiavi private PEM,
token con prefisso noto. Il valore SHALL diventare `[oscurato]`; il resto del comando SHALL
restare uguale.

MISURA: `bun test server/lib/secret-redaction.test.ts` verde; togliere la regola `sshpass -p` lo fa rosso.

#### Scenario: password nel comando
- **GIVEN** `sshpass -p 'S3gr3t0!' ssh root@host`
- **THEN** SHALL essere salvato `sshpass -p '[oscurato]' ssh root@host`

#### Scenario: falso positivo
- **GIVEN** `git log -p` o `grep -p`
- **THEN** il comando SHALL restare uguale
