# Licenze — la chiave, dove vive, come si conia

Questo documento risponde a una domanda sola: **dove sta il segreto con cui
firmiamo le licenze, e cosa succede a chi paga se lo perdiamo o lo lasciamo
uscire.**

## La coppia

Le licenze sono gettoni Ed25519. La coppia è nata il 2026-08-10, `kid`
`armonia-1`.

- **La pubblica** è nel sorgente, in `server/lib/licenza.ts` → `CHIAVI_INTEGRATE`.
  Ci sta perché è pubblica: serve solo a *controllare* una firma, non a farla.
  Finché quella lista è vuota, `verificaGettone` risponde `no_verification_key`
  prima ancora di guardare la firma, e **ogni installazione spedita resta sul
  piano gratuito qualunque gettone le si dia** — un'app che non vende.
- **La privata** non è in questo repository, in nessuna forma, mai. Non è nemmeno
  nella cronologia: `scripts/licenza.ts chiavi` la stampa a schermo e non la
  scrive da nessuna parte apposta.

## Dove vive la privata

Due copie, e nessuna delle due è un file nel repo.

1. **La copia durevole: il gestore di password dell'organizzazione**, in una voce
   dedicata alla chiave di conio. È quella che sopravvive a un disco che muore, e
   l'unica che vale se un giorno la macchina di chi conia non è più quella di
   oggi.
2. **La copia di lavoro: un file locale, permessi `0600`**, tenuto dove il
   progetto tiene già gli altri segreti di rilascio — così non nasce un posto
   nuovo da ricordare. È comodità, non archivio: se sparisce si rimette dal
   punto 1.

**Dove stiano di preciso quella voce e quel file, questo documento non lo dice**,
ed è voluto: un manuale versionato in un repo non è il posto in cui scrivere
l'indirizzo di una chiave privata. Nei comandi qui sotto la copia di lavoro si
chiama `$CHIAVE_LICENZE`; chi conia sa a quale percorso corrisponde sulla propria
macchina, e lo esporta prima di eseguire.

Cosa NON è un posto dove vive: un `.env` del progetto, una variabile in CI, un
allegato su una board, un messaggio. `TOPICS_LICENSE_PRIVKEY` esiste per passarla
al comando che conia — si legge dal file al momento (`$(cat …)`) e non si scrive
in nessun profilo di shell.

Chi ha la privata può emettere una licenza `team` per qualunque installazione.
Non c'è revoca: un gettone emesso vale fino alla sua scadenza. È per questo che
la scadenza è obbligatoria nel formato — un gettone senza scadenza sopravvive
alla fine dell'abbonamento *e a chi l'ha emesso*.

## Il conio automatico: chi paga riceve senza che nessuno apra un terminale

`scripts/conio-licenze.ts` è il servizio che chiude il giro. Gira **da noi**, non
sulla macchina di chi compra, e non è montato da nessuna rotta dell'app: il
server che spediamo non contiene nemmeno il codice che chiede una chiave privata.

Il giro, per intero:

