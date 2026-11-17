# Acceptance: limiti-consumo-progetto

## USAGE-28 Il conto per progetto
`bun test server/usage/project-quota.test.ts` esce 0: i due scenari della spec, più una worktree, un sottoagente senza cartella (conta per il genitore) e un transcript di Claude Code fuori da ogni progetto («fuori dai progetti»).
Prova sui dati veri: `bun scripts/project-quota-check.ts --since 2026-11-17T14:54 --until 2026-11-18T00:00` su una copia del DB stampa jarvis 20, pixel-console 15, zenocms 14,5, quadra 14, topics-app 12, cloud-sim 4,4 (±1).
Mutazione: tolta la divisione oraria (tutti i punti divisi sul peso totale della finestra) il test dei due progetti è rosso.

## USAGE-29 L'avviso
`bun test server/services/project-quota-alerts.test.ts` esce 0: una volta al giorno per soglia, comando per argv con testo su stdin, comando vuoto = nessun processo, comando che fallisce = riga col motivo e tre tentativi.
Prova vera: con `TOPICS_OWNER_ALERT_COMMAND` puntato a `jarvis-channels send-to whatsapp <chat principale>` e una soglia di prova a 0,1 su un progetto, arriva un messaggio WhatsApp (letto dalla chat in `jarvis-channels`), poi la soglia torna al default.
Mutazione: togliendo il controllo «già avvisato oggi» il secondo giro manda un secondo messaggio e il test è rosso.

## USAGE-30 Il freno
`bun test server/services/project-budget-brake.test.ts` esce 0: card ferma col motivo, `spawn_agent` rifiutato, messaggio della persona che parte, freno tolto fino a mezzanotte, errore di lettura che lascia passare.
Scenario e2e (video on): `pw-remote -- npx playwright test tests/e2e/project-budget.spec.ts`. Apro il menu di un progetto, scelgo budget 5% con il progetto già a 6: la riga mostra il punto ambra e la pausa, la card in Todo dice «Aspetta il budget del progetto», scelgo «Togli il freno» e la card parte.
Mutazione: con il controllo del freno tolto dal dispatcher lo scenario è rosso.

## Ciò che è verde resta verde
I test di `server/usage/person-usage.test.ts`, `server/services/task-dispatcher-spend-cap.test.ts` e quelli del menu progetto (HUBBR-16) restano verdi dalla CI della PR.
