## Da decidere

Comandi della chat: 5 scelte prima del codice.
1. `/resume` elenca le sessioni Claude Code del progetto nate fuori da Topics e Invio ne apre una come chat che continua la stessa sessione, perché è l'unico /resume che Topics non copre già e l'adozione è senza porta dal 13/08 (o: /resume esce dal menu).
2. Il menu «/» offre solo ciò che funziona nella chat aperta e il gruppo del motore lo legge dal motore, perché la lista a mano offre /resume, /agents e 10 skill spente e non ha 77 dei 119 nomi della CLI, fra cui /init e /usage (o: una lista a mano per motore).
3. La risposta di un comando è una scheda nella conversazione, solo su questo schermo, finché la chiudi, perché oggi sparisce in 5 s anche con 14 righe e uno stato salvato si rileggerebbe come vero alla riapertura (o: si salva nella chat come messaggio di sistema).
4. Il pannello Provider e chiavi aggiunge sotto le 5 ore la barra della settimana, e la riga del piano nel selettore la sua percentuale, perché il blocco settimanale ferma per giorni e le cifre arrivano già a ogni turno (o: solo le 5 ore, come già deciso).
5. «Appunta» resta, con un segno sul messaggio e una riga «N appuntati · restano nel contesto dell'agente» in cima alla chat, perché oggi l'appunto pesa sul contesto senza che niente lo mostri, come si è deciso per il colore (o: «Appunta» sparisce e gli appunti escono dal contesto).

