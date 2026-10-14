# D5 · Sessioni e board: quello che gli altri hanno e a noi manca

Regole comuni: `tracks/_comuni.md`. Indipendente dalle tracce di velocità.

**GOAL.** Chi passa da Claude Code, Conductor o Vibe Kanban a Topics non trova un passo indietro nel
ciclo «lancio un agente, guardo il diff, lo correggo, lo porto su main».

## Cosa c'è già (verificato nel codice il 14/10)

- **Nella chat:** checkpoint con timeline (`CheckpointTimeline.tsx`), coda dei messaggi durante il
  turno, goal persistente (`GoalBar.tsx`), costi per progetto (`ProjectUsagePanel.tsx`),
  `AutonomyPicker` per l'autonomia.
- **Notifiche e telefono:** notifiche e abbinamento dei dispositivi (`PairingApproval.tsx`).
- **Sulla board:** automerge (`server/services/task-automerge.ts`) e raccolta delle worktree
  (`server/services/worktree-gc.ts`).

## Cosa manca, e chi lo fa

Le fonti sono i dossier in `docs/competitors/`.

1. **Commenti sul diff mandati all'agente.**
   - Si selezionano righe nel diff, si scrive il commento, e i commenti partono insieme come un
     messaggio con file e riga.
   - Lo fanno Vibe Kanban, Conductor e l'app di Codex. In Topics non c'è (`git grep` di
     `diffComment`, `lineComment` e `reviewComment`: 0 file).
2. **Worktree pronte all'uso.**
   - Alla creazione si copiano i file non tracciati che servono (`.env` e simili), come fa
     `.worktreeinclude` in Claude Code.
   - Per progetto ci sono tre script: setup, run e archive (Conductor).
   - Porte deterministiche per worktree (Conductor e Agor): oggi c'è solo un'assegnazione parziale
     in `server/services/preview-manager.ts`.
3. **Controlli prima del land.**
   - Lo stato della CI della PR si vede sulla card ed è una condizione del land.
   - Una CI rossa riapre la card con il log del job fallito, come i Checks di Conductor e il
     monitoraggio delle PR di Claude Code.
4. **Domanda a lato.**
   - Una domanda sulla sessione corrente che non entra nel filo principale (`/btw` in Claude Code).
   - In Topics non c'è.
5. **Sbirciata.** Lo stato e un riassunto di una sessione dalla board, senza aprirla, come la vista
   agenti di Claude Code. Questo va verificato: `peek` compare in 18 file e potrebbe esserci già.
6. **Card a calendario.**
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
| Commenti sul diff | Tre commenti su due file. L'agente riceve un messaggio solo, con i tre riferimenti, e risponde modificando quelle righe. |
| Worktree pronte | Un progetto con `.worktreeinclude` e lo script di setup. La card nuova trova `.env` copiato e il setup eseguito. Due card hanno porte diverse e stabili fra un riavvio e l'altro. |
| Controlli | Una PR con la CI rossa: il land è bloccato con il motivo. La card riapre con il log; la CI torna verde e il land passa. |
| Domanda a lato | La risposta compare a lato. Il transcript principale non cambia: stesso numero di messaggi prima e dopo. |
| Card a calendario | Con l'orologio finto, «ogni lunedì alle 9» crea una card al tick giusto. Una seconda si salta, perché la prima è aperta. Dopo un salto di tre settimane se ne recupera una sola. |

**Mutazione sul punto critico.** In una copia si toglie la condizione della CI dal land: lo scenario
dei controlli deve fallire.

## Fuori

- Rifare la board o la chat.
- Copiare l'interfaccia di un concorrente: si prende il comportamento, non il disegno.
