# Vista Piano: Progetto → Area → Milestone → Task → Fonti

## Perché
Il lavoro aperto è sparso fra board, goal, sessioni (Claude Code, Codex, Muse, jcode), cron di Jarvis, rami e PR. Il Kanban dice lo stato di una card, non a quale risultato serve né cosa manca per chiuderlo. Serve una vista sola, sopra la board esistente, dove ogni lavoro compare una volta.

## Cosa cambia
- Tre tabelle nuove, nessuna copia delle card: `plan_areas` (gruppi di funzionalità per progetto), `plan_milestones` (risultato atteso, criteri di completamento, responsabile, stato, scadenza, ordine), `plan_task_links` (una card → al massimo una milestone, PK su task_id: è il vincolo che impedisce i doppioni), `plan_sources` (riferimenti esterni attaccati a una card o a una milestone: sessione, PR, ramo, commit, verifica, cron, con url).
- API `/api/plan`: albero con conteggi reali e avanzamento calcolati dalle card; CRUD di aree e milestone; collegare/scollegare una card a una milestone; aggiungere/togliere fonti. Le fonti implicite delle card (topic assegnato, topic d'origine, ramo e commit consegnati, checks) si mostrano senza copiarle.
- Segnali calcolati, mai salvati: duplicati (stesso `findDuplicateGroups` di `/duplicates`), consegnata ma ancora aperta (ramo o commit consegnato con card non done), senza proprietario (nessun topic assegnato e milestone senza responsabile), ferma da più di 7 giorni.
- Client: pulsante «Piano» nella board globale accanto a «Tutti i progetti»; albero espandibile Progetto → Area → Milestone → Card → Fonti, apertura della card (TaskDetail esistente) e della sessione d'origine; azioni: crea area/milestone, sposta card fra milestone, segna duplicato con l'unione esistente (`/tasks/:id/merge`), cambia responsabile e scadenza della milestone.
- Il prototipo `devbridge-sandbox/topics-plan-mvp.patch` è servito da spunto per il pulsante e il pannello; il raggruppamento per parole chiave NON entra: l'area la decide una persona o il coordinatore, non una regex.

## Barra
`bun test server/services/plan.test.ts server/routes/plan.test.ts client/src/components/Board/plan` esce 0 · `bunx tsc -p tsconfig.server.json --noEmit` e `cd client && bunx tsc --noEmit` escono 0 · mutazione: togliendo la PK su `plan_task_links.task_id` il test «una card in una sola milestone» diventa rosso · screenshot della vista con dati di prova.

## Fuori
Nessuna modifica al dispatcher, alle card esistenti o al Kanban oltre al pulsante. Nessuna importazione automatica delle fonti esterne (la fa il censimento, via API). Niente merge su main né riavvio della produzione senza ok di Attilio.

## Deciso da me
Persistenza in tabelle proprie e non in campi della card: la card resta la verità sullo stato, il Piano è un livello sopra e si può buttare senza toccare la board.

## Non ancora specificato
Se il coordinatore globale di Topics debba scrivere il Piano da solo (proposta in fase 5).
