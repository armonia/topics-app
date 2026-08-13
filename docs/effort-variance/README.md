# Quanto balla il giudice del dispatch

Da quando l'effort è `auto` (commit `7e074543`), lo sforzo di un task dispatchato
lo sceglie una chiamata haiku one-shot. È la leva di costo più pesante che
abbiamo: sullo stesso micro-task, `medium` costa 61,1k token di lavoro e `xhigh`
108,8k, cioè **1,8×**, e la rilettura di cache raddoppia. Sull'indice di costo di
[board-vs-chat](../board-vs-chat/README.md) quei due sforzi valgono `1,24` e
`2,07`. Quindi se quella chiamata balla, lo stesso task costa di più per un
lancio di dado.

Il sospetto veniva da tre chiamate di fila sullo stesso testo: `opus medium`,
`opus high`, `opus medium`. Tre non sono una misura. Questi sono i numeri.

## Come si rifà

```bash
bun scripts/effort-variance.ts --n 20                 # senza rimedio
bun scripts/effort-variance.ts --n 20 --vote 3        # con il rimedio
bun scripts/effort-variance.ts --rescore <referto>    # ricalcola, zero chiamate
```

Il testo di prova è il micro-task `token-live-json` della campagna board-vs-chat
(`scripts/board-vs-chat.arms.json`, `microTaskText`, sha256 nel file): lo stesso
su cui sono stati misurati i 61,1k/108,8k. La sonda usa il **prompt vero** e i
**lettori veri** del picker (importati, non ricopiati): se il prompt cambia, la
misura cambia con lui.

**Il numero che conta** non è «quante risposte diverse ho visto», è la
probabilità che **due dispatch indipendenti dello stesso task ricevano un
verdetto diverso** — `1 − Σ pᵢ²` sulla distribuzione osservata, nella forma senza
reimmissione. Zero = sempre lo stesso verdetto.

## Il giudice one-shot — `baseline-n20.json`

20 chiamate, stesso identico testo:

| | distribuzione | disaccordo |
|---|---|---|
| sforzo | `medium` 16 · `high` 4 | **33,7%** |
| modello | `opus` 17 · `sonnet` 3 | 26,8% |
| piano (modello+sforzo) | `opus medium` 13 · `opus high` 4 · `sonnet medium` 3 | 54,2% |

Un dispatch su tre riceve uno sforzo diverso dal precedente. E il campione da tre
diceva che *il modello* reggeva: a N=20 non regge neanche quello.

## Il rimedio: mediana di tre voti — `median3-n20.json`

20 prove da 3 voti = 60 chiamate. Il confronto è **appaiato dentro la stessa
corsa** — i 60 voti singoli sono il giudice *senza* rimedio, le 20 mediane sono
lo *stesso* materiale col rimedio:

| | senza rimedio (60 voti) | mediana di 3 (20 prove) |
|---|---|---|
| **sforzo** | 32,5% | **10,0%** |
| modello | 41,3% | 39,5% |
| piano | 62,3% | 46,8% |

**Perché appaiato e non fra le due corse.** Fra la corsa baseline e questa —
stesso testo, la stessa ora — la quota di `sonnet` è passata dal 15% al 28%.
Confrontare due corse separate misurerebbe anche quello scarto, quindi il
paragone si fa dentro la stessa corsa. Sull'unico asse in cui le due corse
concordano — lo sforzo, `high` al 20% in entrambe — la misura del giudice nudo è
replicata: 33,7% e 32,5%.

> **Corretto il 2026-08-10 (`prompt-ab.md`).** Quel 15% → 28% era letto qui come
> *deriva nel tempo* del giudice. Non regge: una calibrazione a vuoto — due
> prompt **identici**, stessa corsa, chiamate alternate — ha prodotto 50% contro
> 30% sullo stesso testo *senza che passasse un secondo*. Lo scarto è il campione
> da 20 che è troppo piccolo per una quota di quell'ordine, non un giudice che si
> muove. Il paragone appaiato resta l'unico che vale; cambia il motivo.

**Sullo sforzo il voto funziona:** 32,5% → 10,0%, e il conto teorico lo prevede
(con `high` al 20%, la maggioranza di tre lo fa vincere nel 10,4% dei casi
invece che nel 20%). È l'asse che costa, ed è quello per cui il rimedio è stato
adottato.

**Sul modello il voto quasi non serve, e non è un difetto del voto:** lì il
giudice è genuinamente diviso vicino al 30/70, e nessun numero ragionevole di
voti mette d'accordo chi non ha un'opinione. Il problema del modello è un altro —
il giudice declassa a `sonnet` un task che il suo stesso prompt gli dice di
tenere su `opus` — e si affronta sul prompt, non sull'aggregazione.

→ **Fatto, e misurato: [`prompt-ab.md`](prompt-ab.md).** Il prompt aveva due
righe che combaciavano con lo stesso task, e quella per `sonnet` premiava di
fatto le descrizioni scritte bene. Riscritte, la quota di `sonnet` sul bersaglio
va da 7/60 a **0/60** nella stessa corsa (Fisher p = 0,013), e i task che
`sonnet` deve vincere restano `sonnet` 20/20.

## Le tarature

- **Tre voti, non cinque.** Il guadagno per voto cala in fretta e il grosso lo
  prendono i primi tre; cinque costerebbero due giudici in più per limare quel
  che resta. Se un giorno si vorrà alzare, si alza guardando questo stesso
  referto.
- **Mediana, non «il più frequente».** Su tre voti la mediana *è* il voto di
  maggioranza ogni volta che una maggioranza c'è. Quando i tre voti sono tutti
  diversi — cioè proprio dove servirebbe uno spareggio — la mediana risponde
  comunque, e con quello di mezzo invece che con un estremo; un `argmax` lì
  dovrebbe inventarsi una regola, e qualunque regola sarebbe un altro dado.
- **In parallelo.** Tre giudici in serie triplicherebbero l'attesa prima che
  l'agente nasca. Partono insieme, e c'è un test che lo impedisce di rompere.
- **L'altra strada, non presa.** Memorizzare la scelta sul task al primo dispatch
  azzera il ballo su un *ri*-dispatch, ma non tocca la prima estrazione: sceglie
  a caso una volta sola e poi congela, anche quando congela male. Non riduce
  l'incertezza, la nasconde meglio.

## Il campione

N=20 prove per corsa: le barre d'errore sono larghe (una manciata di punti
percentuali si sposta con un paio di prove). Regge il verso e l'ordine di
grandezza del salto sullo sforzo — un terzo → un decimo — non la terza cifra.
