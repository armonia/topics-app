# Change: project-identity-canonical

## Why

L'identità di un progetto è la STRINGA del suo percorso: `projectIdForPath` è
`basename + hash(stringa)` (`shared/board.ts:65`) e le chiavi `ui_state` usano un hash
gemello (`shared/project-keys.ts`). Quindi due strade per la stessa cartella fanno due
progetti: due voci in sidebar, due board, due pannelli.

Successo il 02/09/2026: `~/.openclaw/workspace/neuture-proposal` è un symlink a
`~/Projects/neuture-proposal`, e neuture compariva contemporaneamente fra i fissati e
fra le tab. Non è un caso isolato — misurato sul DB di produzione, i percorsi salvati
che si sdoppiano sono **quattro**: due da symlink (neuture, foto-reference) e due da
differenza di MAIUSCOLE (`Projects/AcquaPub` e `Projects/Panea`, che su un filesystem
case-insensitive sono la stessa cartella con due nomi).

## What changes

`canonicalProjectPath()`: espande `~`, toglie la barra finale, risolve i link con
`realpath`. Un percorso che non esiste ancora si tiene com'è — non c'è niente da
risolvere, e rifiutarlo trasformerebbe «cartella non ancora creata» in un errore.

Applicata dove un percorso ENTRA e viene memorizzato: creazione di un topic, PATCH del
suo `projectPath`, e `resolveProjectRef` (il `/project`, l'adozione). Non altrove: il
resto del codice legge percorsi già canonici.

Per ciò che è già scritto, `scripts/canonicalizza-progetti.ts`: in **prova** per
default, elenca vecchio e nuovo id con quanti topic, righe `tasks` e chiavi `ui_state`
si sposterebbero; con `--esegui` riscrive tutto in una transazione sola.

## Perché una migrazione separata e non una riscrittura al volo

Cambiare il percorso di un progetto esistente ne cambia l'id, e le righe `tasks` già
scritte restano sotto un id che nessuna board legge più: è la «board vuota» già pagata
il 18/08. Quindi il codice **non tocca niente di esistente** — impedisce solo che nasca
la seconda identità — e la fusione di ciò che esiste è un'operazione esplicita, che si
legge prima di eseguirla.

## Out of scope

- Cambiare `projectIdForPath` o `projectHash`: ogni modifica orfanerebbe ogni riga già
  scritta. L'identità resta l'hash della stringa; è la stringa a diventare canonica.
- I percorsi dentro `tasks`/worktree non legati a un topic: la migrazione parte da
  `topics.project_path`, che è la fonte da cui board e pannelli nascono.

## Impact

- **Server**: `lib/canonical-project-path.ts` (nuovo), `routes/topics.ts` (3 punti).
- **Script**: `scripts/canonicalizza-progetti.ts` (nuovo, prova per default).
- **DB**: nessuna migration automatica. La fusione si lancia a mano.
- **Test**: 5 unità sul canonico + 2 sulla rotta di creazione.
