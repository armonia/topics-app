# Tetto di spesa - la decisione, ridotta a una scelta sola

Numeri misurati il 27/08 sul DB vivo, in sola lettura. Il tasso di conversione
non e' inventato: e' ricavato dal libro chat, dove il costo in dollari e i token
sono scritti sulla stessa riga.

## Il fatto nuovo: le due proposte sono la STESSA soglia, in due unita'

| proposta | soglia | card colpite (su 477) | quota |
|---|---|---|---|
| "1M token per card" | 1.000.000 token grezzi | **27** | 5,7% |
| "25 USD per card"   | 25 USD                 | **41** | 8,6% |

1M di token grezzi vale **28,47 USD** in mediana: la soglia in dollari gia'
proposta e quella in token gia' proposta cadono quasi nello stesso punto. Non
c'e' un disaccordo sulla severita': c'e' una scelta di **unita' di misura**.

## Perche' l'unita' cambia le cose

Lo stesso milione di token vale **12,64 USD al p10 e 49,37 al p90**: quasi 4x di
scarto, perche' la quota di rilettura di cache cambia da card a card. Un tetto in
token e' un tetto che si sposta di quattro volte senza che nessuno lo tocchi.
In piu' i token della board e i dollari della chat non si sommano, quindi con
l'unita' token il tetto giornaliero (T2) non si puo' proprio scrivere.

## Il tasso, e da dove viene

Libro chat dal 01/08 (righe attendibili): 1.389 righe, **7.783,60 USD** su
1.232,96 M token equivalenti = **6,31 USD per M token equivalenti** (Opus-5;
4,22 su Sonnet-5). "Equivalente" e' la formula gia' in casa
(`shared/token-cost.ts`: rilettura di cache pesata 0,1).

Applicato al libro agenti: 477 card, 761,5 M token equivalenti = **~4.805 USD**
a tariffa Opus (~3.214 a Sonnet).

**I due libri sono disgiunti**, verificato: 0 righe di `messages` appartengono al
topic di una card. Quindi si sommano: **~12,6k USD in totale, di cui il 38% (la
board) oggi non compare in nessun contatore in dollari.**

## Quanto costa una card

| | token grezzi | USD (tariffa Opus) |
|---|---|---|
| mediana | 206.220 | 5,97 |
| p90 | 789.642 | 22,84 |
| p99 | - | 64,39 |
| massimo | 5.171.609 | **99,70** |

Il morso di ogni soglia candidata, sulla storia intera:

| tetto per card | card fermate | quota |
|---|---|---|
| 10 USD | 163 | 34,2% |
| 15 USD | 91 | 19,1% |
| **25 USD** | **41** | **8,6%** |
| 1M token | 27 | 5,7% |
| 50 USD | 7 | 1,5% |

## Il tetto giornaliero (T2), sui due libri sommati

39 giorni misurati. Sopra i **500 USD**: **4 giorni** (10-13/08, da 1.999 a
2.569 USD al giorno). Sopra i 300: 8 giorni. Negli **ultimi 14 giorni il massimo
e' 404 USD**, quindi un tetto a 500 oggi non morderebbe niente: morde il ritorno
di quei quattro giorni, che sono la ragione per cui questa card esiste.

Serve *oltre* a T1 perche' i due guasti sono diversi: la card piu' cara mai vista
vale 99,70 USD, il giorno piu' caro 2.569 su molte card ciascuna sotto il proprio
tetto. Nessuno dei due vede il guasto dell'altro.

## Il resto della forma (invariato, gia' concordato nel thread)

1. **Un contatore solo**, in centesimi USD, da `pricing.ts`: `recordAgentUsage`
   scrive anche i centesimi (colonna nuova `agent_cost_cents`). Due sono i
   **tetti**, non i contatori: T1 per card cumulativo, T2 per macchina su
   finestra mobile 24h.
2. **Freno, non taglio**: si rifiuta il turno SUCCESSIVO, non si uccide un turno
   a meta'. Costo misurato della scelta: si sfora al massimo di un turno
   (13,31 USD al p90 della chat, 47,15 nel caso peggiore visto), contro un
   worktree da ripulire a mano e soldi gia' pagati buttati.
3. **Lo alza solo una persona**, dalle impostazioni, sulla riga `'*'` (lo stesso
   posto dove vive gia' il tetto degli agenti in parallelo). Mai da solo. T2 si
   libera col passare della finestra, che e' tempo, non un tetto che si alza.
4. **Dove si vede**: riga del tetto e distanza nel `CostProbePanel`, pastiglia
   "speso oggi / tetto" nell'header della board, commento di sistema sulla card
   frenata con quanto e quale tetto, pastiglia ambra all'80%.
5. **Fail open** sul dato non prezzabile, fail closed solo su un numero
   attendibile sopra il tetto. Misurato: le righe storiche gonfiate dichiaravano
   *piu'* del vero, e oggi le righe non prezzabili sono 0 su 1.389. Accanto al
   tetto si mostra la **quota di spesa non prezzabile**, cosi' non diventa
   decorativo di nascosto.

## Cosa resta da decidere (una cosa sola)

- **A** - unita' USD, T1 25 USD/card **+** T2 500 USD/giorno per macchina.
  *(consigliata: e' la stessa severita' gia' proposta in token, ma somma i due
  libri e rende possibile il tetto giornaliero)*
- **B** - unita' USD, solo T1 25 USD/card, niente tetto giornaliero.
- **C** - unita' token, 1M/card, niente prezzo sugli agenti: si spedisce senza
  toccare `recordAgentUsage`, ma la stessa soglia vale fra 12 e 49 USD a seconda
  della card, e T2 resta impossibile.

Dopo la scelta l'implementazione e' meccanica: una colonna, una funzione di
prezzo gia' scritta, due letture nel dispatcher e tre punti di interfaccia.

## Come sono stati ottenuti i numeri

Tutto in sola lettura sul DB dell'app (`data/topics.db`, aperto con
`file:...?mode=ro`). Nessuna scrittura, nessuna migrazione.

Token equivalenti, la stessa formula di `shared/token-cost.ts` e di
`server/usage/token-sql.ts`:

```sql
-- riga di chat: la rilettura e' gia' dentro il prompt, quindi si sottrae
MAX(0, usage_prompt_tokens - cache_read_tokens) + usage_completion_tokens
  + 0.1 * cache_read_tokens
-- riga di card: la rilettura sta nella sua colonna
agent_tokens + 0.1 * agent_cache_read_tokens
```

Il tasso: `SUM(cost_cents)/100 / (SUM(equivalenti)/1e6)` sulle righe di
`messages` con `cost_cents > 0` e `timestamp >= '2026-08-01'` (le righe
attendibili: prima ci sono le 679 righe gonfiate ~10x gia' documentate in
`profile-stats.ts`). Viene 6,31 USD per M equivalenti, e la stessa query
spezzata per modello da' 6,31 su `claude-opus-5` e 4,22 su `claude-sonnet-5`,
cioe' il rapporto giusto fra i due listini: e' la verifica che il tasso non sia
un artefatto.

Disgiunzione dei due libri: nessuna riga di `messages` ha `session_key` uguale a
`'topic:' || tasks.assigned_topic_id`. Contate: 0 su 1.389. Percio' i due totali
si sommano invece di sovrapporsi.

Percentili: `ORDER BY ... LIMIT 1 OFFSET (COUNT(*)*k/100)`, cioe' il valore
osservato, non interpolato.
