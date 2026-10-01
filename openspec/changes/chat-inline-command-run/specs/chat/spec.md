# Chat — eseguire un comando scritto dall'agente, e leggerne il risultato lì

## ADDED Requirements

### Requirement: CHAT-RUN-01 — Il blocco shell di una risposta finita offre Esegui, e niente gira da solo

Un blocco di codice SHALL offrire «Esegui» e «Apri nel terminale», accanto a
Copia, solo quando valgono tutte queste condizioni:

- è dentro una risposta `assistant` con `sessionKey` e `messageId`, e la
  risposta NON è `partial` (durante lo streaming `completePartialMarkdown`,
  `client/src/components/MessageContent.tsx:59`, chiude i fence aperti e un
  comando troncato si disegnerebbe come finito);
- l'etichetta del fence è `bash`, `sh`, `zsh`, `shell`, `console` o
  `shellsession`, e `runnableCommand` (funzione pura) ne estrae un comando non
  vuoto: il testo intero per le prime quattro; per `console`/`shellsession`
  solo le righe che cominciano con `$ ` o `% `, senza il prompt;
- la sessione è di un proprietario e il server ha una shell POSIX
  (`hasCommandShell`, `server/lib/command-process.ts:20`).

Il bottone NON SHALL comparire nei messaggi `user`, nei blocchi senza
etichetta, nell'anteprima dei file markdown
(`client/src/components/Editor/MarkdownPreview.tsx`), nell'editor
(`EditorTabs.tsx`), né per un ospite. `markdownComponents`
(`MessageContent.tsx:574`) SHALL restare una costante di modulo: l'abilitazione
arriva da un contesto React che solo `MessageContent` fornisce.

Nessun comando SHALL partire senza un clic su Esegui: non all'arrivo del
messaggio, non al ricarico, non al riaprire la chat, non da una scorciatoia da
tastiera. Il blocco intero SHALL girare come un solo script.

#### Scenario: una risposta finita con un blocco bash
- **GIVEN** una risposta dell'agente completa con un fence `bash` che contiene `echo ciao`
- **WHEN** la chat si apre
- **THEN** l'intestazione del blocco mostra Esegui e Apri nel terminale accanto a Copia
- **AND** nessun processo è partito (`GET /api/scripts` non ha righe nuove)

#### Scenario: mentre l'agente scrive, niente Esegui
- **GIVEN** una risposta ancora in streaming il cui fence `bash` è a metà
- **THEN** il blocco non mostra Esegui
- **AND** lo mostra appena la risposta è completa

#### Scenario: console esegue solo le righe col prompt
- **WHEN** `runnableCommand('console', '$ git status\nOn branch main\n$ ls')`
- **THEN** il risultato è `git status\nls`

#### Scenario: dove il bottone non c'è
- **GIVEN** lo stesso fence `bash` in un tuo messaggio, in un file `.md` aperto nell'anteprima, e in un fence senza etichetta
- **THEN** in nessuno dei tre compare Esegui

### Requirement: CHAT-RUN-02 — Un comando distruttivo o con un segnaposto chiede un secondo passo; uno con caratteri invisibili non si esegue

`commandRisk(command)` (funzione pura) SHALL restituire le ragioni per un
secondo passo e l'eventuale blocco, valutando **tutto** il testo anche quando
il blocco di codice è collassato.

- Nessuna ragione: il clic su Esegui SHALL bastare.
- Ragioni di conferma (`rm` con `-r`/`-f`, `sudo`, `git push` forzato,
  `git reset --hard`, `git clean -f`, `git checkout -- .`, `git restore .`,
  `dd`, `mkfs`, `diskutil erase`, `chmod -R`, `chown -R`, `find … -delete`,
  `xargs rm`, `curl`/`wget` in pipe verso una shell, `kill -9`, `killall`,
  `pkill`, `launchctl bootout`, `launchctl kickstart -k`, e un segnaposto
  `<parola>` che non sia `<<` né `< file`): il clic SHALL aprire, al posto
  dell'intestazione, una striscia che nomina le ragioni con «Esegui comunque»
  e «Annulla», con il fuoco su Annulla. Nessuna finestra modale.
