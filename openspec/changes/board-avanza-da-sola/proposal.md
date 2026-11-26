# La board avanza da sola

## Perché
La board si fermava in sette punti ricorrenti e a ripartirla era un cron esterno o una persona: card vista senza foto, card pronta ma tenuta per una domanda che non è di nessuno, doppioni, card ferme da ore senza motivo scritto, lavoro rilanciato a vuoto, domande che non tornano dove sono nate, correzioni unite ma non in servizio. Ogni regola deve stare nel server, deterministica, con un test che diventa rosso se la si toglie.

## Cosa cambia
- **T1 auto-land**: solo una domanda che spetta a una persona (testo, spesa, pubblico, dati veri, irreversibile) tiene ferma la consegna. Il resto atterra da solo.
- **T2 card senza foto**: una card visibile che non può produrre l'anteprima viene instradata su questa macchina e resta in todo, mai in backlog.
- **T3 niente doppioni**: titolo identico (normalizzato) o stessa chiave di idempotenza di una card aperta della stessa board dà 200 `{deduped:true, id}` e un commento di servizio sulla card esistente. Similarità parziale: resta il 409.
- **T4 sblocco**: card in todo o in corso da oltre 60 minuti senza motivo leggibile riceve una nota col motivo calcolato; se la macchina assegnata non risponde torna in coda su un'altra.
- **T5 giri a vuoto**: budget di tentativi finito senza esito = la card esce dalla coda con il motivo scritto e resta in todo (visibile), non in backlog.
- **T6 decisioni nel canale giusto**: la domanda che una consegna porta alla persona viaggia nel messaggio che sveglia la chat di origine, canale compreso.
- **T7 riavvii**: nessun codice. Una correzione unita che tocca il server va in servizio da sola; documentato e provato.

## Barra
Ogni traccia ha il suo test (`specs/acceptance.md`) e una mutazione verificata a mano: tolta la cura il test è rosso, ripristinata è verde. Resta verde ciò che era verde: `bun run test:touched`, typecheck, lint, deadcode, emdash, comment-language, identifier-language.

## Fuori
- Nessun cron esterno nuovo, nessun cambio di versione.
- Il tetto di tentativi resta quello configurato per board (default 2): T5 cambia dove finisce la card, non quanti giri ha.
- La similarità parziale tra titoli non diventa mai un assorbimento automatico.
- Nessun nuovo canale di notifica: T6 usa il risveglio della chat di origine che esiste già.

## Deciso da me
- Il confronto per T3 è sul titolo normalizzato (`normalizeTaskText`), non sul punteggio di somiglianza: un'azione automatica vuole una regola esatta.
- L'assorbimento vale per le card di primo livello e non per i passi di una checklist, che si ripetono per costruzione.
- La nota di T4 apre sempre con la stessa frase, che fa da marcatore: una nota per card, anche dopo un riavvio.
- T5 riusa il chip `failed` e non introduce uno stato nuovo.

## Non ancora specificato
- Una soglia diversa da 60 minuti per le card in corso con agente vivo (oggi quelle non contano come ferme).
