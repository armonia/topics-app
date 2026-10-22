# T10 - Tre agenti sulla stessa card

**GOAL.** Una card di gusto si puo' correre con N tentativi in parallelo, i diff
si confrontano affiancati, e la scelta diventa la consegna.

## Perche' ora

Oggi un task vale un agente: se il tentativo torna sbagliato, la card si
ri-dispaccia intera. Sul lavoro di gusto (UI, copy, forma di un'animazione) una
sola esecuzione **torna sbagliata spesso**, e il costo di un giro perso non e'
teorico: lo sweep dello stato dell'arte lo mette fra le cose che i concorrenti
hanno risolto, e Cursor ha un comando dedicato.

E' la cosa col miglior rapporto valore/costo del confronto esterno, perche' non
introduce nessuna tecnologia nuova: N worktree sulla stessa card esistono gia',
i tentativi sono gia' modellati dal dispatcher, e `isolation: worktree` e' gia'
un campo.

## Cosa cambia

1. Un campo sulla card: quanti tentativi in parallelo, con un tetto.
2. N worktree, un tentativo per worktree, tutti sulla stessa base.
3. Una vista di confronto dei diff affiancati nel drawer della card.
4. La scelta diventa `deliveryCommit`; le altre worktree si chiudono senza
   residui.
5. Il budget di T8 governa quanti tentativi partono davvero: tre tentativi su
   questa macchina senza budget sono tre volte il problema di T8.

## Barra

- Lo scenario 4 di `specs/acceptance.md`, con video: tre tentativi, i diff
  affiancati, la scelta che diventa la consegna, le altre due worktree chiuse.
- `git worktree list` dopo la scelta non mostra residui.
- Mutazione: scegliere un tentativo il cui ramo non esiste piu' deve essere
  rifiutato, non registrato.

## Fuori

Un giudice automatico che scelga al posto della persona. La scelta sul gusto e'
di chi guarda; lo scorer di T11 verifica la **consegna**, non la decide.
