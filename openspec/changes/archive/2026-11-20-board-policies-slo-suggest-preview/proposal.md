# Proposal: board-policies-slo-suggest-preview

> Approvata il **2026-09-22 11:41** (vedi `.openspec.yaml`). Risposta esatta di
> Attilio: «**vai in maniera solida e pulita**», data sul blocco a tre scelte
> presentato nelle tre card Topics `7a765c14`, `07168418`, `df916871`.

## Da decidere

Tre policy della board, ognuna nella sua card. Nessuna delle 26 change
precedenti le copriva: `mac-usabile-sotto-carico` (approvata 15/09) sta sullo
stesso asse del carico ma non contiene nessuno SLO, e vi compare `fan-out` solo
come meccanica dell'envelope.

1. **SLO fan-out** (`7a765c14`) — misurare le attese invece di promettere un
   numero: l'invariante che già vale si dichiara, e le volte che il dispatch e'
   stato trattenuto si contano. **Risposta: approvata.**
2. **Prossimo task** (`07168418`) — la skill `orchestrator` raccomanda la `todo`
   davvero sbloccata con `priorityAuto` piu' alto, e dice «nessuna» quando non
   ce ne sono. **Risposta: approvata.**
3. **Anteprima prima della review** (`df916871`) — solo per le card gia'
   classificate `visibile`. **Risposta: approvata.**

«vai in maniera solida e pulita» = tutte e tre le consigliate.

## Why

Le tre card erano ferme perche' nessuna diceva **su che base** agire, e il modo
in cui erano ferme era diverso per ognuna.

- **Lo SLO non aveva i suoi tre parametri.** Cosa si promette, su che finestra,
  cosa succede quando lo si manca: senza, e' un numero che nessuno fa
  rispettare. E il 22/09, con swap al 93% (19.105 MB su 20.480) e CPU a 0,0%,
  uno SLO scritto sul carico CPU avrebbe aperto altri agenti nel momento
  peggiore. Si misura prima di promettere.
- **Il consiglio rischiava di mentire con autorita'.** `server/routes/tasks.ts`
  lo dice gia' di un altro suggeritore: «a suggestion that happens to work by
  luck is worse than no suggestion, because it looks authoritative». Con 912
  card chiuse e 15 board attive un ordine sbagliato non e' rumore, e' una spinta
  a lavorare sulla cosa sbagliata.
- **Il gate sulla prova non aveva un bersaglio.** Chiederla ovunque produce
  ricatture su card senza superficie, cioe' artefatti fatti per il cancello e
  non per chi legge. E i due interruttori che sembravano governarla —
  `requireApprovalForDone`, `requireReviewBeforeDone` — non governano niente:
  esistono nello schema (`001-initial.sql:279-280`) e nelle settings, ma hanno
  zero occorrenze in logica di produzione, perche' KANBAN-05 e' una proprieta'
  dell'attore («it is a property of the actor, not a board setting»,
  `server/services/tasks.ts:12`).

## What changes

- `dispatchFanOut` **resta 1**: un agente per card, e non diventa un tetto
  globale. Nessuna guardia RAM toccata, nessun automerge, nessun profilo.
- Le attese del dispatch diventano leggibili: quante volte trattenuto e per
  quanto tempo cumulato.
- Una card **gia' etichettata `visibile`** non entra in `review` con l'anteprima
  vuota. Le altre classi restano invariate.
- La skill `orchestrator` guadagna un passo di raccomandazione, read-only, senza
  allargare l'allowlist dei cinque strumenti e senza avviare niente.

## Non-goals

Gate generali su tutte le card. Cambi di classificazione per aggirare il
requisito. Ranking aggiuntivi oltre `priorityAuto`. Avvio automatico della card
consigliata. Qualunque aumento di concorrenza.
