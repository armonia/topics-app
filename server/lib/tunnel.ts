/**
 * Raggiungibilità da fuori, senza invertire il confine di fiducia.
 *
 * ── IL PROBLEMA, ed è quello per cui il pannello dei tunnel è stato tolto ────
 * Un tunnel (Cloudflare, ngrok, chiunque) termina SULLA MACCHINA e inoltra a
 * loopback. Quindi ogni richiesta che arriva da Internet si presenta al server
 * come locale — e locale, qui, è la classe più fidata che esista:
 * `evaluateIdentity` la fa PROPRIETARIA senza chiedere nessuna credenziale, ed è
 * l'unica che apre `/__daemon/*`. Un tunnel messo davanti a questo server così
 * com'è non estende il perimetro: lo ROVESCIA, e nessun controllo *dentro* il
 * server può distinguere quella richiesta da una fatta dal proprietario.
 *
 * ── LA FORMA DELLA SOLUZIONE ────────────────────────────────────────────────
 * La fiducia diventa una proprietà della PORTA da cui si è entrati, non di un
 * header che si può scrivere. Il tunnel parla con un ascoltatore suo, dedicato,
 * legato a loopback; ciò che arriva lì non è locale per definizione, anche se il
 * peer è `127.0.0.1`.
 *
 * Perché non un header di fiducia (`CF-Connecting-IP` e basta): un header lo
 * scrive chiunque possa raggiungere la porta, quindi fidarsene sulla porta
 * principale significherebbe dare a chiunque sia in rete locale il modo di
 * *dichiararsi* remoto o locale a piacere. La porta invece non si falsifica: o
 * ci sei entrato o no.
 *
 * Perché non spegnere semplicemente la fiducia nel loopback: quella è la rete
 * anti-lockout della migration 080. Se cadesse, l'app sulla macchina stessa
 * dovrebbe appaiarsi come un telefono qualunque, e un database di identità
 * corrotto chiuderebbe fuori il proprietario da casa propria.
 *
 * ── COSA NON C'È QUI, DI PROPOSITO ──────────────────────────────────────────
 * Nessuna gestione del tunnel dall'interfaccia: niente pannello, niente
 * bottone, niente processo avviato dall'app. Alzare un tunnel è un gesto da
 * operatore, e il pannello che lo faceva è stato rimosso proprio perché metteva
 * l'esposizione più forte possibile dietro la deliberazione più debole
 * possibile. Qui c'è solo la porta: chi la usa la apre da fuori.
 *
 * E nessun secondo strato di autenticazione. Topics ha già l'identità per
 * dispositivo, l'appaiamento, le concessioni e la sola lettura: mettergli
 * davanti l'autenticazione di un fornitore vorrebbe dire due sistemi che
 * dicono chi sei, da tenere in accordo per sempre.
 */

/**
 * Le richieste arrivate dall'ascoltatore del tunnel.
 *
 * Una `WeakSet` e non un campo sull'oggetto: `Request` è di piattaforma e non
 * va decorato, e la debolezza fa sì che la marcatura muoia con la richiesta.
 */
const viaTunnel = new WeakSet<Request>();

/** Marca una richiesta come arrivata da fuori. Lo fa SOLO l'ascoltatore
 *  dedicato, ed è l'unico posto che può farlo. */
export function markViaTunnel(req: Request): void {
  viaTunnel.add(req);
}

export function isViaTunnel(req: Request): boolean {
  return viaTunnel.has(req);
}

/**
 * Questa richiesta viene DAVVERO dalla macchina?
 *
 * L'unica domanda che le tre porte fidate devono porsi — il cancello
 * dell'identità, l'upgrade del WebSocket e `/__daemon/*` — e va posta in un
 * posto solo. Scritta a mano in tre punti sarebbe tre regole: quella
 * dimenticata sarebbe il buco, e sarebbe il buco che consegna tutto.
 */
export function isLocalTransport(
  req: Request,
  peerIp: string | null,
  isLoopback: (ip: string | null) => boolean,
): boolean {
  if (isViaTunnel(req)) return false;
  return isLoopback(peerIp);
}

/**
 * L'indirizzo VERO di chi ha chiesto.
 *
 * Attraverso il tunnel il peer è sempre `127.0.0.1`, quindi senza questo il
 * tetto per-indirizzo sull'appaiamento (tre richieste a testa) diventerebbe un
 * tetto per l'INTERO Internet: tre richieste in tutto, e il quarto telefono al
 * mondo non riesce più ad appaiarsi.
 *
 * L'header si legge SOLO per ciò che è arrivato dal tunnel. Sulla porta
 * principale sarebbe una dichiarazione di chiunque sia in rete locale.
 */
export function clientIpOf(req: Request, peerIp: string | null): string | null {
  if (!isViaTunnel(req)) return peerIp;
  const dichiarato = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for");
  if (!dichiarato) return peerIp;
  // `X-Forwarded-For` è una catena: il primo è il client, il resto sono i salti.
  const primo = dichiarato.split(",")[0]?.trim();
  return primo || peerIp;
}

/** La porta dedicata al tunnel, se configurata. `null` = nessun ascoltatore in
 *  più, cioè il comportamento di sempre. */
export function tunnelPort(env: Record<string, string | undefined>): number | null {
  const raw = env.TOPICS_TUNNEL_PORT;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}
