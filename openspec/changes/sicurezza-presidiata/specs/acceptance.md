# Accettazione: sicurezza presidiata

## Barra eseguibile
```
bun test server/lib/machine-security.test.ts server/lib/machine-health.test.ts   # resta verde
bun test server/routes/machine-health-route.test.ts                               # T1: la rotta dà al client il giro per macchina
bunx playwright test tests/e2e/machine-security-view.spec.ts                      # T1: segno e menu, video in videos/machines/MACHINE-09.webm
bun test server/lib/machine-security-alerts.test.ts                               # T2: transizioni → apri/chiudi card, una per chiave
bun test server/lib/machine-security-ssh.test.ts                                  # T3: server senza Topics, uscite registrate
bun run check:security --only=dependencies                                        # T4: esce 0 su main
bun test server/lib/secret-redaction.test.ts                                      # T5: ogni regola oscura il suo caso e lascia stare i falsi positivi
bun run check:deadcode && bun run check:bloat                                     # niente di nuovo morto o gonfio
```
Mutazioni che devono fare rosso: in T2, togliere la chiave stabile (due giri `problem` → due card); in T5, togliere la regola `sshpass -p` (il caso del 14/09 torna in chiaro).

## Scenario: il segno accanto al nodo (MACHINE-09)
Dato un giro di sicurezza con il Mac `warn` («1 aggiornamento in attesa da 11 giorni») e un nodo cloud `ok`
Quando apro il menu profilo → Dispositivi
Allora accanto al Mac c'è lo scudo giallo e accanto al nodo lo scudo verde
E aprendo la riga del Mac vedo i quattro check con la loro frase e l'ora della misura
E a 375 px la riga non va a capo e lo scudo resta un bersaglio da 44 px

## Scenario: un check diventa rosso (MACHINE-07)
Dato il check `access` del nodo cloud che passa da `ok` a `problem` («porta 5432 aperta verso internet»)
Quando gira il presidio
Allora sulla board nasce UNA card «Nodo cloud 1: porta 5432 aperta verso internet» con la chiave `security:<macchina>:access`
E al giro dopo, ancora `problem`, la card non si duplica
E quando il check torna `ok` la card va in done con la prova del giro

## Scenario: un avviso nuovo su codice fermo (SEC-01)
Dato main senza commit nuovi e un avviso `high` pubblicato oggi su una dipendenza
Quando gira il controllo quotidiano
Allora il controllo esce non zero nominando pacchetto e avviso, e nasce la card come sopra

## Scenario: una password negli argomenti (SEC-02)
Dato un agente che lancia `sshpass -p 'S3gr3t0!' ssh root@host`
Quando il turno viene salvato
Allora nel DB e nel giro dopo verso il modello l'argomento è `sshpass -p '[oscurato]' ssh root@host`

## Prova
Video di MACHINE-09 e MACHINE-07, screenshot a 375, 768, 1440 e 3440 px accanto alla versione prima, uscite dei comandi sopra.