- Caratteri invisibili (controlli bidi U+202A–U+202E e U+2066–U+2069, larghezza
  zero U+200B–U+200D, U+2060, U+FEFF, byte C0 diversi da tab e a capo):
  Esegui NON SHALL esserci, e l'intestazione SHALL dire perché; Copia e Apri
  nel terminale restano.

#### Scenario: un ls parte al primo clic
- **GIVEN** un blocco `bash` con `ls -la`
- **WHEN** clicchi Esegui
- **THEN** il comando parte senza altre domande

#### Scenario: rm -rf chiede conferma
- **GIVEN** un blocco `bash` di 30 righe (collassato a 10) la cui riga 25 è `rm -rf build`
- **WHEN** clicchi Esegui
- **THEN** compare la striscia che nomina `rm -rf` e nessun processo è partito
- **AND** Annulla la chiude senza lanciare niente; Esegui comunque lancia il blocco

#### Scenario: un segnaposto chiede conferma
- **WHEN** `commandRisk('python3 analyze_song.py <take>.mp3')`
- **THEN** fra le ragioni c'è `placeholder`
- **AND** `commandRisk('cat <<EOF\nx\nEOF')` e `commandRisk('wc -l < file.txt')` non la contengono

#### Scenario: caratteri invisibili
- **GIVEN** un blocco `bash` con `echo ok` seguito da U+202E
- **THEN** Esegui non c'è e l'intestazione dice che il comando contiene caratteri invisibili

### Requirement: CHAT-RUN-03 — L'output si legge sotto il blocco, come in un terminale fatto bene

Dopo Esegui, sotto il blocco di codice SHALL comparire il blocco
dell'esecuzione (`data-testid="command-run"`), con:

- **intestazione**: stato (in corso con il tempo che scorre; `exit 0` con
  pallino verde; `exit N` con barra rossa a sinistra; «fermato»; «esito
  sconosciuto»), durata, cartella in cui è girato (abbreviata con `~`), e
  per un'esecuzione di un'altra giornata quando è girata;
- **azioni**: Stop mentre gira; poi Riesegui, Copia output, Manda
  all'agente (CHAT-RUN-04), Apri nel terminale (CHAT-RUN-05), Nascondi output;
- **output**: monospazio, colori SGR resi come span (16, 256, truecolor,
  grassetto, corsivo, sottolineato, dim), ogni altra sequenza ANSI tolta, di
  ogni riga solo il segmento dopo l'ultimo `\r`; mai `innerHTML`.

Mentre gira, l'output SHALL stare in un riquadro alto 16 righe che segue il
fondo, e SHALL smettere di seguirlo se chi legge scorre in su, finché non torna
in fondo. Finito, fino a 20 righe SHALL mostrarsi tutto; oltre, le **ultime** 20
con «Mostra tutte le N righe» sopra. Se il server ha tagliato righe (CMDRUN-06),
il blocco SHALL dirlo.

L'esecuzione SHALL restare legata al blocco dopo un ricarico e su ogni
dispositivo del proprietario: si mostra l'ultima esecuzione del blocco, solo se
il suo comando coincide col testo del blocco disegnato. Riesegui SHALL creare
un'esecuzione nuova, che prende il posto della precedente nella vista.

#### Scenario: un comando lento si vede mentre gira, poi chiude verde
- **GIVEN** un blocco `bash` con `for i in 1 2 3; do echo L$i; sleep 1; done`
- **WHEN** clicchi Esegui
- **THEN** entro 2 s il blocco dell'esecuzione mostra `L1` e lo stato in corso con Stop
- **AND** alla fine mostra `L1`, `L2`, `L3`, `exit 0` e una durata di circa 3 s

#### Scenario: un fallimento si vede rosso
- **GIVEN** un blocco `bash` con `echo boom >&2; exit 3`
- **WHEN** gira
- **THEN** l'intestazione mostra `exit 3` con la barra rossa e l'output `boom`

#### Scenario: Stop
- **GIVEN** un'esecuzione di `sleep 60` in corso
- **WHEN** clicchi Stop
- **THEN** entro 5 s lo stato è «fermato» e il processo non esiste più

