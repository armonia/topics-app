# Tasks: commands-ui

Prima del codice: `grep -qx 'status: approved' openspec/changes/commands-ui/.openspec.yaml`.
Se esce non-zero, ci si ferma qui. Prima di questa change atterrano le correzioni
senza scelta dello stesso audit e la change `sidebar-menu-settings` con la modifica
del 03/10 (`openHome`, i pannelli Provider e chiavi e Strumenti; ramo
`feat/impostazioni-dove-si-usano-1003`).

La barra, sempre uguale: `bun run typecheck`, `bun run typecheck:e2e`,
`bun run lint`, i `check:*` di `ci.yml`, i test del §1, e
`bunx playwright test <spec del §1> --project=webkit` sul server isolato
(`tests/e2e/global-setup.ts`, :13334), con il carico a 1 minuto sotto 18; sopra,
Chromium sul PC con `tools/topwin`, un worker. Ciò che è verde resta verde.

## 1. Test rossi sul tree di oggi

- [x] 1.1 `tests/e2e/helpers/fake-claude-replay.ts`: un CLI finto che ripete righe registrate dalla CLI vera 2.1.288 (`system/init` con `slash_commands`, `system/commands_changed`, le risposte `<synthetic>` con `num_turns: 0`, `system/status` con `compact_result`) e scrive in `FAKE_CLI_LOG` ogni messaggio ricevuto e gli argomenti di avvio; installato come `installQueueTurnsCli` (`helpers/fake-claude-cli.ts:41`). L'header dice cosa non mostra: una compattazione vera, un `/clear` vero, l'espansione vera di una skill, la sostituzione di `$ARGUMENTS`, la risposta del modello. — Installato con `installReplayCli` (`helpers/fake-claude-cli.ts`).
- [x] 1.2 `client/src/components/Chat/commandMap.test.ts` (bun:test): ogni nome `engine` sta nella fixture dell'elenco della CLI (`server/providers/claude/fixtures/slash-commands-2.1.288.json`, i 119 nomi della misura del 02/10) o è un alias di un nome che c'è; la fixture porta accanto gli alias del registro (`usage`: `cost`, `stats`; `code-review`: `review`; `clear`: `new`, `reset`; `config`: `settings`; `doctor`: `checkup`; `exit`: `quit`); nessun nome `refused` ci sta; ogni nome `control` nomina un controllo che esiste; ogni descrizione in italiano e inglese. Prova del test: togliere gli alias dalla fixture lo fa rosso su `cost` e `review` (CMDUI-01, CMDUI-02, CMD-06).
- [x] 1.3 `server/providers/claude/events.test.ts`: `system/init` e `system/commands_changed` registrati diventano un elenco di comandi; un assistant `<synthetic>` con `num_turns: 0` in un turno partito da un comando diventa una risposta di comando, in un turno normale resta un messaggio (CMDUI-01, CMDUI-04).
- [x] 1.4 `server/lib/resumable-claude-sessions.test.ts` (fs finto, come `external-claude-sessions.test.ts`): titolo da `customTitle`, poi `aiTitle`, poi `lastPrompt`; solo le cartelle col prefisso del progetto, e un `cwd` fuori dal progetto scartato anche se la cartella ha il prefisso (`topics-app2`); una sessione in `claude_code_sessions` scartata senza leggerne la coda; 25 transcript → 20 righe, 20 code lette, `more: true`, e la pagina dopo col cursore; dopo un giro di /resume il censimento con gli stessi file non rilegge nessuna coda (CMDUI-03).
- [x] 1.5 `tests/e2e/chat-slash-menu.spec.ts`: su una chat Claude Code con il finto del 1.1 il menu «/» ha i tre gruppi, /init e /code-review segnati «turno», nessuna riga /review, nessuna skill spenta, nessun /agents; `/review` mandato arriva al finto come `/review` (la CLI lo risolve); su una chat dichiarata `topics` i gruppi Topics e Le tue skill; su una chat dichiarata Codex solo il gruppo Topics; «/re» filtra e i gruppi vuoti spariscono; frecce e Invio da tastiera; a 390x844 le righe sono alte almeno 44 px e il menu non è un foglio; con «Rispondi» armato `/code-review` arriva al finto senza la citazione (CMDUI-01, CMDUI-07). Prima guarda `chat-slash-claude-code.spec.ts` e `chat-command-visible.spec.ts` e riusa i loro helper.
- [x] 1.6 `tests/e2e/chat-resume-picker.spec.ts`: HOME del server di test con transcript finti in `.claude/projects/<progetto>/` (uno con `custom-title`, uno con solo `last-prompt`, uno appena toccato, 22 vecchi), più uno già legato a una chat e uno nella cartella di un altro progetto; /resume li elenca in ordine, 20 e «Carica più vecchie», filtra con la parola dopo, Invio apre una chat nuova con la storia importata e il turno dopo parte con `--resume <id>` (log del finto); la sessione attiva chiede conferma; una chat senza progetto risponde con la scheda (CMDUI-03).
- [x] 1.7 `tests/e2e/chat-command-answer.spec.ts`: /status disegna la scheda con Modello, Effort, Autonomia e niente nome della chat; resta dopo 6 s; si chiude con la X e col messaggio dopo; al ricarico non c'è e la storia mandata al finto non la contiene; /output-style mostra il testo `<synthetic>` del finto nella scheda e non come messaggio dell'agente; /compact mostra «in corso» e poi l'esito, anche quello fallito. Ogni testo si cerca DENTRO la scheda (il contenitore del bottone `chat.command.dismiss`), mai con `page.getByText`: «Not enough messages to compact.» oggi c'è già nella pagina come bolla dell'agente (CMDUI-04).
- [x] 1.8 `tests/e2e/chat-slash-controls.spec.ts`: /model, /effort, /context, /permissions, /fast aprono il loro controllo col fuoco dentro e niente arriva al finto; `/model opus` imposta senza aprire; /mcp apre il pannello Strumenti accanto al «+» senza montare la flotta; /config apre il menu utente (CMDUI-02).
- [x] 1.9 `tests/e2e/plan-usage-meter.spec.ts`: con `POST /api/test/plan-usage` (route di test esistente, `server/routes/e2e.ts:416`) /usage e /cost aprono il pannello Provider e chiavi accanto al selettore del modello; sotto le 5 ore la barra della settimana con percentuale, giorno e ora dell'azzeramento, ambra oltre la soglia; la riga del piano nel selettore dice «· sett. N%»; senza lettura la frase «nessuna lettura ancora» (CMDUI-05). Prima guarda `plan-usage-status.spec.ts` e la e2e del pannello sul ramo di `sidebar-menu-settings`.
- [x] 1.10 `tests/e2e/board-drawer-command-hint.spec.ts`: nel cassetto di una card con sessione, «/compact» fa comparire la riga con «Apri la sessione», che apre la chat dell'agente; Invio manda il testo come oggi (CMDUI-08).
- [x] 1.11 `server/providers/native/compaction.test.ts`: `compactNow` compatta sotto la soglia e restituisce i token prima e dopo senza un `StreamHandler`; la rotta scrive il marcatore e manda `stream:compaction` con `trigger: "manual"`; con un turno in volo 409 (CMDUI-06).
- [x] 1.12 Misura sulla CLI vera, prima del codice del §9 di design (stessi flag di Topics, modello verso una porta chiusa come in `scratchpad/cmdprop-probe/`): una skill di prova col corpo `ARGS=[$ARGUMENTS]`, avviata con un marcatore in `--append-system-prompt` e primo messaggio `/prova x`; il corpo mandato al modello deve contenere `ARGS=[x]` e il marcatore deve stare nel sistema. Esito scritto in `design.md` §9 al posto di «Non misurato». — Verificato col CLI finto, esito in design §9: main manda già il comando nudo nell'ultimo blocco. Non misurato con un modello vero.
- [x] 1.13 `server/context/adapt.test.ts`: primo turno con `/vai x` → `userContent` è `/vai x` e gli slot stanno nel prompt di sistema, registrati in `inlineSlots`; turno in plan mode su processo vivo con `/recap` → `userContent` è `/recap`, il turno dopo porta lo slot del plan mode; un messaggio non slash tiene `<context>` davanti; un built-in della CLI resta come oggi (CMDUI-09). — Sostituito da SKILL-03 (design §9): CMDUI-09 riscritto il 04/10 sulla forma di main, coperto con `@covers CMDUI-09` da `claude-code-slash-context.integration.test.ts` e `chat.skill-context.test.ts`, 6 pass.
- [x] 1.14 `server/lib/native-parity.test.ts`: `listSkills` salta una skill `off` in `skillOverrides` (SKILL-01).
- [x] 1.15 `tests/e2e/chat-pinned.spec.ts`: appunto un messaggio → segno sul messaggio e riga «1 appuntato · resta nel contesto dell'agente»; aprirla mostra il testo, la voce porta al messaggio; staccare toglie riga e segno (CMDUI-10).
- [x] 1.16 `tests/e2e/topic-color.spec.ts`: una chat nuova non ha il segno colorato su riga e tab; «Cambia colore» lo mette, il ricarico lo tiene (TOPIC-COLOR-01). — Già su main (`topic-color-surfaces.spec.ts`, TOPICUI-11), design §12.
- [x] 1.17 Test del predicato di visibilità di «Mostra nel Finder» (bun:test sul modulo puro) ed e2e nel client web del server di test: la voce non c'è (FILE-03).

