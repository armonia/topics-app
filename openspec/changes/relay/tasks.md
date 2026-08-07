# Tasks — relay

Ogni passo è verificabile da solo. I primi due non toccano Cloudflare: si può
sapere se il disegno regge prima di aprire un conto.

## 0. Prima di scrivere codice

- [x] 0.1 **Verificare i termini di Cloudflare.** Sciolto per la parte che
  contava, con un residuo dichiarato.

  La vecchia sezione 2.8 («Limitation on Serving Non-HTML Content»), che è
  quella che avrebbe potuto vietarci il relay, **non esiste più**: ritirata a
  maggio 2023 e sostituita da una clausola specifica per la CDN. I termini
  supplementari dei Workers permettono esplicitamente contenuto HTML e non-HTML
  (immagini, audio) **tranne i file video**. Noi trasportiamo frame JSON: dentro
  senza forzature.

  Coincidenza utile: il vincolo che il co-browse a pixel NON passi dal Durable
  Object l'avevo messo per il COSTO (RELAY-02), e si scopre che è anche ciò che
  ci tiene lontani dall'unica categoria ancora ristretta. La stessa decisione
  paga due volte.

  **Il residuo**: non stiamo mettendo Cloudflare davanti al dominio di un
  cliente (quello sarebbe «Cloudflare for SaaS» e ha clausole sue). Stiamo
  facendo girare la NOSTRA applicazione sul nostro account, e i clienti ne sono
  utenti — cioè un SaaS normale sui Workers, che è ciò per cui il Developer
  Platform è venduto. Il rischio residuo è basso, ma non è una domanda da forum:
  se il prodotto cresce, va confermata leggendo il Self-Serve Subscription
  Agreement o chiedendo a Cloudflare. Non blocca la costruzione.
- [x] 0.2 **Misurare il traffico VERO di un turno.** Fatto su 1511 turni reali di
  101 giorni: 14,9 turni/giorno per utente, durata mediana 48,7 s, media 163 s,
  **20,4 GB-s a turno**. Stimavo 4 — cinque volte meno — ma stimavo anche 50
  turni al giorno invece di 15, e i due errori si annullavano. La conclusione
  regge ($0,11 a cliente) e adesso poggia su una misura. Numeri nel proposal.

## 1. Il protocollo, prima del trasporto

- [ ] 1.1 `shared/relay-protocol.ts`: registrazione, apertura di una sessione
  ospite, inoltro, chiusura. Puro, con un test — così il trasporto diventa
  sostituibile e la scelta di Cloudflare resta reversibile davvero.
- [ ] 1.2 Il **contratto di cifratura**: chiave nel frammento, formato del
  payload, rotazione, scadenza. Deciso qui, non quando serve.
- [ ] 1.3 Un relay **finto in-process** per i test: due estremi, nessuna rete.
  È ciò che permette di provare RELAY-04 (arrivare non è essere autorizzati)
  senza dipendere da un servizio esterno.

## 2. Il lato macchina

- [ ] 2.1 Connessione in USCITA verso il relay, con riconnessione a intervalli
  crescenti. Nessuna porta in ascolto.
- [ ] 2.2 Il gate resta quello di sempre: chi arriva dal relay è un dispositivo
  come un altro. **Nessuna scorciatoia di fiducia** — vale la stessa lezione del
  tunnel, dove loopback significava proprietario.
- [ ] 2.3 Il relay è spegnibile e l'app locale non se ne accorge.

## 3. Il lato Cloudflare

- [ ] 3.1 Worker + Durable Object per installazione.
- [ ] 3.2 **API di ibernazione obbligatoria**, e un test che lo dimostri: con
  `accept()` lo stesso carico costa 40 volte tanto. Non è
  un'ottimizzazione, è il budget.
- [ ] 3.3 `setWebSocketAutoResponse()` per i ping, che così non si pagano.
- [ ] 3.4 Il co-browse a pixel NON passa di qui: resta WebRTC. Un test di
  contratto che fallisca se un frame video entra nel DO.

## 4. Il gesto, nell'interfaccia

- [ ] 4.1 «Condividi fuori rete» produce un link. La parola «tunnel» non compare.
- [ ] 4.2 Il link è la credenziale: scadenza visibile e revoca dove lo si crea.
- [ ] 4.3 Macchina spenta → «non raggiungibile adesso», col motivo. Mai una
  pagina vuota che sembra «non ti hanno condiviso niente».

## 5. Prima di venderlo

- [ ] 5.1 Un tetto di consumo per installazione, con un allarme. Un cliente che
  per un difetto inonda il relay non deve poter produrre una bolletta a
  sorpresa.
- [ ] 5.2 Misurare il costo reale su un mese di uso vero e confrontarlo con la
  stima di questo documento. Se diverge, si aggiorna il documento — non si
  aggiusta il ricordo.
