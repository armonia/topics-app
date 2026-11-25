# Lavoro in corso: un solo stato, su ogni superficie, col numero degli agenti

## Da decidere
Niente: le scelte sono tecniche, le ha prese l'agente (sotto, «Deciso da me»).

## Perché
Attilio, 23/11: «i topics non gestiscono bene quando finiscono, o quando sono in attesa di domande, e a volte restano appesi in loading. [...] vedo in attesa in task, ma sia il suo sottoagente sia la sua tab dovrebbero essere in loading essendoci un agente, anche con il numero».

Misurato dal vivo lo stesso giorno (`attention:init` contro `/api/topics/streaming` e `/api/live-work`):
- **10 chat con il turno aperto non avevano nessuna riga** nello stato di attenzione del server, fra cui una ferma su una domanda (`waiting` nel poll): per il server era `idle`, quindi niente ambra, niente «finita», niente avviso. Il client le mostrava al lavoro solo grazie ai suoi flag locali di stream.
- **Un sottoagente in `awaiting` con tre figli al lavoro** («Zeno fase 1») era un orologio nella striscia del padre, la sua tab suonava il movimento lento di «attesa», e la riga del padre diceva «Aspetta un sottoagente». Da nessuna parte c'era il numero degli agenti che lavoravano.
- Una chat ferma su una domanda contava due volte nel menu degli agenti: «al lavoro» e «ti aspetta».

## Cosa cambia
- **Il lavoro che gira è lavoro** (ATTN-02, già scritto): una chat che aspetta i suoi sottoagenti, un processo o un compito della CLI ha lo stesso loader di un turno, col movimento di ciò che gira (`delegate`, `run`); il movimento lento `wait` resta solo per ciò che aspetta la persona.
- **Il numero degli agenti al lavoro** sotto una chat, a qualunque profondità (`agentsAtWorkUnder`, una funzione pura in `shared/live-work.ts`), sta nello slot della sua tab (l'anello attorno al numero, nell'inchiostro del loader; il numero di ciò che chiede a te vince), nella riga della sidebar («2 sottoagenti al lavoro»), nell'intestazione della fisarmonica dei sottoagenti e nella riga della striscia del figlio che aspetta.
- **Un figlio `awaiting` con lavoro visibile sotto** (agenti al lavoro, o un comando suo) è disegnato al lavoro (`shownChildState`); senza niente che giri resta l'orologio (SUBAGENT-16, 18/11).
- **Una domanda aperta conta una volta**, fra chi ti aspetta.
- **Il server sa di ogni turno aperto e di ogni domanda** (ATTN-17): `dispatched` viaggia solo sui turni che la board manda per le sue card. Prima lo portava ogni turno riadottato dopo una ricarica del server (ogni pochi minuti) e la sveglia dell'esito di una card, e lo stato di attenzione teneva quelle chat `idle`: niente ambra su una domanda, niente «finita».

## Barra
`specs/acceptance.md`.

## Fuori
- Ridisegnare lo slot o il loader (geometria TABSLOT-02 invariata).
- Il numero degli agenti sulla tab di progetto e sulla card della board (la card ha già il conto dei figli, `TaskChildrenChip`).
- Le regole di quando un sottoagente si accende (SUBAGENT-21) e si archivia (SUBAGENT-22).

## Deciso da me
- Il numero conta i discendenti col turno aperto, non chi aspetta: una catena di tre che finisce in un agente al lavoro dice 1.
- Un figlio `awaiting` si giudica dall'albero e dai suoi comandi, non dal compito `subagent` della sua mappa, che resta finché un figlio deve solo consegnare un risultato.
- Nello slot vince il numero di ciò che chiede a te; quello degli agenti scende nel tooltip.
- La sveglia dell'esito di una card ha un segno suo (`cardOutcome`) invece di `dispatched`: la riga resta «non scritta da te» e non chiude le tue domande aperte, ma il turno è della chat.
- La chat di un agente di board resta al lavoro finché lavorano i suoi sottoagenti (`useTopicAtWork`), anche se per lo stato di attenzione è della card.

## Non ancora specificato
- Se il numero degli agenti debba salire anche sulla tab di progetto: oggi la sua barra lo mostra già per figlio.
