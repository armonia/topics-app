# Tasks: commands-ui

Prima del codice: `grep -qx 'status: approved' openspec/changes/commands-ui/.openspec.yaml`.
Se esce non-zero, ci si ferma qui. Prima di questa change atterrano le correzioni
senza scelta dello stesso audit (28) e la change `sidebar-menu-settings`.

La barra, sempre uguale: `bun run typecheck`, `bun run typecheck:e2e`,
`bun run lint`, i `check:*` di `ci.yml`, i test del §1, e
`bunx playwright test <spec del §1> --project=webkit` sul server isolato
(`tests/e2e/global-setup.ts`, :13334), con il carico a 1 minuto sotto 18; sopra,
Chromium sul PC con `tools/topwin`, un worker. Ciò che è verde resta verde.

## 1. Test rossi sul tree di oggi

- [ ] 1.1 `tests/e2e/helpers/fake-claude-replay.ts`: un CLI finto che ripete righe registrate dalla CLI vera 2.1.288 (`system/init` con `slash_commands`, `system/commands_changed`, le risposte `<synthetic>` con `num_turns: 0`, `system/status` con `compact_result`) e scrive in `FAKE_CLI_LOG` ogni messaggio ricevuto; installato come `installQueueTurnsCli` (`helpers/fake-claude-cli.ts:41`). L'header dice cosa non mostra: una compattazione vera, l'espansione vera di una skill, la risposta del modello.
- [ ] 1.2 `client/src/components/Chat/commandMap.test.ts` (bun:test): ogni nome `engine` sta nella fixture dell'elenco della CLI (`server/providers/claude/fixtures/slash-commands-2.1.288.json`, dalla misura del 02/10), nessun nome `refused` ci sta, ogni nome `control` nomina un controllo che esiste; ogni descrizione in italiano e inglese (CMDUI-01, CMDUI-02, CMD-06).
- [ ] 1.3 `server/providers/claude/events.test.ts`: `system/init` e `system/commands_changed` registrati diventano un elenco di comandi; un assistant `<synthetic>` con `num_turns: 0` diventa una risposta di comando, non un messaggio (CMDUI-01, CMDUI-04).
- [ ] 1.4 `server/lib/external-claude-sessions.test.ts`: il titolo da `customTitle`, poi `aiTitle`, poi `lastPrompt`; la finestra come parametro; una sessione in `claude_code_sessions` esclusa (CMDUI-03).
- [ ] 1.5 `tests/e2e/chat-slash-menu.spec.ts`: su una chat Claude Code con il finto del 1.1 il menu «/» ha i tre gruppi, /init segnato «turno», nessuna skill spente, nessun /agents; su una chat dichiarata Codex solo il gruppo Topics; «/re» filtra e i gruppi vuoti spariscono; frecce e Invio da tastiera; a 390x844 le righe sono alte almeno 44 px e il menu non è un foglio (CMDUI-01, CMDUI-07). Prima guarda `chat-slash-claude-code.spec.ts` e `chat-command-visible.spec.ts` e riusa i loro helper.
- [ ] 1.6 `tests/e2e/chat-resume-picker.spec.ts`: HOME del server di test con tre transcript finti in `.claude/projects/<progetto>/` (uno con `custom-title`, uno con solo `last-prompt`, uno appena toccato), più uno già legato a una chat; /resume li elenca in ordine, filtra con la parola dopo, Invio apre una chat nuova con la storia importata e il turno dopo parte con `--resume <id>` (log del finto); la sessione attiva chiede conferma; una chat senza progetto risponde con la scheda (CMDUI-03).
- [ ] 1.7 `tests/e2e/chat-command-answer.spec.ts`: /status disegna la scheda con Modello, Effort, Autonomia e niente nome della chat; resta dopo 6 s; si chiude con la X e col messaggio dopo; al ricarico non c'è e la storia mandata al finto non la contiene; /output-style mostra il testo `<synthetic>` del finto nella scheda e non come messaggio dell'agente; /compact mostra «in corso» e poi l'esito, anche quello fallito (CMDUI-04).
- [ ] 1.8 `tests/e2e/chat-slash-controls.spec.ts`: /model, /effort, /context, /permissions, /fast aprono il loro controllo col fuoco dentro e niente arriva al finto; `/model opus` imposta senza aprire; /mcp e /config aprono il menu utente sul livello giusto (CMDUI-02).
- [ ] 1.9 `tests/e2e/plan-usage-meter.spec.ts`: con `POST /api/test/plan-usage` (route di test esistente, `server/routes/e2e.ts:416`) /usage apre il livello Provider AI col misuratore, le due percentuali, l'azzeramento, l'ambra oltre la soglia; senza lettura la frase «nessuna lettura ancora» (CMDUI-05). Prima guarda `plan-usage-status.spec.ts`.
- [ ] 1.10 `tests/e2e/board-drawer-command-hint.spec.ts`: nel cassetto di una card con sessione, «/compact» fa comparire la riga con «Apri la sessione», che apre la chat dell'agente; Invio manda il testo come oggi (CMDUI-08, scelta 5 consigliata).
- [ ] 1.11 `server/providers/native/compaction.test.ts`: `compactNow` compatta sotto la soglia e chiama `onCompaction` con `trigger: "manual"` (CMDUI-06).

