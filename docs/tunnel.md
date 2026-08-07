# Raggiungere Topics da fuori (Cloudflare Tunnel)

Serve quando chi deve vedere una cosa condivisa **non è sulla tua rete**. Sulla
LAN non serve niente: il telefono si appaia e basta.

## Il pericolo, prima di tutto il resto

Un tunnel termina **su questa macchina** e inoltra a loopback. E loopback, per
questo server, è la classe più fidata che esista: `evaluateIdentity` la fa
proprietaria **senza chiedere nessuna credenziale**, ed è l'unica che apre
`/__daemon/*`.

Quindi un tunnel puntato sulla porta normale non estende il perimetro: lo
**rovescia**. Chiunque su Internet entra come il padrone di casa, e nessun
controllo dentro il server può distinguerlo da te — perché dal suo punto di
vista *sei* tu.

È il motivo per cui il vecchio pannello dei tunnel è stato rimosso (vedi
`openspec/changes/device-auth/specs/remote-access/spec-removal.md`) e per cui
esiste `TOPICS_TUNNEL_PORT`.

## La regola

> Il tunnel parla con una **porta sua**. Mai con la 3333.

```bash
# nel tuo ~/.topics-server-env, o dove tieni l'ambiente del server
TOPICS_TUNNEL_PORT=3334
```

Il server apre un secondo ascoltatore su `127.0.0.1:3334`. Non aggiunge
superficie di rete — è legato a loopback come il tunnel — ma quello che entra da
lì **non è locale**, anche se il peer è `127.0.0.1`. Da quella porta:

- l'identità è quella di un dispositivo qualunque: chi arriva deve appaiarsi;
- `/__daemon/*` è negato **anche con il token giusto** (verificato: `202` sulla
  porta normale, `401` sulla stessa richiesta dal tunnel);
- l'indirizzo per il tetto sull'appaiamento è quello **vero**, letto da
  `CF-Connecting-IP`. Senza, il peer sarebbe sempre `127.0.0.1` e il tetto di
  tre richieste per indirizzo diventerebbe un tetto per l'intero Internet.

L'header si legge **solo** su quella porta. Sulla principale sarebbe una
dichiarazione che può fare chiunque sia in rete locale.

## Configurare cloudflared

```yaml
# ~/.cloudflared/config.yml
tunnel: <ID-DEL-TUNNEL>
credentials-file: /Users/<tu>/.cloudflared/<ID-DEL-TUNNEL>.json

ingress:
  - hostname: topics.esempio.io
    service: https://127.0.0.1:3334
    originRequest:
      # Il certificato locale è auto-firmato: la fiducia sta nel fatto che
      # l'origine è loopback, non nella catena.
      noTLSVerify: true
  - service: http_status:404
```

```bash
cloudflared tunnel login
cloudflared tunnel create topics
cloudflared tunnel route dns topics topics.esempio.io
cloudflared tunnel run topics
```

Poi aggiungi l'hostname alle origini ammesse, perché il cancello d'origine
confronta `Origin` e `Host`:

```bash
TOPICS_ALLOWED_ORIGINS=https://topics.esempio.io
```

(È riletto a ogni richiesta: non serve riavviare.)

## Cosa NON mettiamo, e perché

**Niente Cloudflare Access.** Topics ha già la sua identità: appaiamento per
dispositivo, persone, organizzazioni, concessioni, sola lettura per gli ospiti.
Metterci davanti l'autenticazione di un fornitore vorrebbe dire **due sistemi
che dicono chi sei**, da tenere in accordo per sempre — e il giorno in cui
divergono, quello che sbaglia è quello che nessuno guarda. Il tunnel qui fa una
cosa sola: portare i byte. Chi sei lo decide Topics.

**Niente pannello nell'app.** Alzare un tunnel resta un gesto da operatore. Il
pannello che lo faceva metteva l'esposizione più forte possibile dietro la
deliberazione più debole possibile, e non funzionava nemmeno.

**Niente processo avviato dall'app.** `cloudflared` è tuo, gira per conto suo, e
se lo spegni Topics continua a funzionare in locale come sempre.

## Il pezzo che resta scoperto

Cloudflare **termina il TLS al suo bordo**: in linea di principio vede in chiaro
ciò che passa. Per il sito pubblico non cambia niente; per le tue chat, i tuoi
terminali e il tuo codice è una decisione di fiducia da prendere consapevolmente.

Se la risposta è no, la forma alternativa è un VPS tuo (WireGuard verso questa
macchina + un reverse proxy che termina il TLS lì): stesso disegno,
`TOPICS_TUNNEL_PORT` incluso — cambia solo chi porta i byte.