1. il cliente paga → Stripe emette `customer.subscription.created`;
2. il servizio lo riceve sul proprio endpoint, verifica la firma con
   `CONIO_WEBHOOK_SECRET` (il segreto **dell'endpoint del venditore**, che è un
   altro da quello configurato sull'installazione del cliente);
3. conia con la privata e **scrive il gettone in
   `metadata.license_token` dell'abbonamento**;
4. quella scrittura fa emettere a Stripe un `customer.subscription.updated`;
5. l'installazione del cliente riceve *quel* secondo evento — che adesso il
   gettone ce l'ha — e `server/routes/billing.ts` lo passa alla porta unica, che
   lo riverifica con la chiave pubblica.

Il passo 3 è la scelta che conta: **il gettone viaggia dentro Stripe**, cioè
nell'unico tubo dal venditore all'installazione che già esiste, già è firmato e
già viene ritentato quando cade. Non c'è un secondo canale da tenere in piedi.

Stripe resta un corriere. Chi bucasse l'account potrebbe scrivere
`license_token: "pippo"` e otterrebbe `bad_signature`, cioè il piano gratuito.

### Accenderlo

```
CHIAVE_LICENZE="…/percorso/della/copia/di/lavoro"   # vedi «Dove vive la privata»

TOPICS_LICENSE_PRIVKEY="$(cat "$CHIAVE_LICENZE")" \
CONIO_WEBHOOK_SECRET=whsec_… \
STRIPE_SECRET_KEY=sk_live_… \
  bun scripts/conio-licenze.ts 4444
```

Ascolta **solo su `127.0.0.1`**: davanti ci va il tunnel che espone `/webhook` a
Stripe. Un processo che ha la privata delle licenze non si mette in ascolto su
ogni interfaccia perché era il default. La riga d'avvio dice quali segreti ha e
quali gli mancano; `/health` risponde `ok`.

Su Stripe va registrato un endpoint che punta a quel tunnel, con i tipi
`customer.subscription.created` e `customer.subscription.updated`.

### Cosa risponde, e cosa vuol dire

| risposta | cosa è successo |
|---|---|
| `200 minted:true` | coniato e scritto: il cliente lo riceverà col prossimo evento |
| `200 minted:false, reason:"already_minted"` | è l'eco della nostra stessa scrittura. **È lo stop al ciclo**: senza, il servizio riscriverebbe per sempre |
| `200 minted:false, reason:"unhandled_type"` | non ci riguarda (Stripe manda molti più eventi di quanti servano) |
| `200 minted:false, reason:"no_installation_id"` | l'abbonamento non dice per quale macchina: il checkout non ha copiato l'identificativo in `subscription_data.metadata` |
| `400` | firma o corpo storti: non tornerà mai, Stripe smetta |
| `503` | manca un segreto **a noi**. Il cliente ha pagato e non ha ricevuto: sistemare la variabile e riconsegnare l'evento dalla dashboard di Stripe |
| `500` | Stripe non ha accettato la scrittura: si ritenta da sé |

Un gettone si riconia solo quando serve davvero: periodo rinnovato, posti
cambiati, oppure `kid` diverso dopo una rotazione. La scadenza è la fine del
periodo pagato **più tre giorni di grazia** (`GRAZIA_MS`), perché il rinnovo
accade *dopo* la scadenza e nessuno deve passare sul piano gratuito mentre
l'addebito è in volo.

### Quando non conia

Il rimedio immediato è sempre lo stesso, e non richiede di riparare niente:
coniare a mano con `scripts/licenza.ts conia` (sotto) e mandare il gettone al
cliente. Poi si guarda il log del servizio, che dice per chi non ha coniato e
perché — senza mai stampare il gettone, che in un file di log è una licenza
valida lasciata in giro.

## Coniare una licenza a mano

Serve per chi non passa da Stripe (bonifico, fattura, una prova concordata) e
come rimedio quando il servizio è giù. Firma con **la stessa funzione** del
servizio (`scripts/conio-lib.ts`): due implementazioni della stessa firma sono
due implementazioni che col tempo si allontanano.

Il cliente legge il proprio identificativo in **Impostazioni → Piano**
(«Installazione»), oppure da terminale sulla sua macchina:

```
curl -sk https://127.0.0.1:3333/api/license
```

Poi, sulla macchina che ha la chiave, con `CHIAVE_LICENZE` che punta alla copia
di lavoro (vedi «Dove vive la privata»):

```
TOPICS_LICENSE_PRIVKEY="$(cat "$CHIAVE_LICENZE")" \
  bun scripts/licenza.ts conia <installationId> <posti> <giorni>
```

Il gettone che esce vale **solo** per quella installazione: copiato altrove dà
`other_installation`. Si installa da Impostazioni → Piano incollandolo nel campo,
o con `PUT /api/license`.

Per rispondere a «cosa ho mandato a quel cliente?» senza avere la chiave
sottomano: `bun scripts/licenza.ts ispeziona <gettone>` (legge, non convalida).

## Ruotare la chiave

Serve se la privata è uscita, o quando si passa a un servizio che firma da solo.

1. `bun scripts/licenza.ts chiavi` con `TOPICS_LICENSE_KID=armonia-2`.
2. **Aggiungere** la nuova pubblica in coda a `CHIAVI_INTEGRATE`, senza togliere
   la vecchia: chi verifica prova tutte le chiavi, quindi i gettoni già emessi
   continuano a valere. Toglierla subito significa spegnere le licenze dei
   clienti che hanno pagato.
3. Riconiare i gettoni ancora vivi con la nuova chiave e spedirli.
4. Togliere `armonia-1` solo quando l'ultimo gettone che ha firmato è scaduto.

Il servizio di conio se ne accorge da sé: un gettone firmato con un `kid` diverso
da quello configurato viene riconiato al primo evento utile, quindi i clienti
attivi passano alla chiave nuova senza che nessuno tenga una lista.

C'è un test che tiene onesto questo giro: `server/lib/licenza.test.ts` verifica
un **gettone testimone** — coniato una volta con la privata vera, per
l'installazione `000000000000000000000000` che non esiste — con la sola chiave
integrata. Se qualcuno sostituisce la pubblica senza avere la privata, o fa una
rotazione a metà, quel caso diventa rosso subito, invece che alla prima licenza
venduta (dove il sintomo sarebbe `bad_signature` su un gettone emesso da noi).

## Il verso in cui si sbaglia

Nessun esito di licenza spegne una macchina: gettone assente, storto, di un
altro, scaduto, o nessuna chiave con cui controllarlo — si finisce sul piano
gratuito con un motivo leggibile, e l'uso locale resta intero. È una proprietà
fissata da `server/lib/licenza.test.ts`, non una buona intenzione.