## 2. Server

- [ ] 2.1 `events.ts`: le righe `commands` e la risposta `<synthetic>`; `claude-code.ts` tiene l'elenco per sessione e l'ultimo per progetto e per motore, in memoria.
- [ ] 2.2 `acp/translate.ts` e `acp.ts`: `available_commands_update` tenuto per sessione invece di buttato.
- [ ] 2.3 `GET /api/slash-commands?topicId=`: i tre gruppi per il motore dichiarato (CMD-08); senza elenco visto, il gruppo Topics e le cartelle come oggi.
- [ ] 2.4 `external-claude-sessions.ts`: titolo e finestra; `GET /api/topics/:id/resumable-sessions`.
- [ ] 2.5 `native/provider.ts`: `compactNow`; `/api/command` `compact` lo chiama sul motore di Topics.
- [ ] 2.6 `stream:command-answer` in `routes/chat.ts`, fuori da `messages` e dalla storia del provider.

## 3. Client

- [ ] 3.1 `Chat/commandMap.ts`; `slashCommands.ts` diventa la parte Topics della mappa; `handleSlashCommand` legge la mappa (`topics`, `control`, `refused`).
- [ ] 3.2 Menu «/» su `SuggestionMenu` con i gruppi, l'intestazione col nome del motore, le etichette «apre …» e «turno», la riga in fondo; una scelta senza argomenti esegue.
- [ ] 3.3 Menu «+» del composer: via le righe dei comandi, una riga «Comandi /».
- [ ] 3.4 `composer:open-control` ascoltato da `ProviderModelPicker`, `SessionConfigPopover`, `AutonomyPicker` e dal bottone dell'anello del contesto.
- [ ] 3.5 `Chat/ResumePicker.tsx` nello stesso guscio; conferma per le sessioni attive; adozione e apertura con `topics:open-topic`.
- [ ] 3.6 `Chat/CommandAnswerCard.tsx` al posto di `commandResult`; /status, /project, /goal, /rewind, /fork, i rifiuti e l'esito di /compact passano di lì.
- [ ] 3.7 Livello Provider AI del menu utente: il blocco del piano e la coda con la percentuale (dopo `sidebar-menu-settings`).
- [ ] 3.8 `Board/TaskDetail.tsx` e `Board/Card.tsx`: la riga della scelta 5.
- [ ] 3.9 i18n: ogni etichetta nuova in `i18n-it.ts` e `i18n-en.ts`.

## 4. Verifica

- [ ] 4.1 La barra in cima, verde.
- [ ] 4.2 Video `.webm` WebKit di 1.5 (menu «/» desktop e 390 px), 1.6 (/resume fino alla chat aperta) e 1.7 (/status e /compact), screenshot chiaro e scuro accanto a `screenshots/today-*.png`.
- [ ] 4.3 `bunx --bun @fission-ai/openspec@latest validate commands-ui` esce 0.
