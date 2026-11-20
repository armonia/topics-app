# Proposal: chat-live-work

## Why

Attilio, 07/10, sulla chat Remake Prince of Persia (`topic:d740f8ae`): «c'è un sacco di agenti in
orizzontale messi là che sono i sottagenti vecchi... Serve soltanto vedere bene i sottagenti attuali,
eventualmente anche con la possibilità di avere un'anteprima live... dei server locali e degli agenti
in background, fatta per bene, eventualmente apribile... l'unica funzione da aprire apre il terminale,
ma resta in waiting for output».

Misure del 07/10 alle 21:30:

- La chat ha 16 sotto-agenti, tutti finiti il 04/10 (tabella `subagents`: 12 `stopped`, 4 `retired`).
  La striscia (`client/src/components/Chat/SubAgentsStrip.tsx`) tiene ogni riga finita finché qualcuno
  non preme la X (`client/src/state/endedSubAgents.ts`, fino a 50), e legge solo il roster dei
  terminali: un figlio nativo non ci entra mai (task 11 di `subagent-nativi`, ancora aperto).
- Chi lavora davvero sono due comandi `run_command` della chat: Muse su wallrun-v (da 58 minuti, 6
  commit) e il server delle clip su :8781 (`/api/processes?topicId=…`). In chat non si vedono.
- Il log di Muse è vuoto: `/api/scripts/4ab76e36…/output` risponde `output: ""` dopo 58 minuti,
  perché il comando stesso manda tutto in un file (`freeagent … > /tmp/fa-wallrunv2.log`). Il
  pannello (`ProcessLogPane.tsx`) resta su «Waiting for output...» per sempre. Il log del server
  delle clip invece si vede.

## What Changes

1. **La striscia mostra ciò che lavora adesso.** Una riga per ogni cosa viva della chat: i sotto-agenti
   al lavoro o in attesa, nativi e CLI, e i comandi `run_command` in corso della sessione. Un
   sotto-agente finito resta 60 s con la spunta, poi esce: il suo esito è già nella card in chat.
   Nessuna riga, nessuna striscia.
2. **Anteprima dal vivo, una riga.** Per un comando, l'ultima riga di output. Per un sotto-agente,
   l'ultima attività. Per un server locale, anche la porta. Si aggiorna sugli eventi WS che esistono
   già (`scripts:output`, `scripts:updated`, stato dei sotto-agenti), senza un polling per riga.
3. **Si apre.** Clic su un comando: il suo log dal vivo. Clic su un sotto-agente: la sua chat o il suo
   terminale. Un server con porta ha anche «apri» sull'indirizzo.
4. **L'output rediretto si vede.** Se il comando manda il suo stdout in un file che nomina lui
   (`> f`, `>> f`, `&> f`, `> f 2>&1`, `| tee f`), il log del comando segue anche quel file, con lo
   stesso tetto e la stessa ripresa dopo un riavvio (CMDRUN-03). La descrizione di `run_command`
   dice agli agenti che l'output è già catturato. Il pannello vuoto dice cosa aspetta e da quando.

## Barra

`specs/acceptance.md`: unit test, scenario Playwright con video contro il server isolato :13334,
due mutazioni che lo fanno fallire, e le suite che toccano questi file restano verdi.

## Fuori

Storico dei sotto-agenti vecchi (resta nelle card della chat e nell'albero laterale) · board ·
figli Codex · terminali che non sono di un agente · layout mobile, oltre a non romperlo.

## Deciso da me

- Una riga finita esce dopo 60 s, senza contatore «N finiti»: Attilio ha detto che i vecchi non
  servono. I 60 s evitano che una riga sparisca sotto gli occhi, il difetto per cui
  `endedSubAgents` era nato.
- Si segue solo un file che il comando nomina nella redirezione, risolto sulla sua cartella di
  lavoro. Nessuna ricerca di file, nessuna variabile espansa: un percorso con `$VAR` resta non
  seguito, e il pannello lo dice.
- Anteprima di una riga sola: di più diventa una seconda chat dentro la chat.
- La riga del lavoro in background resta, per il lavoro della CLI (un Bash in background, un
  Monitor, un Agent), che la striscia non elenca; non nomina più i comandi. Tolta tutta, quel
  lavoro sparirebbe dallo schermo.
