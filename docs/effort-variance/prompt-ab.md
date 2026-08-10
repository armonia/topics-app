# Il giudice contro il suo stesso prompt

Il referto accanto (`README.md`) chiudeva con una riga aperta: sul MODELLO il
voto di maggioranza non serve, perché il giudice è genuinamente diviso, e il
problema — declassa a `sonnet` un task che il suo prompt dice di tenere su
`opus` — «si affronta sul prompt». Questo è quel lavoro.

## Come si rifà

```bash
bun scripts/prompt-ab.ts --n 60 --only token-live-json   # il bersaglio
bun scripts/prompt-ab.ts --n 20                          # + i controlli
bun scripts/prompt-ab.ts --rescore <referto>             # ricalcola, zero chiamate
```

Due bracci: `v1` è il prompt com'era fino al 2026-08-10, congelato in
`scripts/prompt-ab.arms.ts`; `live` è `CLASSIFIER_PROMPT` **importato**, cioè
quello vero. Le chiamate dei due bracci stanno in **un solo pool e si
alternano**, così una qualunque deriva del provider colpisce entrambi.

## Perché il giudice diceva `sonnet` — non era indecisione

Prima di toccare il prompt gli è stato chiesto anche il motivo (12 chiamate,
stesso testo, una riga di spiegazione). Le due fazioni non descrivono due task
diversi: descrivono lo **stesso** task con le stesse parole.

> `sonnet` — «Task piccolo e completamente specificato — aggiungere un flag, niente design o ragionamento.»
> `opus` — «Task circoscritto e pienamente specificato (aggiungi --json, aggiungi test); strada già scritta.»

Il giudice non era incerto sul task: era il **prompt** ad avere due righe che
combaciavano entrambe. `opus` diceva «qualsiasi lavoro reale, feature, più
file»; `sonnet` diceva «piccolo e pienamente specificato in un punto solo». Un
task ben scritto le soddisfa tutte e due, e a quel punto quale vince è un lancio
di moneta. La clausola di sicurezza — «nel dubbio opus» — non scattava mai,
perché il giudice non era in dubbio: sentiva un *match*.

Da lì la diagnosi vera, che è più antipatica del sintomo: **il prompt premiava
la qualità della descrizione**. Più il task era scritto bene, più era probabile
che si prendesse il modello piccolo — e quanto bene un task è scritto non dice
niente su quanto è grosso il lavoro.

## Prima di misurare: quanto vale 20 punti di differenza

Il primo giro è stato una **calibrazione a vuoto** — la stessa corsa, la stessa
batteria, ma con i due bracci ancora *identici*. Qualunque differenza esca lì è
rumore per costruzione.

| caso (n=20 per braccio) | braccio A | braccio B |
|---|---|---|
| **token-live-json** | **50,0%** `sonnet` | **30,0%** `sonnet` |
| typo-readme | 0% fuori bersaglio | 0% |
| bump-version | 0% | 0% |
| debug-scroll | 0% | 0% |

Venti punti di scarto fra due prompt **identici**, misurati nello stesso
istante. Il che corregge una riga del referto accanto: il salto «15% → 28% a
un'ora di distanza» era attribuito alla deriva del giudice nel tempo, ma un
divario più largo di quello nasce senza che passi un secondo. Non è deriva, è
**il campione da 20 che è troppo piccolo** per una quota di quell'ordine. Da qui
il bersaglio si misura a n=60, e le quote vanno con l'intervallo di Wilson.

L'altra metà della tabella conta quanto la prima: sui tre casi di controllo il
giudice è **unanime, 20 su 20**. L'instabilità non è diffusa — è concentrata sul
solo task che sta davvero a cavallo del confine.

## Il rimedio, misurato

Tre modifiche, tutte sulla parte del MODELLO (le righe dello sforzo non sono
state toccate, così lo sforzo fa da controllo):

1. lo spareggio diventa una regola eseguibile: *se il task combacia con più di
   una riga, vince sempre la più capace — le righe sono un pavimento, non
   un'alternativa*, al posto di «nel dubbio opus» che non scattava mai;
2. la qualità della descrizione viene esclusa a voce alta: *si scende per la
   dimensione del lavoro, mai per la chiarezza con cui è descritto*;
3. `sonnet` smette di essere «piccolo e ben specificato» e diventa un elenco di
   lavoro che **non aggiunge niente di nuovo** (typo, rinomina, bump, costante,
   fix di una riga già diagnosticato, test su codice che esiste già), con la
   controparte su `opus`: *se il task fa fare al programma qualcosa che prima
   non faceva — un'opzione, un campo, un formato, un endpoint — è opus*.

Bersaglio, **n=60 per braccio, stessa corsa** (`prompt-ab-target-n60.json`):

| | `sonnet` | quota | IC 95% |
|---|---|---|---|
| `v1` | 7 / 60 | 11,7% | [5,8% – 22,2%] |
| **`live`** | **0 / 60** | **0,0%** | [0,0% – 6,0%] |

Fisher esatto a due code **p = 0,013**. Gli intervalli non si toccano.

Controlli, n=20 per braccio (`prompt-ab-battery-n20.json`): nessuna fuga verso
l'alto — `typo-readme` e `bump-version` restano `sonnet` **20/20** sul prompt
nuovo (sul vecchio `typo-readme` scappava a `opus` una volta su venti),
`debug-scroll` resta `opus` 20/20. Lo sforzo, che non è stato toccato, non si
sposta: `debug-scroll` resta `xhigh`, i due piccoli restano `medium`.

## Era davvero un difetto? `sonnet` costa meno

La domanda è giusta e la risposta non è «`opus` è meglio». Il difetto non è
*quale* modello usciva: è che **lo stesso task riceveva due modelli diversi a
seconda del lancio**, contro una regola che il prompt enunciava e non riusciva a
far rispettare. Un router che sceglie a caso non sta risparmiando, sta tirando i
dadi — e sul micro-task di riferimento la scelta cambiava fra due modelli con
prezzi molto diversi.

Restava aperta la domanda di merito: `token-live-json` — aggiungere un'opzione
`--json` a uno script più il suo test, due file — merita `opus` o `sonnet`? Il
prompt, com'era scritto, rispondeva «entrambi». Ora risponde **`opus`**, e lo fa
per una ragione dichiarata (*aggiunge comportamento nuovo*) invece che per una
tendenza. Se un giorno la decisione fosse che quel genere di task va su `sonnet`,
la leva adesso esiste ed è una riga sola — e la si sposta rifacendo questa
misura, non a naso.

## Il campione

n=60 sul bersaglio, n=20 sui controlli. La calibrazione a vuoto qui sopra è la
ragione per cui i numeri vanno letti con l'intervallo accanto: a n=20 una quota
del 30% e una del 50% sono lo stesso identico prompt. Regge il verso
(`sonnet` scompare dal bersaglio) e regge lo zero dei controlli; non regge la
terza cifra.
