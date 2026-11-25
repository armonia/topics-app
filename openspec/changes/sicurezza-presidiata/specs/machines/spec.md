# Delta: machines — la sicurezza di ogni macchina si vede accanto a lei e chiama qualcuno quando diventa rossa

## ADDED Requirements

### Requirement: MACHINE-09 — Ogni nodo mostra il suo stato di sicurezza accanto al nome e i check nel suo menu

Il client SHALL ricevere dal server l'ultimo giro di MACHINE-05 per macchina. Ogni riga di
macchina nel menu Dispositivi e in Impostazioni → Macchine SHALL avere accanto al nome il segno
del suo stato (il peggiore dei check, `info` escluso) e l'età della misura se più vecchia di
un'ora; il menu della riga SHALL elencare i quattro check con la loro frase. Una macchina senza
misura SHALL mostrare lo stato `unknown`, mai un segno verde.

MISURA: `bunx playwright test tests/e2e/machine-security-view.spec.ts` verde, video `videos/machines/MACHINE-09.webm`.

#### Scenario: un nodo con un aggiornamento in attesa
- **GIVEN** un giro con il Mac `warn` e un nodo cloud `ok`
- **WHEN** apro Dispositivi
- **THEN** accanto al Mac SHALL esserci il segno `warn` e accanto al nodo il segno `ok`
- **AND** il menu del Mac SHALL mostrare il check `updates` con la sua frase

#### Scenario: una macchina mai misurata
- **GIVEN** il PC senza nessun giro
- **THEN** il suo segno SHALL essere `unknown`

### Requirement: MACHINE-07 — Un check rosso apre una card sola, e la chiude quando torna verde

Un check che passa a `problem`, o resta `warn` per più di 24 ore, SHALL aprire UNA card con chiave
`security:<macchina>:<check>` sulla board scelta nelle impostazioni; un giro successivo con lo
stesso stato NON SHALL aprirne un'altra; il ritorno a `ok` SHALL portare la card in done con
l'esito del giro. Lo stato `unknown` NON SHALL aprire card. Senza board scelta nessuna card nasce.

MISURA: `bun test server/lib/machine-security-alerts.test.ts` verde; togliere la chiave stabile lo fa rosso.

#### Scenario: due giri rossi
- **GIVEN** il check `access` di un nodo `problem` per due giri di fila
- **THEN** SHALL esistere una sola card con la chiave del check

#### Scenario: torna verde
- **GIVEN** la card aperta e il check di nuovo `ok`
- **THEN** la card SHALL andare in done

### Requirement: MACHINE-08 — Un server senza Topics si misura via SSH in sola lettura

Un server elencato nelle impostazioni (host, porta, utente) SHALL essere misurato con le stesse
sonde di MACHINE-05 eseguite via SSH non interattivo, senza installare nulla e senza modificare
nulla sul server. Un server che non risponde SHALL tenere l'ultimo esito con la sua ora.

MISURA: `bun test server/lib/machine-security-ssh.test.ts` verde.

#### Scenario: chiave non accettata
- **GIVEN** un server che rifiuta la chiave
- **THEN** i check SHALL essere `unknown` con la frase del perché
