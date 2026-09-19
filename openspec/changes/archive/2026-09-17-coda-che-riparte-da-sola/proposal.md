# Proposal: coda-che-riparte-da-sola

> Approvata il 2026-09-17 (vedi `.openspec.yaml`): la scelta 1 e' la risposta del
> proprietario, data in chat.

## Da decidere

Il pavimento di memoria non ha uscita: se il minimo su 2 minuti sta sotto 6 GB
nessuna card parte, e su questa macchina non ci arriva mai.

1. Esenzione «prima card»: con `inFlight = 0` e `checkRuns = 0` si ammette UNA card.
   E' la valvola che l'asse budget ha gia' (`firstAgentExempt`) e che i check hanno
   gia' (`MEMORY_WAIT_MAX_MS`, 30 minuti e poi partono comunque). **Consigliata.**
2. Misurare il pavimento contro la RAM che Topics puo' restituire invece che contro
   l'assoluto della macchina.
3. Lasciare com'e' e aggiungere solo il parcheggio con notifica dopo N ore.

**Risposta: «se ti sembra una soluzione solida e pulita si»** — la 1.

## Why

Il pavimento nativo di 6 GB, su questa macchina, non e' un freno: e' un
interruttore. Misurato il 16-17/09 su 1455 righe `[memsig]` (25,7 ore di log):

- `held2m >= 6 GB`: **zero volte**.
- `avail` istantaneo sopra 6 GB: 11 volte su 1444 (0,76%), **mai due di fila** —
  e il pavimento pretende il minimo di 12-13 letture consecutive.
- Distribuzione di `held2m`: 2-3 GB 25 volte, 3-4 GB 467, 4-5 GB 836, 5-6 GB 71,
  sopra 6 GB nessuna.

Il risultato sulla board: sette card ferme fra 45 e 51 ore con `dispatch_state =
'queued'`, 314 commenti di sistema «Memoria quasi finita», e fra il 15/09 21:08 e
il 16/09 23:38 **una sola ripartenza**, avvenuta perche' una persona ha chiuso
delle applicazioni. La RAM non era di Topics: `inFlight = 0` e `checkRuns = 0` in
ogni campione, mentre `altri=` elencava Claude, claude-code e Spotify.

L'asimmetria e' interna al codice, non un'opinione. Gli altri due freni della
stessa famiglia hanno gia' un'uscita:

- `shared/machine-budget.ts:392` — `firstAgentExempt`: la prima card passa anche
  se il budget direbbe di no, «perche' una persona che usa il proprio Mac non e'
  un motivo per non lavorare mai».
- `server/services/review-checks-brakes.ts:78` — `MEMORY_WAIT_MAX_MS` = 30 minuti:
  il freno di memoria dei check aspetta, poi parte comunque e lo scrive.

Il pavimento delle ammissioni no: nessuna esenzione, nessun tetto di attesa,
nessun parcheggio. Ed e' valutato prima del budget (`task-dispatcher.ts:1240`),
quindi copre anche `resume()`, cioe' le card gia' al lavoro.

L'incidente che ha prodotto il pavimento (10/09: sette card ammesse insieme, Mac
inusabile, il proprietario ha fermato a mano) resta coperto: l'esenzione vale per
UNA card e solo quando Topics non sta facendo assolutamente niente.

## What Changes

- Il pavimento di memoria guadagna l'esenzione «prima card» quando nessun lavoro
  di Topics e' in volo.
- La finestra di 2 minuti del segnale di memoria sopravvive a un ricarico breve,
  invece di ripartire da zero a ogni salvataggio in `server/` (28 finestre
  azzerate in 25,7 ore, circa 56 minuti al giorno di blocco che non dipende dalla
  memoria).
- La frase di riscaldamento smette di rubare la chiave di dedup alla frase vera,
  cosi' la card dice perche' e' ferma.
- Gli orologi che dovrebbero reclamare una card ferma smettono di guardare
  colonne che il dispatcher stesso riscrive.
