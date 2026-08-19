// LA CODA DI TESTA (head-of-line) SU HTTP/1.1, misurata.
// Ipotesi: le richieste del boot non sono lente, sono in FILA. WebKit apre 6
// connessioni per host; se le pesanti le occupano, una richiesta da 212 byte
// aspetta il suo turno anche se il server e' libero.
// Prova: si lanciano N richieste alla rotta piu' lenta e si cronometra UNA
// richiesta minuscola. Se il ritardo cresce a scalini di 6, e' la coda.
import { webkit } from 'playwright';
const b = await webkit.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
await p.goto('https://localhost:3333/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(8000);

for (const n of [0, 3, 6, 12]) {
  const ms = await p.evaluate(async (n) => {
    // n richieste lente in volo, non attese
    for (let i = 0; i < n; i++) fetch('/api/topics/previews?x=' + Math.random());
    await new Promise((r) => setTimeout(r, 60));
    const s = performance.now();
    await fetch('/api/system/dispatch-capacity?y=' + Math.random());
    return Math.round(performance.now() - s);
  }, n);
  console.log(`${String(n).padStart(2)} richieste pesanti in volo  →  la sonda da 212 byte impiega ${ms} ms`);
  await p.waitForTimeout(3000);
}
await b.close();