## 2. Server

- [x] 2.1 `events.ts`: le righe `commands` e la risposta `<synthetic>` di un turno partito da un comando; `claude-code.ts` tiene l'elenco per sessione e l'ultimo per progetto e per motore, in memoria.
- [x] 2.2 `acp/translate.ts` e `acp.ts`: `available_commands_update` tenuto per sessione invece di buttato.
- [x] 2.3 `GET /api/slash-commands?topicId=`: i tre gruppi per il motore dichiarato (CMD-08), le skill del motore di Topics da `listSkills`; senza elenco visto, il gruppo Topics e le cartelle come oggi.
- [x] 2.4 `lib/resumable-claude-sessions.ts`: cartelle col prefisso del progetto, scarto dei posseduti dal nome, pagina da 20 con cursore, code lette in asincrono, cache sua (per path, 500 voci); titolo in `parseTranscriptFacts`; `GET /api/topics/:id/resumable-sessions`. `external-claude-sessions.ts` e la sua cache non cambiano.
- [x] 2.5 `native/provider.ts`: `compactNow`; `/api/command` `compact` lo chiama sul motore di Topics, scrive il marcatore e lo manda.
- [x] 2.6 `stream:command-answer` in `routes/chat.ts`, fuori da `messages` e dalla storia del provider.
- [x] 2.7 `context/adapt.ts` e `claude-code.ts`: con un'invocazione di un nome non built-in, gli slot del primo turno nel prompt di sistema della partenza, quelli volatili saltati su processo vivo (dopo l'esito del 1.12). — Sostituito da SKILL-03, stessa ragione del 1.13 (design §9).
- [x] 2.8 `lib/native-parity.ts`: `listSkills` legge `skillOverrides` e salta le `off`.
- [x] 2.9 `/reasoning` sul gateway: il primo token decide il ramo, l'argomento passa. — Già su main.

