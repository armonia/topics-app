# D7a · Card dopo SIGTERM

## Barra · prima → dopo

- E2E della card: bozza non verificata, **0/1** prove verdi → **1/1**, exit **0**, 41,8 s; video: `test-results/artifacts-18465/board-task-sigterm-resume--9b3a6--e-arriva-in-review-nightly-chromium/video.webm` (478 KB).
- Mutazione della riattaccatura: **0/1** → il test va rosso come atteso, exit **1**, 1 fallimento sull'assenza del commento di riattacco; dispatcher ripristinato, diff **0**.

## Fatto

- `tests/e2e/board-task-sigterm-resume.spec.ts`: avvia una card, attende testo parziale, invia SIGTERM al server e verifica la riattaccatura della sessione viva, la continuazione dello stesso turno, la consegna in review sul canale agente e il conteggio dei tentativi invariato. La prova produce il video indicato sopra.
- Bundle e2e isolato: `bun run build:client --out /private/tmp/d7a-sigterm-bundle.EQvdde` → exit **0**; `public/` del worktree intatto.
- Barra e2e, con Chromium e video: `env D7A_SINGLE_SPEC=1 E2E_PORT=18465 TOPICS_E2E_BUNDLE_DIR=/private/tmp/d7a-sigterm-bundle.EQvdde TOPICS_AI_BRIDGE=1 E2E_TIER=nightly E2E_VIDEO=1 npx playwright test --config=playwright.d7a-temp.config.ts tests/e2e/board-task-sigterm-resume.spec.ts --project=chromium --grep 'D7a' --retries=0` → exit **0**, **1 passed**.
- Mutazione: stesso comando con `E2E_PORT=18466`, ramo `if (live)` temporaneamente disabilitato → exit **1**, il test fallisce sull'asserzione «il dispatcher ha riattaccato la sessione viva originale». `git checkout -- server/services/task-dispatcher.ts` → ripristino; `git diff -- server/services/task-dispatcher.ts` vuoto.

## Trovato e non fatto

- Client/pane dopo riavvio, sleep/risveglio e censimento dei test instabili non eseguiti: punti 2–4 di D7, fuori dallo scope D7a.
- **Card nativa al boot: due che riprendono la stessa sessione.** Card `e9226ab7`, 13/10 23:44. Il
  dispatcher la riprende con la spinta di continuazione e scrive «Server ripartito a metà turno»;
  `POST /api/chat` risponde 409 per il blocco `boot` del ledger dei turni (`routes/chat.ts:703`, lo
  salta solo chi ha `resumeAttempt > 0`); il dispatcher riprova dopo 60 s («La sessione stava già
  rispondendo»). Danno: due note fuorvianti e un minuto di ritardo, nessun tentativo consumato. Il
  ramo è quello del runtime nativo, fuori da questo piano. Servirebbe decidere chi riprende una card
  nativa al boot, il dispatcher o il giro di ripresa della chat, e un test unit col ledger in `boot`.

## Rifiutato

- **«1 card tagliata a meta' turno» non vuol dire lavoro perso.** Le due righe del 13/10 nel log di
  produzione, rilette col database (in sola lettura):
  - 22:48, card `b76f5782`, sul broker: `riavvio: 1 riprese (1 in diretta)`, poi chiusa in `done`;
  - 23:44, card `e9226ab7`, sul runtime nativo (righe `[native] round` del topic `e0275c4b`): il
    turno vive nel processo del server e muore con lui per costruzione, il dispatcher riprende la
    stessa sessione senza consumare tentativi. Le difficoltà successive della card (static-rails,
    unit-ci, errori del provider) non c'entrano col riavvio.
- La spec copre il broker, l'unico turno che sopravvive al processo: è quello che si può riattaccare.

- Il primo turno finto finiva senza chiamare `update_task`: restare in `in_progress` era corretto, non un difetto di riattacco. La spec ora simula la consegna tramite la route agente mentre il turno originale è ancora vivo, poi verifica l'ultimo chunk.
- Il worktree non ha un bundle `public/` utilizzabile; il global setup lo segnalava prima di eseguire la spec. La build isolata in `/private/tmp` ha risolto il setup senza toccare `public/`.