Compreso, senza scelta:
- **Un comando che in Topics ha già un controllo apre quel controllo.** /model il selettore del modello, /effort il cursore dello sforzo, /context l'ispettore del contesto, /permissions il selettore dell'autonomia, /fast l'interruttore della modalità veloce. /usage e /cost aprono il pannello Provider e chiavi del selettore del modello (abbonamento e finestra di 5 ore in cima, già decisi in `sidebar-menu-settings`), /mcp il pannello Strumenti del «+» del composer, /config il menu utente (Aspetto, Notifiche, Vista). Con un argomento valido agisce senza aprire niente (`/model opus`, `/effort high`, `/fast off`).
- **Le skill e i tuoi comandi ricevono il contesto fuori dal messaggio**, al primo turno e in plan mode: al primo turno va nel prompt di sistema con cui parte la CLI; su un processo già vivo il blocco che cambia (plan mode, board globale) salta quel turno e torna al successivo, e il plan mode lo fa rispettare comunque la CLI (`--permission-mode plan`). Messo dopo il comando diventerebbe `$ARGUMENTS` e finirebbe a metà frase nelle tue skill (`~/.agents/skills/vai/SKILL.md:7`).
- **Le skill ci sono dove il motore le espande**: Claude Code (skill e comandi tuoi) e il motore di Topics (le skill, col suo tool `skill`). Le 10 spente in `skillOverrides` spariscono dal menu e anche dal prompt del motore di Topics, che oggi le elenca.
- **«Cambia colore» resta**, e il colore scelto si vede sulla riga della chat e sulla sua tab (TOPIC-02 lo chiede; oggi non lo dipinge niente).
- **«Mostra nel Finder» compare solo sulla macchina che fa girare il server**: il server lo esegue con `open -R` sul Mac, quindi da un telefono o da un altro computer apriva il Finder altrove.
- **Nel cassetto e nel commento di una card un testo che inizia con un comando mostra «I comandi vanno dati nella chat dell'agente · Apri la sessione»**, e Invio manda il testo come oggi. Un menu «/» nel cassetto spetta alla change `conversazione-unica-della-card`, che rifà il cassetto.
- **I nomi che la CLI rifiuta quando la pilota Topics non partono più.** La scheda dice che sono comandi del terminale e offre «Apri un terminale» nel progetto. /export fa l'esportazione della chat, /exit e /quit dicono ⌘W.
- **/help apre il menu «/» intero**, non un secondo elenco. La riga in fondo dice che i comandi di Topics non costano e che quelli segnati «turno» fanno lavorare il modello.
- **Ogni motore ha i suoi comandi, detti per nome.** /compact su Claude Code, OpenClaw e il motore di Topics; su Codex, API, jcode e Gemini non è offerto. /clear fa dimenticare la sessione su ogni motore che ne ha una. /reasoning solo su OpenClaw, dove mostra o nasconde il ragionamento.
- **Gli alias sono il loro comando.** /review è /code-review, /cost è /usage, /new e /reset sono /clear: nel menu una riga sola, scritti a mano funzionano.
- **Nomi con un senso solo in Topics.** `/rename <nome>` rinomina la chat di Topics, non la sessione della CLI.
- **Fuori dal menu, ma non bloccati.** /agents (la CLI risponde che non c'è più) e /doctor (riscrive CLAUDE.md e la memoria) non compaiono; scritti a mano partono come oggi.
- **Un «/parola» che non è un comando** parte come messaggio normale e senza il segno del comando: il segno lo decide il nome, letto fra quelli che il menu conosce (SKILL-04 sopra il riconoscimento per forma di SKILL-03).
- **Un comando scritto con una risposta armata parte senza la citazione**, che resta pronta per il messaggio dopo.
- **Un guscio solo.** Il menu «/» e l'elenco di /resume usano `SuggestionMenu`, lo stesso della @menzione, attaccati al composer anche sul telefono, righe da 44 px, etichette in italiano e in inglese.
- **Il menu «+» del composer smette di ripetere i comandi.** Era la porta «sempre raggiungibile» (`slashCommands.ts:45-50`); lo resta con una riga «Comandi /» che apre il menu «/».
- **/compact dice come è andata.** «In corso» finché arriva l'esito, poi i token prima e dopo o il motivo per cui non l'ha fatto.

Fuori:
- Le correzioni senza scelta dello stesso audit (elenco a parte, del 03/10): /resume e /agents fuori dal menu, i 6 nomi che la CLI non ha più, /browser senza indirizzo, /model, /effort e /context, /reasoning, i 5 secondi della fascia, l'esito di /compact, /clear su jcode e Gemini, /new e /reset, /status, le skill spente e altre. Si fanno prima, e questa change parte da lì.
- Il selettore del modello (change `model-selector`) e i pannelli e il menu utente di `sidebar-menu-settings`: qui si aprono e non si ridisegnano, salvo la barra della settimana (scelta 4).
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
| 2 | `CMDUI-01`, `CMD-06` e `SKILL-01` (modificati); design §2 |
| 3 | `CMDUI-04`; design §4 |
| 4 | `CMDUI-05`; design §5 |
| 5 | `CMDUI-10`; design §10 |

Mockup di oggi e della proposta, chiaro e scuro, desktop e telefono da 390 px:
`mockup.html`, aperto in WebKit (`screenshots/proposal-*.png`). Screenshot di oggi dal
server di test isolato (Chromium sul PC Windows, 02/10): `screenshots/today-*.png`.

## Why

Il menu «/» del composer è una lista scritta a mano (`client/src/components/Chat/slashCommands.ts:33-79`,
14 voci), uguale su ogni motore. Una voce vale se la gestisce `handleSlashCommand`
(`ChatPane.tsx:897-1100`) oppure se il server la passa nuda alla CLI perché è in
`CLI_BUILTINS` (`server/context/adapt.ts:93-100`). Il test che lo garantisce
(`slashCommandRouting.test.ts`) controlla che il nome stia in uno dei due posti,
non che la CLI lo sappia eseguire quando la pilota Topics (`--print`, stream-json,
`server/providers/claude/args.ts:321-410`).

La CLI questo lo dice da sé: il messaggio `system/init` porta `slash_commands`, i
nomi che funzionano in quel modo. Su questo Mac sono 119 (misurato, Claude Code
2.1.288). Topics non lo legge da nessuna parte: `grep slash_commands server client shared`
non trova niente. Di quei 119, 77 non sono nel menu (misurato il 03/10: il menu ha
le 14 voci di Topics e 45 tue; 7 delle 14, cioè compact, clear, context, model,
effort, agents e goal, e 35 delle 45 sono nell'elenco; le altre 10 sono le skill
spente). L'elenco porta i nomi, non gli alias: /review non c'è perché è l'alias di
/code-review, /cost di /usage, /new e /reset di /clear (`scratchpad/cmdaudit/registry.md` §1a, §1b).

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
| /compact | la CLI compatta; se non può manda «Not enough messages to compact.» come messaggio `<synthetic>`, che la chat mostra come risposta dell'agente, mentre la fascia «in corso» non diventa mai un errore e l'attesa (`compactWatchRef`, `ChatPane.tsx:485-507`) non si chiude (misurato) | scheda con l'esito vero |
| /clear | conferma, poi la sessione si azzera (misurato); su jcode e Gemini lo schermo si svuota e l'agente ricorda tutto (letto) | uguale, su ogni motore |
| /status | fascia di 5 s con nome della chat e progetto, che si vedono già, e senza il modello di default (misurato) | scheda (scelta 3), righe di CMD-07 |
| /help | 14 righe in una fascia di 5 s, senza le tue skill né i comandi della CLI (misurato, `today-help.png`) | il menu «/» intero |
| /reasoning | dice «usa /effort» col nome claude-code su ogni motore (letto; via API misurato solo su una chat Claude Code); su OpenClaw mostra o nasconde il ragionamento, e `/reasoning off` scritto non arriva al ramo, che confronta il comando intero | solo su OpenClaw, con l'argomento |
| /browser | con un indirizzo apre il browser; scelto dal menu va al modello come prosa (misurato) | con indirizzo come oggi; senza, dice l'uso |
| /project, /goal, /fork, /rewind | di Topics, funzionano (misurato); le risposte in fascia di 5 s, /project in inglese | scheda (scelta 3) |
| /usage, /cost | non nel menu; la CLI risponde con il testo del piano (misurato, $0) | apre Provider e chiavi dal selettore (scelta 4 per la settimana) |
| /mcp, /config | non nel menu; la CLI stampa testo e uso in inglese (misurato) | il pannello Strumenti del «+», il menu utente |
| /init, /code-review (alias /review), /security-review | non nel menu; turni del modello veri (misurato: /review avvia il subagente di code-review, $0,091) | gruppo Claude Code, segnati «turno» |
| /export, /permissions, /memory, /vim, /login, /exit e altri 13 | non nel menu; inoltrati e rifiutati dalla CLI (misurato uno per uno) | risposta locale, o il gesto di Topics |
| /new, /reset | alias di /clear nella CLI: azzerano il processo vivo (misurato oggi sulla CLI) ma non lo schermo né l'id che Topics riprende (letto: l'unico lettore di `init`, `background-work.ts:207`, tiene l'id per il risveglio) | sono /clear |
| /fast, /rename | la CLI risponde «Fast mode is not available in the Agent SDK» e rinomina la sua sessione, non la chat (misurato) | l'interruttore e il nome di Topics |
| le tue skill | nel menu, anche le 10 spente in `skillOverrides`; al primo turno e in plan mode diventano prosa, perché il contesto sta davanti al comando (misurato) | solo quelle accese; il contesto passa fuori dal messaggio |
| «/parolainventata» | segno del comando come un comando vero (misurato) | messaggio normale, senza segno |

Sul motore di Topics non c'è un parser dei comandi, ma le skill funzionano: il prompt
le elenca (`server/lib/native-parity.ts:86`, `listSkills`, spente comprese) e il tool
`skill` dice al modello che «/<nome>» è una richiesta esplicita di caricarla
(`server/providers/native/tools.ts:311-314`). Su Codex e sulle API ogni voce che non
intercetta Topics è prosa: `codex exec` non ha comandi (misurato). Su jcode e Gemini
arrivano solo i comandi che annunciano via ACP (3 e 6, misurato), ma Topics butta via
l'annuncio (`server/providers/acp/translate.ts:167`).

Ci sono anche gesti dei messaggi e delle chat che salvano senza che si veda niente:
«Appunta» salva l'appunto e lo mette nel contesto dell'agente
(`server/context/assemble.ts:843-845`), ma l'elenco degli appunti non si apre da
nessuna parte (misurato, `cmdaudit/bugs.md` B19); «Cambia colore» salva un colore che
la colonna non dipinge (`Sidebar/TopicItem.tsx:240-243`); «Mostra nel Finder» lo
esegue il server con `open -R` (`server/routes/files.ts:1182`), anche quando il clic
viene da un telefono o da Windows.

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

### Le altre change

- `sidebar-menu-settings`, modifica del 03/10 (SETHOME-01, ramo
  `feat/impostazioni-dove-si-usano-1003`): ogni modulo vive dove si usa. Provider e
  chiavi si apre dal piede del selettore del modello, con abbonamento e finestra di 5
  ore in cima (USERMENU-10); Strumenti dal «+» del composer; il menu utente tiene
  account e Piano, Dispositivi con le Macchine, Aspetto, Notifiche, Vista. Questa
  change ci apre i comandi con `openHome` (`client/src/lib/openHome.ts` su quel ramo).
- `chat-claude-code-parity` (non approvata), CHAT-SLASH-01: voleva /context, /cost e
  /status come risposte in chat. Qui /context apre l'ispettore, /cost il pannello dei
  provider e /status la scheda: per questi tre CHAT-SLASH-01 va letto come sostituito.
- `conversazione-unica-della-card` (non approvata) rifà il cassetto della card: un
  menu «/» lì dentro si decide in quella change.

## What changes

- **Il menu «/»** si costruisce per la chat aperta: i comandi di Topics, il gruppo
  del motore letto dal motore, le tue skill accese dove il motore le espande, tutti
  passati per una mappa di Topics che dice di ogni nome se apre un controllo, se
  resta un comando scritto, se è da terminale o se si nasconde.
- **/resume** apre l'elenco delle sessioni da riprendere e le adotta in una chat.
- **La scheda della risposta** prende il posto della fascia per ogni comando che
  risponde con del testo, compresi i rifiuti e gli esiti della CLI.
- **/usage e /cost** aprono Provider e chiavi dal selettore del modello.
- **I comandi con un controllo** aprono il controllo.
- **Le skill al primo turno e in plan mode** si espandono, col contesto fuori dal messaggio.
- **Appunta, colore, Finder** dicono e fanno quello che promettono.
- **Il cassetto della board** dice dove si danno i comandi.

## Non-goals

- Comandi nuovi che oggi non esistono né in Topics né nella CLI.
- Rifare l'ispettore del contesto, il selettore del modello, i pannelli o il menu utente.
- Una tavolozza dei comandi separata dal menu «/»: ⌘K resta la navigazione.

## Impact

Client: `Chat/slashCommands.ts` (diventa la parte Topics della mappa), nuovo
`Chat/commandMap.ts` (nome → tipo, alias, il controllo da aprire, il gruppo),
`Chat/ChatInput.tsx` (menu «/» su `SuggestionMenu` con i gruppi; riga «Comandi /»
nel menu «+»), `Chat/ChatPane.tsx` (`handleSlashCommand` legge la mappa; la fascia
`commandResult` diventa `CommandAnswerCard`; la citazione non si attacca a un
comando), nuovi `Chat/CommandAnswerCard.tsx` e `Chat/ResumePicker.tsx`,
`Chat/ProviderModelPicker.tsx`, `Chat/SessionConfigPopover.tsx` e
`Chat/AutonomyPicker.tsx` (si aprono da un evento), il pannello Provider e chiavi di
`sidebar-menu-settings` (la barra della settimana), `Chat/PinnedMessages.tsx` e il
segno dell'appunto, `Sidebar/TopicItem.tsx` e la tab (il colore),
`Project/FileExplorer.tsx` (Mostra nel Finder), `Board/TaskDetail.tsx` e
`Board/Card.tsx` (la riga del cassetto), i18n `lib/i18n-it.ts`, `lib/i18n-en.ts`.

Server: `providers/claude/events.ts` (legge `system/init.slash_commands` e
`system/status` con `compact_result`), `providers/claude-code.ts` (tiene l'elenco per
sessione; il contesto di un primo turno con una skill nel prompt di sistema),
`context/adapt.ts` (il blocco non sta più davanti a una skill),
`providers/acp/translate.ts` (tiene `available_commands_update`),
`routes/topics.ts` (`GET /api/slash-commands?topicId=` con i tre gruppi; nuova
`GET /api/topics/:id/resumable-sessions`), nuovo `lib/resumable-claude-sessions.ts`
(le cartelle del progetto, una pagina alla volta, cache sua; il censimento delle
8 ore non si tocca), `lib/native-parity.ts` (`listSkills` salta le spente),
`providers/native/provider.ts` (compattazione a richiesta).

Dipende da `sidebar-menu-settings` con la modifica del 03/10 (`openHome`, il pannello
Provider e chiavi, il pannello Strumenti, `openUserMenu`). Da `model-selector` solo per
il selettore nuovo e ⇧⌘M: senza, /model apre il `ProviderModelPicker` di oggi. Le
correzioni senza scelta dello stesso audit atterrano prima.

Specs: `commands` (CMDUI-01…10 aggiunti; CMD-06 e SKILL-01 modificati), `topics`
(TOPIC-COLOR-01 aggiunto), `files` (FILE-03 modificato).