#### Scenario: output lungo dalla coda
- **GIVEN** un'esecuzione finita di `seq 1 500`
- **THEN** si vedono le righe da 481 a 500 e «Mostra tutte le 500 righe»
- **AND** il clic le mostra tutte

#### Scenario: i colori si leggono
- **GIVEN** un'esecuzione di `printf '\033[31mrosso\033[0m ok\n'`
- **THEN** `rosso` è in uno span colorato, ` ok` no, e nel testo non resta nessun `[31m`

#### Scenario: dopo un ricarico l'esito è ancora lì
- **GIVEN** un'esecuzione finita con `exit 0`
- **WHEN** ricarichi la pagina
- **THEN** sotto lo stesso blocco ci sono di nuovo output, `exit 0` e durata

### Requirement: CHAT-RUN-04 — L'agente vede l'esecuzione solo se la mandi tu

Un'esecuzione NON SHALL entrare nel contesto dell'agente, né aprire un turno,
né scrivere una riga nella conversazione. «Manda all'agente» SHALL aggiungere in
fondo alla bozza della chat, senza sostituirla e senza inviare, un fence
`console` con `$ <comando>`, una riga `(exit N, durata, in <cartella>)` e le
ultime 50 righe dell'output senza ANSI, con il fuoco sul composer.

L'evento `topics:seed-composer` (`client/src/components/Chat/ChatPane.tsx:208-218`)
SHALL accettare `mode: 'append'`; senza `mode` SHALL sostituire, come oggi.

#### Scenario: niente arriva all'agente da solo
- **GIVEN** un'esecuzione finita in una chat
- **THEN** nessun messaggio nuovo compare nella conversazione e nessun turno parte

#### Scenario: Manda all'agente riempie la bozza
- **GIVEN** una bozza che contiene `guarda qui:`
- **WHEN** clicchi Manda all'agente su un'esecuzione di `seq 1 80` finita con `exit 0`
- **THEN** la bozza comincia con `guarda qui:` e continua con il fence che contiene `$ seq 1 80`, `exit 0` e le righe da 31 a 80
- **AND** nessun messaggio è stato inviato

### Requirement: CHAT-RUN-05 — Apri nel terminale: una shell nella stessa cartella, il comando scritto e non eseguito

«Apri nel terminale» SHALL creare una shell nella cartella in cui girerebbe
l'esecuzione (la sceglie il server da `cwdOf: <sessionKey>`, CMDRUN-05), aprirla
come pane accanto alla chat, e incollarvi il comando **senza Invio**, con
`term.paste()` di xterm alla prima schermata della shell. Se il comando ha più
righe e la shell non ha il bracketed paste acceso, NON SHALL incollare niente:
il comando va negli appunti e un avviso lo dice. Nessun byte di controllo
diverso da tab e a capo SHALL arrivare alla shell: un `\r` diventa a capo, gli
altri (C0, DEL) si tolgono, perché un `ESC[201~` chiuderebbe il bracketed paste
e farebbe girare le righe dopo. È l'uscita per ciò che
l'esecuzione in linea non può fare: `sudo`, login, prompt, modificare il
comando prima di lanciarlo.

#### Scenario: sudo va nel terminale
- **GIVEN** un blocco `bash` con `sudo wg-quick up edm`
- **WHEN** clicchi Apri nel terminale
- **THEN** si apre una pane terminale la cui shell è nella cartella della chat
- **AND** la riga di comando contiene `sudo wg-quick up edm` e nessun comando è stato eseguito

#### Scenario: un blocco di due righe non parte a metà
- **GIVEN** un blocco `bash` con `cd app\nbun test`
- **WHEN** clicchi Apri nel terminale
- **THEN** la shell mostra entrambe le righe nella riga di comando e nessuna è stata eseguita

#### Scenario: un byte di controllo non chiude l'incolla
- **GIVEN** un blocco `bash` con `echo safe`, `ESC[201~`, a capo, `touch x`
- **WHEN** clicchi Apri nel terminale
- **THEN** alla shell arrivano `echo safe[201~` e `touch x` senza l'ESC, e nessuna riga è stata eseguita
