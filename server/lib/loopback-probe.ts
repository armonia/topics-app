/**
 * «Su questa porta c'è ancora qualcuno?»
 *
 * Serve alle schede del browser che riaprono su una URL di `localhost`. Sono
 * moltissime e quasi tutte puntano all'ANTEPRIMA di un task — un server
 * effimero su una porta alta, che muore con la sessione dell'agente mentre la
 * URL resta salvata per sempre. Riaprire quel task riapriva la scheda, WebKit
 * sparava una richiesta destinata a fallire e mostrava la sua pagina d'errore.
 *
 * Con questa risposta la pane può NON caricare affatto e dire cosa manca.
 *
 * Solo loopback, per contratto: è una domanda sui processi di questa macchina,
 * e accettare un host qualunque trasformerebbe la rotta in un port scanner
 * comandabile da fuori.
 */

import net from "node:net";

/**
 * La porta da sondare per questa URL, oppure `null` se non è una URL loopback.
 *
 * La porta implicita conta: `http://localhost` è la 80, e chiederlo per una
 * scheda del genere è legittimo quanto chiederlo per la 3210.
 */
export function loopbackPortOf(raw: string): number | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  const isLoopback =
    h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1" || h === "[::1]" || h.endsWith(".localhost");
  if (!isLoopback) return null;
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * TCP connect e basta: se la connessione si apre, qualcosa è in ascolto. Non si
 * fa una richiesta HTTP apposta — la domanda è «c'è un processo», non «risponde
 * 200», e un handshake TLS o un redirect non cambiano la risposta.
 *
 * Timeout corto: è loopback, o risponde subito o non c'è.
 */
function connectsTo(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let settled = false;
    const done = (listening: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(listening);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * In ascolto su UNA QUALUNQUE delle due facce del loopback.
 *
 * Sondare solo `127.0.0.1` dava per morto un server che ascolta solo su `::1` —
 * e non è un caso di scuola: `server.listen(port)` senza host, su Node come su
 * Bun, finisce spesso sul solo IPv6. Un falso «è spenta» è il danno peggiore
 * qui, perché parcheggia una scheda VIVA: quindi si chiede a entrambi e basta
 * che uno risponda.
 *
 * In parallelo, non in sequenza: due timeout in fila raddoppierebbero l'attesa
 * proprio nel caso più comune, quello della porta davvero morta.
 */
export async function isPortListening(port: number, timeoutMs = 300): Promise<boolean> {
  const [v4, v6] = await Promise.all([
    connectsTo("127.0.0.1", port, timeoutMs),
    connectsTo("::1", port, timeoutMs),
  ]);
  return v4 || v6;
}
