# Change: relay

## Why

La condivisione con una persona o un team, costruita in `sharing-orgs`, oggi
funziona solo se quella persona è **sulla tua rete**. Per un singolo va bene —
è già sulla sua macchina. Per un team no: un collega non è sulla tua LAN quasi
mai, quindi la funzione che deve giustificare il piano a pagamento è proprio
quella che non si può usare.

Il tunnel che esiste (`TOPICS_TUNNEL_PORT`, `docs/tunnel.md`) **non è la strada
del prodotto**: richiede un account Cloudflare, un dominio e `cloudflared` a
mano. È la strada del self-host, e resta.

**E soprattutto: nessun prodotto di questa categoria espone un tunnel.** Omnara
si descrive come *local-first relay* — il codice resta sulla tua macchina, loro
sono relay, dashboard e notifiche. Il Remote Control di Anthropic è ancora più
esplicito: il processo locale **apre una connessione HTTPS in uscita** e registra
la sessione, *senza aprire nessuna porta in ascolto*. La parola «tunnel» non
compare mai, e non per pudore: non c'è niente da esporre. La macchina **chiama
fuori**, il punto d'incontro è del fornitore, l'utente fa login e basta.

Questa è la forma da avere. E il pezzo che vendiamo non è «controlla l'agente dal
telefono» — quello Anthropic lo regala di serie — ma **lo strato team**:
condivisione, persone, organizzazioni, concessioni. Il relay è ciò che lo rende
raggiungibile, ed è quindi il confine naturale del piano a pagamento.

## What changes

**Il Mac chiama fuori.** Topics apre una WebSocket in uscita verso il relay e
registra l'installazione. Niente porte in ascolto, niente inoltro sul router,
niente DNS per cliente, niente credenziali da distribuire.

**Il relay è un Durable Object per installazione.** L'ospite arriva su un Worker,
che lo instrada al Durable Object dell'installazione giusta; il DO mette in
comunicazione i due lati. Un solo Worker, un solo dominio con wildcard.

**Il relay non capisce quello che inoltra.** I payload viaggiano cifrati
end-to-end fra la macchina e il browser dell'ospite, con la chiave nel
**frammento** dell'URL — che il browser non manda mai al server. Così «non
possiamo leggere» smette di essere una promessa commerciale e diventa una
proprietà verificabile.

**La parola «tunnel» non compare nell'interfaccia.** Chi condivide vede un link.
Chi lo apre vede la cosa condivisa.

## Decisioni prese, e perché

**Cloudflare Workers + Durable Objects, non un VPS.** Il carico di un relay è
fatto di connessioni FERME, non di calcolo: con l'ibernazione una connessione
zitta non costa, su un VPS è RAM occupata h24. In più: nessuna amministrazione di
sistema su un pezzo critico, anycast globale invece di una macchina sola in un
posto solo, e account, dominio e pipeline di deploy già esistenti (il landing è
già un Worker).

L'unico argomento vero a favore del VPS — «il TLS termina da me, nessun terzo
legge» — è annullato dalla cifratura end-to-end: il Worker inoltra blob opachi e
Cloudflare non legge comunque.

**La scelta è reversibile a costo quasi nullo**: la macchina si connette in
uscita a un hostname. Spostare il relay altrove è cambiare quell'hostname. Un
«relay dedicato» per un cliente con vincoli di sovranità del dato si vende senza
riscrivere niente.

## Costi

Piano Workers Paid: **$5/mese**, include Workers, KV e Durable Objects. Sopra:
richieste $0.15/milione (1M incluso), durata $12.50 per milione di GB-s (400.000
inclusi).

L'esempio ufficiale di Cloudflare — 100 oggetti × 100 connessioni ibernanti, 1
messaggio/minuto — costa **$10/mese in tutto**. Qui un oggetto è
un'installazione, con 2-5 connessioni, non 100.

Stima per **100 clienti**: ~$10-15/mese totali, cioè **10-15 centesimi a
cliente**. Contro un piano team a 10-20€ è rumore. I messaggi in USCITA non si
pagano, e quelli in entrata contano 20:1 — la chat, fatta di tanti frame
piccoli, è quasi gratis sull'asse richieste. Il consumo vero è la DURATA durante
i turni in streaming, e i 400.000 GB-s inclusi coprono dell'ordine di 100.000
turni al mese.

Margine di sicurezza: la documentazione di Cloudflare ha una segnalazione aperta
secondo cui l'ibernazione impiega ~10 secondi a scattare, quindi la durata reale
è più alta dell'esempio. Anche a 3× si resta sotto i $50/mese a 100 clienti.

## Out of scope — e perché

- **Il failover in cloud** (la sessione continua quando il Mac si spegne). È il
  differenziatore di Omnara ed è un servizio a sé, non un dettaglio di questo.
  Cambia la **promessa del prodotto**: nel momento in cui la sessione prosegue
  da noi, «il codice non lascia la tua macchina» smette di essere vero. Va
  venduto come opzione esplicita, mai incluso per inerzia.
- **Il problema del Mac che dorme.** Senza failover, una cosa condivisa è
  visibile quando la tua macchina è accesa. Va detto chiaramente
  nell'interfaccia, non scoperto dall'ospite davanti a una pagina vuota.
- **Il tunnel self-host.** Resta com'è: strada diversa, stesso server.

## Risks

1. **Sbagliare l'ibernazione costa 40×.** L'esempio di Cloudflare: stesso identico
   carico, `accept()` invece dell'API di ibernazione, **$416/mese invece di
   $10**. È l'intero budget appeso a una scelta di API, quindi diventa un
   requisito e non una raccomandazione.
2. **Il co-browse a pixel dentro il Durable Object.** Sarebbe un altro ordine di
   grandezza, e sbatterebbe contro i limiti di dimensione dei messaggi. Resta
   WebRTC peer-to-peer, come già è. Anche questo è un requisito.
3. **La cifratura end-to-end verso un BROWSER è la parte difficile.** La chiave
   deve stare nel frammento dell'URL: chi ha il link ha accesso, quindi il link
   È la credenziale e va trattato come tale (scadenza, revoca). Se questa parte
   si rimanda, la promessa di riservatezza va rimandata con lei — non annunciata
   e poi corretta.
4. **Il relay diventa un pezzo critico che possediamo.** Se cade, i clienti non
   vedono più le cose condivise. L'app locale però continua a funzionare, e
   questa è la proprietà da non perdere mai: il relay è un di più, non la strada
   per cui passa il lavoro.
