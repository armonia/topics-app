# T1 - Il cancello d'origine

**GOAL.** Una pagina che non e' l'app non supera l'asse d'origine
sull'ascoltatore primario, ne' per una scrittura ne' per un upgrade WebSocket.

## Perche' i dettagli non sono qui

Il repository e' pubblico, e questi due problemi sono **aperti**. Descrivere un
problema aperto vuol dire spiegare a chiunque come usarlo prima che sia
corretto: e' la stessa regola che si e' dato `D8` di `daily-driver`, dove le
descrizioni sono arrivate nel repo solo dopo la correzione in produzione.

Finche' sono aperti, la riproduzione, le righe esatte e le prove dal vivo stanno
in una nota privata del proprietario. Qui resta quanto basta a lavorarci.

## La classe del problema

L'asse d'origine di `server/lib/auth-gate.ts` e' piu' largo di quanto il
prodotto richieda, su due fronti indipendenti:

1. **La granularita' del confronto same-site** non distingue tutto cio' che il
   browser considera un'origine diversa. Il comportamento e' voluto e fissato da
   un test, scritto quando le superfici erano altre; il raggio e' cresciuto da
   allora, e su questa macchina cresce ogni giorno.
2. **Un elenco di origini aggiuntive**, nato per una superficie precisa, vale
   invece su **ogni** ascoltatore, compreso quello locale dove il peer loopback
   vale come proprietario senza credenziali.

In entrambi i casi il premio non e' una lettura: e' l'upgrade WebSocket del
terminale, dove l'Origin e' l'unica difesa.

Non verificato: quanto Local Network Access nei browser reali riduca la
probabilita'. Riduce la probabilita', non la falla.

## Cosa cambia

1. Il confronto same-site diventa esatto su tutto cio' che distingue un'origine,
   contro un insieme **chiuso** di valori attesi, con le esenzioni per schema
   che il guscio richiede.
2. L'elenco delle origini aggiuntive si applica solo alle richieste arrivate
   dall'ascoltatore per cui e' nato. `isViaTunnel(req)` esiste gia'.
3. Il test che fissa il comportamento vecchio si riscrive per documentare il
   contratto nuovo.
4. Lato relay: un'origine per tenant, cosi' che due installazioni non ne
   condividano una. Non una CSP sandbox, che non basta.

## Barra

Ogni correzione ha il suo test, **visto rosso su main prima** della correzione.

- I casi del cancello d'origine in `auth-gate.test.ts`: le origini che oggi
  passano devono dare 403, e quelle che il guscio e il dev loop richiedono
  devono restare allow.
- Le due sonde dal vivo della nota privata tornano 403.
- `bun run check:security` esce 0.
- Mutazione: riallargare il confronto fa fallire il test della granularita'.

## Quando si apre

A correzione in produzione, questa traccia si riscrive al livello di un avviso
di sicurezza: cosa poteva succedere, a quali condizioni, come e' chiusa e quale
test la tiene chiusa. Come ha fatto D8.

## Fuori

Togliere il loopback-come-proprietario: e' una scelta dichiarata del progetto, e
non e' questa la traccia che la rimette in discussione.
