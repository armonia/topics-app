# board-vs-chat — dove si posano le misure

Questa cartella è l'ingresso della barra `scripts/board-vs-chat.ts`, che risponde
a una domanda sola: **a parità di lavoro consegnato, la board costa meno di una
chat?** La barra esce non-zero quando la parità non regge.

```
bun scripts/board-vs-chat.ts                # storico dal DB (sola lettura)
bun scripts/board-vs-chat.ts --json         # per un altro programma
bun scripts/board-vs-chat.ts --print-schema # il contratto dei file qui sotto
```

## Cosa mettere qui

| file | cosa contiene | chi lo scrive |
|---|---|---|
| `*.pair.json` | UN lavoro misurato sui tre bracci (board / chat Topics / CLI nuda) | chi esegue la misura appaiata |
| `cases.json` | la matrice dei casi limite, ogni riga con la sua PROVA ESEGUITA | chi prova i casi limite |

Entrambi vengono raccolti da soli: senza `--pair` la barra legge tutti i
`*.pair.json` di questa cartella, e come matrice `cases.json`.

**Il contratto esatto dei due file non sta scritto qui, sta in
`bun scripts/board-vs-chat.ts --print-schema`** — una seconda copia dello schema
è la garanzia che prima o poi i due divergano. Qui sotto c'è solo ciò che serve
a capire *perché* i campi sono quelli.

## Le tre regole che decidono se una misura vale

1. **I token li legge il reader del server.** Dove puoi, dai un
   `transcriptPath`: i numeri escono da `server/services/transcript-usage.ts`,
   lo stesso modulo che scrive `tasks.agent_tokens`. Un braccio `board` può dare
   un `taskId` (quelle colonne vengono dallo stesso reader). I numeri scritti a
   mano in `usage` si accettano ma restano marcati `declared`: non sono passati
   di lì, e la barra lo stampa.

2. **Lavoro e rilettura di cache non si sommano.** `work` (input + output +
   cache_creation, deduplicati per `message.id`) e `cacheRead`
   (`cache_read_input_tokens`, ~60% del consumo reale) sono due assi separati e
   la barra fallisce su ciascuno per conto suo. Un totale unico può dire verde
   mentre uno dei due è rosso.

3. **Un confronto non appaiato non è una parità.** Manca un braccio, uno dei due
   non ha consegnato, un braccio è a zero token → la barra scrive `NON APPAIATO`
   e non lo conta come verde. Se hai chiesto `--pair` e non ne esce nemmeno uno
   valutabile, esce non-zero: un'asserzione che non può fallire non è un
   cancello.

## Repliche: uno stesso lavoro misurato più volte

Più file con lo stesso `workId` sono **repliche dello stesso lavoro**, non lavori
diversi. In quel caso il cancello di parità si sposta sulle **mediane del
gruppo**, e le righe per-replica diventano informative (`← campione singolo`).

Non è una tolleranza mascherata, è l'unità di misura giusta: sulla campagna `t1`
il braccio di paragone (chat) varia **2,25×** fra la corsa più magra e la più
grassa — più del delta che i verdetti per-replica stavano giudicando. Con sei
verdetti indipendenti a tolleranza zero, due uscivano verdi: non perché la board
vincesse, ma perché in quella terna la chat era un fuori-scala. Un verde così è
il lancio di una moneta stampato come risultato.

La forbice sta nel referto, non va dedotta: le terne dichiarano `armsBundle`, e
la barra ne stampa `summary` (min/mediana/max per braccio) e
`costOrderingPerTriple` (l'ordine per costo **dentro** ogni terna, che è il
confronto davvero appaiato).

### Azioni umane: misurate ≠ contate a mano

`humanActions` è ciò che la corsa ha **misurato**. Il percorso in interfaccia
contato a mano sta in `humanActionsStructural`, si stampa e **non è un
cancello**: è una costante scritta nel file, quindi il confronto col tetto non
potrebbe mai variare — e ripetuto su tre repliche gonfierebbe una sola decisione
di progetto in tre fallimenti di misura. Il costo in click del percorso board sta
dove va giudicato: nella matrice dei casi limite e nello storico
(azioni per ciclo di review, dal DB).

