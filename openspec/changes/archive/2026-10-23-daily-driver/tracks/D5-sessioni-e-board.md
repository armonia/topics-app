# D5 · Sessioni e board: quello che gli altri hanno e a noi manca

Regole comuni: `tracks/_comuni.md`. Indipendente dalle tracce di velocità.

**GOAL.** Chi passa da Claude Code, Conductor o Vibe Kanban a Topics non trova un passo indietro nel
ciclo «lancio un agente, guardo il diff, lo correggo, lo porto su main».

## Cosa c'è già (verificato nel codice il 14/10, corretto il 15/10)

- **Nella chat:** checkpoint con timeline (`CheckpointTimeline.tsx`), coda dei messaggi durante il
  turno, goal persistente (`GoalBar.tsx`), costi per progetto (`ProjectUsagePanel.tsx`),
  `AutonomyPicker` per l'autonomia.
- **Notifiche e telefono:** notifiche e abbinamento dei dispositivi (`PairingApproval.tsx`).
- **Sulla board:** automerge (`server/services/task-automerge.ts`) e raccolta delle worktree
  (`server/services/worktree-gc.ts`).
- **D5a, note di revisione sul diff (c'erano già).** Sul diff della consegna di una card ogni riga
  prende una nota. Le note restano in sospeso e partono insieme verso l'agente, come un solo
  commento con file e numero di riga: `UnifiedDiff` in modalità `review`, `reviewNotes.ts`. Test:
  `reviewNotes.test.ts`, `UnifiedDiff.test.tsx`. Il 14/10 questo piano le dava per mancanti perché
  le aveva cercate come `diffComment`, `lineComment` e `reviewComment`.
- **D5c, la CI prima della review (c'era già).** I controlli pre-review della board comprendono gli
  esiti della CI della PR: `github-ci:unit` e `github-ci:e2e` in `shared/board.ts`, eseguiti da
  `server/services/review-checks.ts`. Una CI rossa ferma la consegna, e la card torna all'agente
  con il dettaglio del check. Il land resta un passo umano dopo la review. Test:
  `tasks.checks-ci.test.ts`, `review-checks.test.ts`.

## Cosa manca, e chi lo fa

Le fonti sono i dossier in `docs/competitors/`.

1. **D5b, worktree pronte all'uso.**
   - Alla creazione si copiano i file non tracciati che servono (`.env` e simili), come fa
     `.worktreeinclude` in Claude Code.
   - Per progetto ci sono tre script: setup, run e archive (Conductor).
   - Porte deterministiche per worktree (Conductor e Agor): oggi c'è solo un'assegnazione parziale
     in `server/services/preview-manager.ts`.
2. **D5d, domanda a lato.**
   - Una domanda sulla sessione corrente che non entra nel filo principale (`/btw` in Claude Code).
   - In Topics non c'è.
3. **D5e, sbirciata.** Lo stato e un riassunto di una sessione dalla board, senza aprirla, come la
   vista agenti di Claude Code. Verificato il 15/10: non c'è. Nel codice `peek` è solo la sonda del
   broker (`peekSessions` in `server/lib/ai-bridge-client.ts`).
4. **D5f, card a calendario.**
   - È la funzione che più concorrenti hanno e Topics no: 17 su 31, fra cui l'app di Claude Code
     (Routines, task pianificati, `/loop`), l'app di Codex, Superset e Agor.
   - Una card ricorrente (cron o RRULE, nel fuso dell'utente) crea la sua istanza all'ora giusta.
   - Se l'istanza precedente è ancora aperta, la nuova si salta, con il motivo scritto.
   - Dopo uno spegnimento si recupera al massimo un'istanza persa, non tutte.
   - Oggi in `server/` non c'è nessuno scheduler: le ricorrenze del proprietario girano fuori da
     Topics.

## Barra

Ogni funzione ha il suo scenario spec-flow con il video:

| Funzione | Scenario |
|---|---|
| Worktree pronte | Un progetto con `.worktreeinclude` e lo script di setup. La card nuova trova `.env` copiato e il setup eseguito. Due card hanno porte diverse e stabili fra un riavvio e l'altro. |
| Domanda a lato | La risposta compare a lato. Il transcript principale non cambia: stesso numero di messaggi prima e dopo. |
| Sbirciata | Dalla board, senza aprire la sessione, si leggono stato e riassunto di una card in lavorazione. |
| Card a calendario | Con l'orologio finto, «ogni lunedì alle 9» crea una card al tick giusto. Una seconda si salta, perché la prima è aperta. Dopo un salto di tre settimane se ne recupera una sola. |

**Mutazione sul punto critico**, una per funzione, nel suo ambito. Per le card a calendario: in una
copia si toglie la condizione «precedente ancora aperta», e il test del salto deve fallire.

## Fuori

- Rifare la board o la chat.
- Copiare l'interfaccia di un concorrente: si prende il comportamento, non il disegno.
