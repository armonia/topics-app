> **Stato (2026-11-20):** manca tutto il codice: `server/usage/project-quota.ts`, `server/services/project-pause.ts`, `scripts/project-quota-check.ts` e la migrazione `project_quota` non esistono, e nessun test li copre (USAGE-28, USAGE-29, USAGE-30 senza `@covers`).

# Consumo per progetto: conto giusto, limite di default e conferma sincronizzata

## Due consegne
Il lavoro si consegna in due pezzi, perché il conto va misurato prima di frenare qualcosa con esso:
1. **Conto e misuratore, senza nessuna pausa** (questa consegna, USAGE-28 e la parte «limite» di USAGE-29). Il conto per progetto giusto (transcript annidati, peso per modello, card che restano sul loro progetto, cartelle sotto un solo nome, chiamate singole sul progetto della loro chat), la divisione per superficie, la tabella `project_quota` col limite (default 10 punti nelle 24 ore, selettore nel menu del progetto), il misuratore «punti/limite» sulla riga del progetto e nella Dashboard. Niente stato di pausa, niente tasto, niente avviso.
2. **Freno, pausa che si chiude, conferma** (consegna successiva: USAGE-29 per la parte pausa, USAGE-30). Il dispatcher e `spawn_agent` che si fermano sopra il limite, «Continua» e «Pausa fino a domani» sincronizzati, l'avviso fuori dall'app. Parte da ciò che è già scritto sul ramo `topics/tidy-totem` (`project-pause*.ts`, `project-quota-sweep.ts`, rotte `quota/continue` e `quota/hold`) e riusa il limite e il conto di questa consegna.

La migrazione `project_quota` porta già le colonne della pausa (`paused_at`, `continued_until_pct`, `hold_until`): in questa consegna restano vuote e nessun codice le legge.

## Da decidere
Niente: deciso da Attilio il 18/11 alle 01:22 («fai 10% a progetto. poi l'ok ad andare avanti dovrebbe essere sincronizzato e sbloccare tutto del progetto»). Nessuna spesa, nessun dato che esce oltre a una riga verso il canale che il proprietario configura.

## Perché
Il 17/11 un account Claude è passato da 0 a 90% della settimana in nove ore e nessuno se n'è accorto. I tre pezzi che dovevano dirlo erano rotti:
- **il conto per progetto sbagliava**: l'hook di riserva divideva i token dei soli transcript di Claude Code (mai il motore nativo, che fa l'80% del consumo) per il totale di tutti gli account, e la nuvola risultava al 2,6% nelle 24 ore. Il registro del proxy attribuisce le richieste per finestra di tempo alla sessione aperta, quindi il traffico del motore nativo finisce su quadra o cloud-sim (77% e 18% secondo il proxy, contro 14% e 4% veri);
- **l'avviso finiva nel diario dell'hub**, che nessuno apre (tolto da WhatsApp il 24/10 perché avvisava 25 volte a settimana sul ritmo);
- **il freno esiste solo per un progetto** (Prince of Persia, `quota-guard.py`, fuori da Topics).

Misura del 17/11 14:54-24:00 (89 punti, 100 = un account per una settimana), salita oraria della quota divisa sulle chiamate di quell'ora per peso: jarvis 20, pixel-console 15, zenocms 14,5, quadra 14, topics-app 12, un progetto di gateway 5, cloud-sim 4,4. I sottoagenti `spawn_agent` fanno 380 dei 479 milioni di token pesati del motore nativo.

## Stato dell'arte
Il conto è quello di USAGE-27 (chi ha speso la quota, per persona): stessa salita oraria, stesso peso (input + 5·output + 1,25·scrittura cache + 0,1·lettura cache), raggruppato per progetto invece che per persona. LiteLLM e Helicone fanno budget per chiave o per tag con soglia d'avviso e blocco alla soglia; qui il «tag» è la cartella del progetto, il blocco è il freno già scritto in `task-dispatcher-spend-cap.ts` («freno, non taglio»).

## Cosa cambia
- **Il conto** (`server/usage/project-quota.ts`): ogni chiamata del motore nativo, dei sottoagenti, dei transcript di Claude Code nella cartella dei progetti (anche le sessioni aperte fuori da Topics) e di `usage_records` va al progetto della sua cartella (worktree → suo progetto). Punti nelle ultime 24 ore e negli ultimi 7 giorni. `GET /api/usage/projects/quota`.
- **Limite di default: 10 punti nelle 24 ore per ogni progetto**, senza configurare niente; dal menu del progetto si cambia o si toglie.
- **Sopra il limite il progetto va in pausa**: le card aspettano in Todo col motivo, `spawn_agent` non fa nascere figli, la spinta d'obiettivo tace. Il messaggio di una persona passa sempre (la conferma che bloccava i messaggi, tolta il 30/10 dopo 43 messaggi fermati, non torna) e il turno in corso finisce.
- **Una conferma sola, sincronizzata**: la pausa è uno stato del server per progetto, mostrato in ogni chat del progetto, sulla board, nella campanella, in una spinta e su WhatsApp. «Continua» premuto in un posto qualsiasi sblocca tutto il progetto ovunque, per altri 10 punti; «Pausa fino a domani» la tiene fino a mezzanotte.
- **Fuori dall'app**: `TOPICS_OWNER_ALERT_COMMAND` (argv in JSON, testo su stdin; vuoto = nessun invio), una volta per pausa. Su questa macchina è `jarvis-channels send-to whatsapp <chat principale>`, nell'ambiente del server, non nel codice.

## Barra
`bun test server/usage/project-quota.test.ts server/services/project-pause.test.ts server/services/project-pause-alerts.test.ts` esce 0; lo scenario e2e a due finestre con video esce 0; il conto rifatto sul DB vero del 17/11 dà i numeri sopra ±1; con la divisione oraria tolta il test del conto è rosso. Dettaglio in `specs/acceptance.md`.

## Fuori
Fermare le sessioni fuori da Topics (app desktop, terminali): si contano e si avvisano, non si frenano. Codex e Muse (unità diverse, non sommabili alla settimana Claude). Toccare l'hub o `quota-guard.py`. Un avviso sul ritmo degli account (c'è già nell'hub).

## Non ancora specificato
Se il freno debba scegliere da solo un modello più leggero per le chat sopra budget invece di dirlo all'agente: non so ancora formulare quale modello basti per quale lavoro.