## I tre numeri della campagna `t1` — e la risposta che danno

`token-live-json`: aggiungere `--json` a `scripts/token-live.ts` con un test.
Nove corse, tre terne, stesso albero (`baseTreeSha` nel bundle), stesso modello,
stesso effort, in sequenza. **Tutte e nove hanno consegnato** (test dell'agente
verde + sonda `--json` che produce JSON parsabile).

| braccio | work (min/mediana/max) | cacheRead (min/mediana/max) | costo (indice) |
|---|---|---|---|
| cli (`claude -p`) | 50,5k / 51,0k / 58,8k | 1,91M / 1,96M / 2,47M | 1,00 |
| chat Topics | 60,2k / 61,1k / 135,6k | 1,85M / 2,11M / 2,71M | 1,24 |
| board (dispatch **simulato**) | 75,0k / 89,9k / 115,6k | 2,33M / 3,04M / 3,13M | 1,62 |

**La colonna del costo è un indice, non una cifra.** Il braccio più magro (cli)
vale `1,00`, e ogni altro braccio è il **rapporto fra il suo costo mediano e
quello del cli** — mediana dei costi per replica, non costo dei token mediani,
quindi l'indice non è ricavabile dalle due colonne di token qui accanto. Quello
che serve a chi legge è l'ordine dei bracci e la distanza fra loro, non quanto è
costata la campagna: le cifre assolute la barra le calcola dal DB quando gira. La
stessa base vale per tutte le tabelle di questa pagina.

Mediana board vs mediana chat: **+47,0% di lavoro** e **+44,0% di rilettura
cache**. La board è più economica in 1 replica su 3 su ciascun asse — cioè i
singoli assi ballano — ma l'ordine per **costo** dentro la terna è
`cli < chat < board-sim` in **3 terne su 3**, senza ribaltarsi.

### E però queste nove corse rispondono alla domanda sbagliata

Tutte a `medium`, «per correttezza». Ma le due superfici non girano allo stesso
effort, e non è un dettaglio:

- **board** → il `board_settings.dispatch_effort` della board su cui giravano le
  corse è `medium`. Quel braccio era già giusto.
- **chat** → senza override per-topic, `resolveClaudeEffort`
  (`server/lib/topics-agent-prompt.ts`) cade sul default **`xhigh`**.

Cioè il braccio di paragone girava a un terzo di gas rispetto a una chat vera, e
il +47% misurava in buona parte quello. **Non è la penalità della board: è un
tetto alla penalità della board.** Pareggiare l'effort a mano sembra la cosa
onesta e non lo è — misura una terza superficie che non usa nessuno.

Per questo il bundle ha un quarto braccio, `chat-xhigh`, e `paired` ora significa
«stesso albero, stesso modello, stesso testo»: l'effort è una mappa per braccio
(`effortByArm`) con `sameEffort` a dichiarare l'asimmetria invece di nasconderla.
Il confronto che decide «da oggi solo board?» è **board contro `chat-xhigh`**; il
braccio `chat` a medium resta come controllo a effort pari.

### Rimisurato, e il verdetto si capovolge

Tre corse `chat-xhigh` dallo stesso albero `d760d733`, tutte e tre consegnate:

| braccio | work (min/mediana/max) | cacheRead (min/mediana/max) | costo (indice) |
|---|---|---|---|
| chat a **xhigh** | 104,6k / 108,8k / 148,3k | 3,37M / 4,25M / 8,34M | 2,07 |

Contro la board: **−17,4% di lavoro** e **−28,6% di rilettura cache**, e la board
è più economica in **3 repliche su 3 su entrambi gli assi**. L'ordine per costo è
`cli < chat(medium) < board < chat(xhigh)`, identico in tutte e tre le terne.

