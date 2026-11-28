# Acceptance: limiti-consumo-progetto

## USAGE-28 Il conto per progetto (consegna 1)
`bun test server/usage` esce 0, con un test per ognuno: transcript annidati letti; peso per modello (Haiku pesa meno di Opus a parità di token, modello ignoto mai gratis); card che resta sul progetto del suo task senza worktree; una cartella sotto due scritture (link, barra finale, backslash) è un progetto; chiamate singole sul progetto della loro chat e cartella home mai progetto; e la somma: i punti di tutti i progetti più «fuori» = totale delle letture (±0,5). Più i due scenari della spec (7,5 e 2,5).
Prova sui dati veri: `bun scripts/project-quota-check.ts --db <copia del DB>` stampa per progetto punti 24h e 7gg, limite e superfici. Il DB vivo non si apre mai in scrittura.
Mutazione: tolta la divisione oraria il test dei due progetti è rosso; con il peso uguale per modello il test del peso è rosso.

## USAGE-29 Il limite di default (consegna 1: il limite; consegna 2: la pausa)
Consegna 1: `bun test server/routes/projects.quota-limit.test.ts` esce 0: progetto senza riga a 10, scelta scritta e riletta, «Nessuno» che toglie il limite, valore fuori dai passi rifiutato, una cartella dentro una worktree dello stesso progetto. Il misuratore («7/10», ambra dall'80%, rosso sopra) e la tabella della Dashboard: `tests/e2e/project-quota-meter.spec.ts` con video, mutazione sulla soglia dell'80%.
Consegna 2: `bun test server/services/project-pause.test.ts` esce 0: progetto senza impostazioni in pausa sopra 10 punti, card ferma col motivo, `spawn_agent` rifiutato, messaggio della persona che parte, errore di lettura che lascia passare.
Mutazione (consegna 2): con il controllo della pausa tolto dal dispatcher il test della card è rosso.

## USAGE-30 La conferma sincronizzata (consegna 2)
`bun test server/services/project-pause-alerts.test.ts` esce 0: un avviso fuori dall'app per pausa (comando per argv, testo su stdin, comando vuoto = nessun processo), «Continua» che sblocca per altri 10 punti, «Pausa fino a domani» che regge fino a mezzanotte.
Scenario e2e (video on): `pw-remote -- npx playwright test tests/e2e/project-pause.spec.ts`. Due finestre sulla stessa chat del progetto e la sua board, progetto portato sopra il limite: la striscia compare in tutte e due senza ricaricare; «Continua» in una fa sparire la striscia anche nell'altra, e viceversa. La card ferma dice «in pausa: limite del progetto» (kind `project-paused`, coperta dal test del dispatcher).
Prova vera: con `TOPICS_OWNER_ALERT_COMMAND` puntato a `jarvis-channels send-to whatsapp <chat principale>` e il limite di un progetto di prova a 0,1, arriva un messaggio WhatsApp col link; poi il limite torna al default.
Mutazione: se il gestore del frame `project:quota` non applica il frame di ritorno, o se «Continua» sblocca solo la sessione da cui parte, lo scenario e2e è rosso.

## Ciò che è verde resta verde
I test di `server/usage/person-usage.test.ts`, `server/services/task-dispatcher-spend-cap.test.ts` e quelli del menu progetto (HUBBR-16) restano verdi dalla CI della PR.
