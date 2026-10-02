## Da decidere

Comandi della chat: 5 scelte prima del codice.
1. `/resume` apre l'elenco delle sessioni Claude Code di questo progetto nate fuori da Topics (terminale, altri programmi), con ricerca, titolo, ramo, quando e «attiva adesso»; Invio la apre come chat nuova con la sua storia e continua la stessa sessione (chiedendo conferma se è ancora attiva in un terminale), perché è l'unico senso di /resume che Topics non copre già (le sue chat riprendono da sole, una tab chiusa torna con ⇧⌘T) e l'adozione esiste già, senza una porta dal 13/08 (o: /resume sparisce dal menu e l'adozione resta senza porta).
2. Il menu «/» mostra solo ciò che funziona nella chat aperta, in tre gruppi (Topics, i comandi del motore, le tue skill), e il gruppo del motore lo legge dal motore stesso (l'elenco che Claude Code dà all'avvio, i comandi che jcode e Gemini annunciano), perché oggi Topics tiene a mano una lista sbagliata nei due sensi: offre /resume, /agents e 10 skill spente, e non offre 84 dei 119 nomi dell'elenco della CLI, fra cui /init, /review e /usage (o: una lista per motore scritta a mano in Topics, da riallineare a ogni versione della CLI).
3. La risposta di un comando scritto (/status, /project, /goal, l'esito di /compact, i comandi che la CLI rifiuta) è una scheda nella conversazione, solo su questo schermo, che non va al modello e resta finché la chiudi o scrivi il messaggio dopo, perché oggi è una fascia verde in monospazio che sparisce dopo 5 secondi anche con 15 righe, e i rifiuti della CLI arrivano in inglese come risposte dell'agente (o: la scheda si salva nella chat come messaggio di sistema e la ritrovi alla riapertura).
4. /usage (e /cost) apre il livello Provider AI del menu utente, che guadagna in cima il misuratore del piano Claude (finestra di 5 ore e settimana, percentuale, quando si azzera) e la percentuale delle 5 ore in coda alla riga, perché Topics riceve già quelle cifre a ogni turno ma le mostra solo sopra la soglia dell'avviso, e il menu utente è la casa unica delle impostazioni (o: una scheda nella chat con le stesse cifre, e il menu non cambia).
5. Nel cassetto e nel commento di una card, un testo che inizia con un comando noto mostra la riga «I comandi vanno dati nella chat dell'agente · Apri la sessione», e Invio manda il testo come oggi, perché la sessione dell'agente ha già il composer intero e un secondo posto per gli stessi comandi va tenuto allineato (o: il cassetto ha lo stesso menu «/», e /compact, /model, /effort, /clear, /status agiscono sulla sessione della card).

Compreso, senza scelta:
- **Un comando scritto che in Topics ha già un controllo apre quel controllo.** /model apre il selettore del modello (lo stesso di ⇧⌘M nella change `model-selector`), /effort il cursore dello sforzo, /context l'ispettore del contesto, /permissions il selettore dell'autonomia, /fast l'interruttore della modalità veloce, /mcp il livello Strumenti del menu utente, /config il menu utente. Con un argomento valido agisce senza aprire niente (`/model opus`, `/effort high`, `/fast off`).
- **I nomi che la CLI rifiuta quando la pilota Topics non partono più.** La scheda dice che sono comandi del terminale e offre «Apri un terminale» nel progetto. /export fa l'esportazione della chat, /exit e /quit dicono ⌘W.
- **/help apre il menu «/» intero**, non un secondo elenco. La riga in fondo dice che i comandi di Topics non costano e che quelli segnati «turno» fanno lavorare il modello.
- **Ogni motore ha i suoi comandi, detti per nome.** /compact compatta su Claude Code (la CLI), su OpenClaw (il gateway) e sul motore di Topics (la sua compattazione, chiamata subito invece che vicino al tetto); su Codex, sulle API e su jcode e Gemini non è offerto. /clear fa dimenticare la sessione su ogni motore che ne ha una, jcode e Gemini compresi. /reasoning c'è solo su OpenClaw. Le skill solo su Claude Code, l'unico motore che le espande.
- **Nomi con un senso solo in Topics.** `/rename <nome>` rinomina la chat di Topics, non la sessione della CLI. /new e /reset sono /clear.
- **Fuori dal menu, ma non bloccati.** /agents (la CLI risponde che non c'è più) e /doctor (riscrive CLAUDE.md e la memoria) non compaiono; scritti a mano partono come oggi.
- **Un «/parola» che non è un comando** parte come messaggio normale, senza il segno del comando (SKILL-04).
- **Un guscio solo.** Il menu «/» e l'elenco di /resume usano `SuggestionMenu`, lo stesso della @menzione. Restano attaccati al composer anche sul telefono, con righe da 44 px. Ogni etichetta è in italiano e in inglese.
- **Il menu «+» del composer smette di ripetere i comandi.** Tiene allegati, voce ed esportazione, più una riga «Comandi /» che apre il menu «/» per chi non sa di poterlo scrivere.
- **/compact dice come è andata.** Mentre lavora c'è la scheda «in corso»; alla fine i token prima e dopo, oppure il motivo per cui non l'ha fatto.

Fuori:
- Le correzioni senza scelta trovate nello stesso audit (28, elenco a parte, del 03/10): /resume e /agents fuori dal menu, i 6 nomi che la CLI non ha più, /browser senza indirizzo, /model, /effort e /context, /reasoning, i 5 secondi della fascia, l'esito di /compact, /clear su jcode e Gemini, /new e /reset, /status, le skill spente, le skill che al primo turno e in plan mode diventano prosa (il contesto passa dopo il comando: misurato oggi, la skill si espande), «Appunta», «Cambia colore» e altre. Si fanno prima, e questa change parte da lì.
- Il selettore del modello (change `model-selector`) e i livelli del menu utente (change `sidebar-menu-settings`): qui si usano e non si ridisegnano.
- Le sessioni di Codex, jcode o Gemini dentro /resume.
- Un elenco dei sotto-agenti o dei profili degli agenti.
- I comandi che Codex, jcode e Gemini hanno solo nel loro terminale.
- Qualsiasi migration: niente di nuovo si salva sul server.

ok / ok ma 2 no

---

# Ogni comando ha un senso in Topics, e quelli che lo meritano hanno la loro UI

Richiesta di Attilio del 03/10 (testo in `.openspec.yaml`).

## Dove cambiarla

| # | Dove cambiarla |
|---|----------------|
| 1 | `CMDUI-03`; design §3 |
| 2 | `CMDUI-01`, `CMD-06` (modificato); design §2 |
| 3 | `CMDUI-04`; design §4 |
| 4 | `CMDUI-05`; design §5 |
| 5 | `CMDUI-08`; design §7 |

Mockup di oggi e della proposta, chiaro e scuro, desktop e telefono da 390 px:
`mockup.html`, aperto in WebKit (`screenshots/proposal-*.png`). Screenshot di oggi dal
server di test isolato (Chromium sul PC Windows, 02/10): `screenshots/today-*.png`.

## Why

Il menu «/» del composer è una lista scritta a mano (`client/src/components/Chat/slashCommands.ts:33-79`),
uguale su ogni motore. Una voce vale se la gestisce `handleSlashCommand`
(`ChatPane.tsx:897-1100`) oppure se il server la passa nuda alla CLI perché è in
`CLI_BUILTINS` (`server/context/adapt.ts:93-100`). Il test che lo garantisce
(`slashCommandRouting.test.ts`) controlla che il nome stia in uno dei due posti,
non che la CLI lo sappia eseguire quando la pilota Topics (`--print`, stream-json,
`server/providers/claude/args.ts:321-410`).

La CLI questo lo dice da sé: il messaggio `system/init` porta `slash_commands`, i
nomi che funzionano in quel modo. Su questo Mac sono 119 (misurato, Claude Code
2.1.288). Topics non lo legge da nessuna parte: `grep slash_commands server client shared`
non trova niente.

### Inventario: ogni comando e cosa fa oggi

Misurato = CLI vera lanciata con i flag di Topics, o server di test isolato (audit
del 02-03/10, file in `scratchpad/cmdaudit/`). Letto = solo codice.

| Comando | Oggi, su una chat Claude Code | Cosa diventa |
|---|---|---|
| /resume | nel menu come «Riprendi l'agente (@nome)»; la CLI risponde «/resume isn't available in this environment.» e la chat lo mostra come risposta (misurato, `today-resume-refused.png`) | elenco delle sessioni da riprendere (scelta 1) |
| /agents | nel menu come «Elenca i profili degli agenti»; la CLI risponde «The /agents wizard has been removed» (misurato); la rubrica degli agenti è stata tolta il 05/08 (AGENT-01) | fuori dal menu |
| /model | con un nome: imposta il modello (misurato). Senza, cioè scelto dal menu: la CLI stampa in inglese i suoi alias (misurato, `today-model-bare.png`) | apre il selettore |
| /effort | con un livello: lo imposta (misurato). Senza: fascia rossa «Uso: …» (misurato, `today-effort-bare.png`) | apre il cursore |
| /context | stima della busta di Topics, «872 / 1000k» (misurato); la CLI vera conta 19,9k su una sessione vuota (misurato) | apre l'ispettore dell'anello |
| /compact | la CLI compatta; la fascia «in corso» sparisce dopo 5 s; un fallimento (`compact_result: failed`) non viene letto (misurato) | scheda con l'esito vero |
| /clear | conferma, poi la sessione si azzera (misurato); su jcode e Gemini lo schermo si svuota e l'agente ricorda tutto (letto) | uguale, su ogni motore |
| /status | fascia di 5 s con nome della chat e progetto, che si vedono già, e senza il modello di default (misurato) | scheda (scelta 3), righe di CMD-07 |
| /help | 15 righe in una fascia di 5 s, senza le tue skill né i comandi della CLI (misurato, `today-help.png`) | il menu «/» intero |
| /reasoning | dice «usa /effort» con il nome claude-code su ogni motore; su OpenClaw sa solo accendere (letto e misurato via API) | solo su OpenClaw |
| /browser | con un indirizzo apre il browser; scelto dal menu va al modello come prosa (misurato) | con indirizzo come oggi; senza, dice l'uso |
| /project, /goal, /fork, /rewind | di Topics, funzionano (misurato); le risposte in fascia di 5 s, /project in inglese | scheda (scelta 3) |
| /usage, /cost | non nel menu; la CLI risponde con il testo del piano in 19 s (misurato) | misuratore nel menu utente (scelta 4) |
| /mcp, /config | non nel menu; la CLI stampa testo e uso in inglese (misurato) | aprono Strumenti e il menu utente |
| /init, /review, /security-review | non nel menu; turni del modello veri (misurato) | gruppo Claude Code, segnati «turno» |
| /export, /permissions, /memory, /vim, /login, /exit e altri 13 | non nel menu; inoltrati e rifiutati dalla CLI (misurato uno per uno) | risposta locale, o il gesto di Topics |
| /new, /reset | alias di /clear nella CLI: azzerano il processo vivo ma non lo schermo né l'id che Topics riprende (misurato oggi, CLI) | sono /clear |
| /fast, /rename | la CLI risponde «Fast mode is not available in the Agent SDK» e rinomina la sua sessione, non la chat (misurato) | l'interruttore e il nome di Topics |
| le tue skill | nel menu, anche le 10 spente in `skillOverrides`; al primo turno e in plan mode diventano prosa (misurato) | solo quelle accese; partono sempre |
| «/parolainventata» | segno del comando come un comando vero (misurato) | messaggio normale, senza segno |

Su Codex, sulle API e sul motore di Topics ogni voce che non intercetta Topics è
prosa: `codex exec` non ha comandi (misurato), il motore nativo non ha un parser
(letto). Su jcode e Gemini arrivano solo i comandi che annunciano via ACP (3 e 6,
misurato), ma Topics butta via l'annuncio (`server/providers/acp/translate.ts:167`).

### Cosa fanno gli altri

Ricerca del 02/10 (`scratchpad/cmdaudit/web.md`): Claude Desktop, l'estensione
VS Code, Zed, Codex app, Warp, OpenCode. Tutti dividono i comandi in tre: controlli
(modello, permessi, contesto, sessioni), comandi scritti che restano (/compact,
/init, /review), e comandi da terminale con un «non è disponibile qui» esplicito.
Nessuno con un elenco delle sessioni tiene /resume come comando scritto, tranne
Claude Desktop, dove /resume importa le sessioni nate dalla CLI su quella macchina:
è la scelta 1. VS Code dal 2.1.284 apre il selettore quando scrivi /model da solo.
L'errore che tutti hanno avuto e corretto è quello di oggi: offrire un comando che
il client non intercetta (T3 Code con /clear, Zed con /resume).

## What changes

- **Il menu «/»** si costruisce per la chat aperta: i comandi di Topics, il gruppo
  del motore letto dal motore, le tue skill accese (solo su Claude Code), tutti
  passati per una mappa di Topics che dice di ogni nome se apre un controllo, se
  resta un comando scritto, se è da terminale o se si nasconde.
- **/resume** apre l'elenco delle sessioni da riprendere e le adotta in una chat.
- **La scheda della risposta** prende il posto della fascia per ogni comando che
  risponde con del testo, compresi i rifiuti e gli esiti della CLI.
- **/usage** apre il misuratore del piano nel livello Provider AI del menu utente.
- **I comandi con un controllo** aprono il controllo.
- **Il cassetto della board** dice dove si danno i comandi.

## Non-goals

- Comandi nuovi che oggi non esistono né in Topics né nella CLI.
- Rifare l'ispettore del contesto, il selettore del modello o il menu utente.
- Una tavolozza dei comandi separata dal menu «/»: ⌘K resta la navigazione.

## Impact

Client: `Chat/slashCommands.ts` (diventa la parte Topics della mappa), nuovo
`Chat/commandMap.ts` (nome → tipo, il controllo da aprire, il gruppo),
`Chat/ChatInput.tsx` (menu «/» su `SuggestionMenu` con i gruppi; riga «Comandi /»
nel menu «+»), `Chat/ChatPane.tsx` (`handleSlashCommand` legge la mappa; la fascia
`commandResult` diventa `CommandAnswerCard`), nuovi `Chat/CommandAnswerCard.tsx` e
`Chat/ResumePicker.tsx`, `Chat/ProviderModelPicker.tsx`, `Chat/SessionConfigPopover.tsx` e `Chat/AutonomyPicker.tsx`
(si aprono da un evento), `Sidebar/` livello Provider AI (misuratore del piano, dalla
change `sidebar-menu-settings`),
`Board/TaskDetail.tsx` e `Board/Card.tsx` (la riga della scelta 5), i18n
`lib/i18n-it.ts`, `lib/i18n-en.ts`.

Server: `providers/claude/events.ts` (legge `system/init.slash_commands` e
`system/status` con `compact_result`), `providers/claude-code.ts` (tiene l'elenco per
sessione), `providers/acp/translate.ts` (tiene `available_commands_update`),
`routes/topics.ts` (`GET /api/slash-commands?topicId=` con i tre gruppi; nuova
`GET /api/topics/:id/resumable-sessions`), `lib/external-claude-sessions.ts`
(la finestra di 8 ore diventa un parametro, il titolo dai record `custom-title`,
`ai-title`, `last-prompt`), `providers/native/provider.ts` (compattazione a
richiesta).

Dipende da `sidebar-menu-settings` (i livelli Provider AI e Strumenti, `openUserMenu`).
Da `model-selector` solo per il selettore nuovo e ⇧⌘M: senza, /model apre il
`ProviderModelPicker` di oggi. Le correzioni senza scelta dello stesso audit atterrano
prima.

Specs: `commands` (CMDUI-01…08 aggiunti; CMD-06 modificato).