## 3. Client

- [x] 3.1 `Chat/commandMap.ts` con gli alias; `slashCommands.ts` diventa la parte Topics della mappa; `handleSlashCommand` legge la mappa (`topics`, `control`, `refused`) e risolve gli alias per primi.
- [x] 3.2 Menu «/» su `SuggestionMenu` con i gruppi, l'intestazione col nome del motore, le etichette «apre …» e «turno», la riga in fondo; una scelta senza argomenti esegue.
- [x] 3.3 Menu «+» del composer: via le righe dei comandi, una riga «Comandi /».
- [x] 3.4 `composer:open-control` ascoltato da `ProviderModelPicker`, `SessionConfigPopover`, `AutonomyPicker` e dal bottone dell'anello del contesto; /usage e /cost → `openHome('providers', <selettore del composer>)`, /mcp → `openHome('tools', <«+» del composer>)`, /config → `openUserMenu()`. — Coi ref di `ComposerControls`, non con un evento di finestra (design §12).
- [x] 3.5 `Chat/ResumePicker.tsx` nello stesso guscio, con «Carica più vecchie»; conferma per le sessioni attive; adozione col `transcriptPath` della riga, «in corso» finché risponde, apertura con `topics:open-topic`.
- [x] 3.6 `Chat/CommandAnswerCard.tsx` al posto di `commandResult`; /status, /project, /goal, /rewind, /fork, i rifiuti e l'esito di /compact passano di lì; `compactWatchRef` si chiude anche sull'errore.
- [x] 3.7 Pannello Provider e chiavi (di `sidebar-menu-settings`): la barra della settimana sotto le 5 ore e «· sett. N%» nella riga del piano del selettore.
- [x] 3.8 `Board/TaskDetail.tsx` e `Board/Card.tsx`: la riga del cassetto.
- [x] 3.9 `ChatPane.tsx`: un'invocazione salta la citazione, che resta armata; il segno del comando solo per i nomi conosciuti (SKILL-04).
- [x] 3.10 Appunta: segno sul messaggio e riga sopra i messaggi che apre `PinnedMessages`.
- [x] 3.11 Il colore scelto sulla riga e sulla tab, i due default esclusi. — Già su main, design §12.
- [x] 3.12 «Mostra nel Finder» solo nel guscio desktop su server loopback, con l'errore detto.
- [x] 3.13 i18n: ogni etichetta nuova in `i18n-it.ts` e `i18n-en.ts`.

## 4. Verifica

- [x] 4.1 La barra in cima, verde. — Atterrata con il merge 38076b5ef; CI di main verde sulla run 37160001728 (11d0a597e, che lo contiene).
- [x] 4.2 Video `.webm` WebKit di 1.5 (menu «/» desktop e 390 px), 1.6 (/resume fino alla chat aperta), 1.7 (/status e /compact), 1.9 (/usage fino al pannello) e 1.15 (Appunta), screenshot chiaro e scuro accanto a `screenshots/today-*.png`. — Su Chromium del PC Windows (carico del Mac sopra 18): `screenshots/impl-resume-adopt.webm` (/resume fino alla chat adottata che continua con `--resume`) e 20 screenshot `screenshots/impl-*-{light,dark}-{desktop,phone}.png` (menu «/», /resume, scheda, barra della settimana, riga degli appunti). Le altre e2e hanno il loro video negli artefatti del PC, non versionati.
- [x] 4.3 `bunx --bun @fission-ai/openspec@latest validate commands-ui` esce 0. — Esce 0 (03/10).
