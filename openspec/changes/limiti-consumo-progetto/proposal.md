# Consumo per progetto: conto giusto, avviso sul telefono, freno al budget

## Da decidere
Niente: nessuna spesa, nessun dato che esce oltre a una riga di testo verso il canale che il proprietario configura. I valori di partenza (soglia d'avviso 15%, budget solo dove è già scritto) li decide l'agente e si cambiano dal menu del progetto.

## Perché
Il 17/11 un account Claude è passato da 0 a 90% della settimana in nove ore e nessuno se n'è accorto. I tre pezzi che dovevano dirlo erano rotti:
- **il conto per progetto sbagliava**: l'hook di riserva divideva i token dei soli transcript di Claude Code (mai il motore nativo, che fa l'80% del consumo) per il totale di tutti gli account, e la nuvola risultava al 2,6% nelle 24 ore. Il registro del proxy attribuisce le richieste per finestra di tempo alla sessione aperta, quindi il traffico del motore nativo finisce su quadra o cloud-sim (77% e 18% secondo il proxy, contro 14% e 4% veri);
- **l'avviso finiva nel diario dell'hub**, che nessuno apre (tolto da WhatsApp il 24/10 perché avvisava 25 volte a settimana sul ritmo);
- **il freno esiste solo per un progetto** (Prince of Persia, `quota-guard.py`, fuori da Topics).

Misura del 17/11 14:54-24:00 (89 punti, 100 = un account per una settimana), salita oraria della quota divisa sulle chiamate di quell'ora per peso: jarvis 20, pixel-console 15, zenocms 14,5, quadra 14, topics-app 12, .openclaw 5, cloud-sim 4,4. I sottoagenti `spawn_agent` fanno 380 dei 479 milioni di token pesati del motore nativo.

## Stato dell'arte
Il conto è quello di USAGE-27 (chi ha speso la quota, per persona): stessa salita oraria, stesso peso (input + 5·output + 1,25·scrittura cache + 0,1·lettura cache), raggruppato per progetto invece che per persona. LiteLLM e Helicone fanno budget per chiave o per tag con soglia d'avviso e blocco alla soglia; qui il «tag» è la cartella del progetto, il blocco è il freno già scritto in `task-dispatcher-spend-cap.ts` («freno, non taglio»).

## Cosa cambia
- **Il conto** (`server/usage/project-quota.ts`): ogni chiamata del motore nativo, dei sottoagenti, dei transcript di Claude Code nella cartella dei progetti (anche le sessioni aperte fuori da Topics) e di `usage_records` va al progetto della sua cartella (worktree → suo progetto). Punti nelle ultime 24 ore e negli ultimi 7 giorni. `GET /api/usage/projects/quota`.
- **Le soglie** si scrivono in Topics (tabella sua), dal menu del progetto che oggi scrive il budget all'hub: budget della settimana (nessuno di default) e soglia d'avviso nelle 24 ore (15% di default, per tutti). Un budget che l'hub ha e Topics no si importa una volta.
- **L'avviso** è una riga nella campanella, una spinta, e il comando d'avviso del proprietario se configurato (`TOPICS_OWNER_ALERT_COMMAND`, argv in JSON, testo su stdin; vuoto = nessun invio). Una volta al giorno per progetto e soglia (24 ore, 80% del budget, budget pieno). Su questa macchina il comando è `jarvis-channels send-to whatsapp <chat principale>`, nell'ambiente del server, non nel codice.
- **Il freno** a budget pieno: le card del progetto aspettano in Todo con il motivo, `spawn_agent` non fa nascere figli nuovi e la spinta d'obiettivo tace; il messaggio di una persona passa sempre e il turno in corso finisce. «Togli il freno» dal menu lo toglie fino a mezzanotte.

## Barra
`bun test server/usage/project-quota.test.ts server/services/project-budget-brake.test.ts` esce 0; lo scenario e2e con video esce 0; il conto rifatto sul DB vero del 17/11 dà i numeri sopra ±1; con la divisione oraria tolta il test del conto è rosso. Dettaglio in `specs/acceptance.md`.

## Fuori
Fermare le sessioni fuori da Topics (app desktop, terminali): si contano e si avvisano, non si frenano. Codex e Muse (unità diverse, non sommabili alla settimana Claude). Toccare l'hub o `quota-guard.py`. Un avviso sul ritmo degli account (c'è già nell'hub).

## Non ancora specificato
Se il freno debba scegliere da solo un modello più leggero per le chat sopra budget invece di dirlo all'agente: non so ancora formulare quale modello basti per quale lavoro.
