# Acceptance: limiti-consumo-progetto

## USAGE-28 Il conto per progetto
`bun test server/usage/project-quota.test.ts` esce 0: i due scenari della spec, più una worktree, un sottoagente senza cartella (conta per il genitore) e un transcript di Claude Code fuori da ogni progetto («fuori dai progetti»).
Prova sui dati veri: `bun scripts/project-quota-check.ts --since 2026-11-17T14:54 --until 2026-11-18T00:00` su una copia del DB stampa jarvis 20, pixel-console 15, zenocms 14,5, quadra 14, topics-app 12, cloud-sim 4,4 (±1).
Mutazione: tolta la divisione oraria (tutti i punti divisi sul peso totale della finestra) il test dei due progetti è rosso.

## USAGE-29 Il limite di default
`bun test server/services/project-pause.test.ts` esce 0: progetto senza impostazioni in pausa sopra 10 punti, card ferma col motivo, `spawn_agent` rifiutato, messaggio della persona che parte, errore di lettura che lascia passare, «Nessuno» che toglie il limite.
Mutazione: con il controllo della pausa tolto dal dispatcher il test della card è rosso.

## USAGE-30 La conferma sincronizzata
`bun test server/services/project-pause-alerts.test.ts` esce 0: un avviso fuori dall'app per pausa (comando per argv, testo su stdin, comando vuoto = nessun processo), «Continua» che sblocca per altri 10 punti, «Pausa fino a domani» che regge fino a mezzanotte.
Scenario e2e (video on): `pw-remote -- npx playwright test tests/e2e/project-pause.spec.ts`. Due finestre sulla stessa chat del progetto e la sua board, progetto portato sopra il limite: la striscia compare in tutte e due e la card dice «In pausa: limite del progetto»; «Continua» nella prima finestra fa sparire la striscia nella seconda senza ricaricare e la card parte.
Prova vera: con `TOPICS_OWNER_ALERT_COMMAND` puntato a `jarvis-channels send-to whatsapp <chat principale>` e il limite di un progetto di prova a 0,1, arriva un messaggio WhatsApp col link; poi il limite torna al default.
Mutazione: se «Continua» sblocca solo la sessione da cui parte, lo scenario e2e è rosso.

## Ciò che è verde resta verde
I test di `server/usage/person-usage.test.ts`, `server/services/task-dispatcher-spend-cap.test.ts` e quelli del menu progetto (HUBBR-16) restano verdi dalla CI della PR.