Cioè: a effort pari la board costa di più (l'envelope di dispatch è più lungo del
preambolo di chat), ma **contro la chat che useresti davvero costa di meno**, e il
motivo è che l'effort pesa più dell'envelope. Il primo numero misura il guscio, il
secondo risponde alla domanda.

Due avvertenze che restano: il braccio board è **simulato** (envelope reale,
dispatch no — i numeri del dispatch vero vengono da due card lavorate davvero
sulla board), e la forbice di `chat-xhigh` è larga (2,47× sulla rilettura cache),
quindi è il **3/3** a reggere l'affermazione, non la distanza fra le mediane.

Quindi `bun scripts/board-vs-chat.ts` **esce 0**: contro `chat-xhigh` il cancello
di parità passa. Prima della rimisura usciva **3** (misura negativa) contro la
chat a medium, e quel rosso non si aggiustava con `--tolerance-pct` — serviva
+48%, cioè oltre qualunque soglia difendibile. Non è stata una soglia a
cambiarlo: è stato misurare il braccio giusto. Il `3` resta il codice della
misura negativa e l'`1` quello dell'attrezzo rotto, e restano entrambi
raggiungibili: il cancello non è stato spento, ha smesso di scattare.

Il braccio `board` di questo confronto è **simulato**: le differenze dal dispatch
vero sono elencate una per una nelle `notes` di ogni terna e in `simulationGaps` del
bundle. Non è una misura del dispatcher reale.

## I casi limite

Un caso `uncovered` è rosso: significa che sulla board quel caso non ha strada.
Un caso marcato coperto **senza prova eseguita** è rosso allo stesso modo — la
prova è un comando con il suo esito e il suo output incollato, o un test che
gira. «L'ho letto nel sorgente» non è una prova. Quando la prova *è* un rifiuto
(un 409, un exit 1 voluto), si dichiara `expectExit`.

### `cases.json` non si scrive a mano, e non invecchia in silenzio

La matrice la genera `bun scripts/board-cases.ts --emit-cases`: fa girare le dieci
righe per davvero (~11s, e con il server vivo su :3333 anche i censimenti sul
campo) e registra l'esito osservato di ogni prova. La barra poi si **fida** di
quell'esito invece di rieseguire — è ciò che le permette di rispondere in 0,03s.

Il patto regge finché le sorgenti sotto non si muovono, quindi `--emit-cases`
scrive anche una **impronta**: lo sha256 di ogni file che le prove leggono
(`scripts/board-cases.ts`, i test del server citati, la superficie della board).
Se un solo byte cambia, la barra dichiara `stale-matrix` ed esce non-zero:
`cases.json` va **rigenerato**, non ritoccato. Senza impronta il file è rifiutato
in ingresso — una matrice che non può essere dichiarata stantia lascerebbe verde
qualunque refactor.

### Righe che contano, righe che asseriscono

Un censimento sul campo («quanti task hanno `planFirst`») non asserisce un
numero: un numero atteso invecchierebbe ogni giorno. Perciò quelle righe si
chiamano `censimento:` e non si spacciano per asserzioni — ma non sono nemmeno
verdi eterni: falliscono se la **colonna** che stanno contando sparisce dal
payload, perché contare `undefined` stampa «0» e «0» somiglia troppo a una
risposta. Le righe che invece asseriscono un fatto (la rotta `/api/topics/streaming`
porta un array `sessions`; il binding task↔sessione porta a messaggi leggibili)
diventano **rosse**, non `skipped`, quando il fatto cade: `skipped` resta
riservato al server che non risponde, cioè al fatto non messo alla prova.

## Cosa la barra non fa

Non spende e non tocca niente: non lancia `claude`, non dispatcha, non scrive,
e il DB lo apre in sola lettura. Il braccio CLI si misura una volta con
`bun scripts/prefix-budget.ts --probe` e si consegna qui dentro. Il braccio CLI
non è un cancello: non consegna un task, non ha thread né review — serve a
sapere quanto costa il guscio, e la barra lo stampa come sovrapprezzo.
