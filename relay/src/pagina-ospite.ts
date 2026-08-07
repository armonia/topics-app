/**
 * La pagina che si apre cliccando un link condiviso.
 *
 * ── PERCHÉ LA SERVE IL RELAY ────────────────────────────────────────────────
 * Perché è l'unico posto che c'è sempre. La macchina del proprietario può
 * essere spenta — è anzi il caso che questa pagina deve saper raccontare — e
 * una pagina servita da lì non comparirebbe proprio, lasciando l'ospite davanti
 * a un errore di connessione del browser invece che a una frase.
 *
 * ── LA CHIAVE NON ARRIVA MAI QUI ────────────────────────────────────────────
 * Questo file è HTML statico: identico per tutti, non sa niente di nessuno. La
 * chiave sta nel FRAMMENTO dell'URL, che il browser non manda al server — e
 * infatti il Worker non la vede nemmeno mentre serve questa pagina. È il codice
 * qui dentro, nel browser dell'ospite, a leggerla da `location.hash` e a
 * decifrare. Il relay resta cieco anche mentre consegna il proprio visore.
 *
 * ── COME SI COSTRUISCE QUELLO CHE SI VEDE ───────────────────────────────────
 * Solo `createElement` e `textContent`, mai `innerHTML`. Il contenuto arriva da
 * un'altra macchina attraverso un canale che non controlliamo: la firma GCM
 * garantisce che nessuno l'abbia alterato in viaggio, non che il titolo di una
 * scheda non contenga `<script>`. Con `textContent` la domanda non si pone —
 * e non si pone nemmeno per chi leggerà questo file fra un anno, che è metà del
 * punto: una sicurezza che va verificata leggendo i letterali è una sicurezza
 * che prima o poi qualcuno rompe interpolando.
 *
 * La CSP chiude il resto: niente script esterni, niente connessioni fuori
 * dall'origine. Se qualcosa qui andasse storto, la chiave nel frammento non
 * avrebbe comunque dove andare.
 */
export const PAGINA_OSPITE = `<!doctype html>
<html lang="it">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<!-- \`noindex\` e nessun referrer: un link condiviso non deve finire in un motore
     di ricerca, ne' raccontare a nessuno da dove e' stato aperto. -->
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Condiviso con te · Topics</title>
<style>
  :root { color-scheme: light dark; --b:#e5e5e5; --m:#6b7280; --s:#fafafa; }
  @media (prefers-color-scheme: dark) { :root { --b:#2a2a2a; --m:#9ca3af; --s:#141414; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
         display:flex; min-height:100vh; align-items:flex-start; justify-content:center; padding:24px 16px; }
  main { width:100%; max-width:640px; }
  .cap { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--m); margin-bottom:10px; }
  .card { border:1px solid var(--b); border-radius:14px; padding:18px 20px; background:var(--s); }
  h1 { font-size:19px; line-height:1.35; margin:0 0 10px; font-weight:600; }
  .meta { font-size:12.5px; color:var(--m); display:flex; gap:10px; flex-wrap:wrap; }
  .meta span + span::before { content:"·"; margin-right:10px; }
  .nota { font-size:12px; color:var(--m); margin-top:16px; text-align:center; }
  .attesa { color:var(--m); font-size:14px; }
</style>
<main>
  <div class="cap">Condiviso con te</div>
  <div id="dove"></div>
  <p class="nota" id="nota"></p>
</main>
<script type="module">
const dove = document.getElementById('dove');
const nota = document.getElementById('nota');

/** Costruisce la card. Solo nodi e testo: niente HTML da stringhe, mai. */
function mostra(titolo, righe) {
  dove.replaceChildren();
  const card = document.createElement('div'); card.className = 'card';
  const h = document.createElement('h1'); h.textContent = titolo; card.appendChild(h);
  const meta = document.createElement('div'); meta.className = 'meta';
  for (const r of righe.filter(Boolean)) {
    const s = document.createElement('span'); s.textContent = String(r); meta.appendChild(s);
  }
  if (meta.childNodes.length) card.appendChild(meta);
  dove.appendChild(card);
}
function attesa(t) {
  dove.replaceChildren();
  const p = document.createElement('p'); p.className = 'attesa'; p.textContent = t; dove.appendChild(p);
}
attesa('Apro…');

const daB64u = (s) => {
  const p = s.replace(/-/g,'+').replace(/_/g,'/');
  const bin = atob(p + '='.repeat((4 - p.length % 4) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
};
const aB64u = (b) => { let s=''; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''); };

const chiave = location.hash.replace(/^#/, '');
const m = location.pathname.match(/\\/g\\/([^/]+)\\/([^/]+)\\/?$/);

if (!chiave || !m) {
  mostra('Questo link è incompleto',
    ['Manca la parte dopo il #, che è quella che apre il contenuto. Chiedi di rimandartelo intero.']);
} else {
  const [, inst, ref] = m;
  const k = await crypto.subtle.importKey('raw', daB64u(chiave), { name:'AES-GCM' }, false, ['encrypt','decrypt']);

  const sigilla = async (testo) => {
    const iv = new Uint8Array(new ArrayBuffer(12)); crypto.getRandomValues(iv);
    const ct = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv}, k, new TextEncoder().encode(testo)));
    return '1.' + aB64u(iv) + '.' + aB64u(ct);
  };
  const apri = async (busta) => {
    try {
      const p = busta.split('.'); if (p.length !== 3 || p[0] !== '1') return null;
      return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:daB64u(p[1])}, k, daB64u(p[2])));
    } catch { return null; }
  };

  // La macchina spenta ha una frase sua: senza, l'ospite resterebbe davanti a
  // una pagina vuota che si legge come «non ti hanno condiviso niente».
  const spenta = () => mostra('Questa cosa non è raggiungibile adesso',
    ['Il computer di chi te l\\'ha condivisa è spento. Riprova più tardi: il link resta valido.']);
  // Scaduto e revocato si dicono insieme di proposito: distinguerli
  // racconterebbe a chi prova quale dei due gli è capitato.
  const finito = () => mostra('Questo link non è più valido',
    ['Può essere scaduto, oppure chi lo ha creato lo ha revocato.']);

  const ws = new WebSocket(location.origin.replace(/^http/,'ws') + '/s/' + inst);
  ws.onerror = spenta;
  ws.onclose = (e) => { if (e.code !== 1000) spenta(); };

  ws.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === 'denied') return spenta();
    if (msg.t === 'ready') {
      ws.send(JSON.stringify({ t:'to-host',
        payload: JSON.stringify({ ref, b: await sigilla(JSON.stringify({ t:'fetch' })) }) }));
      return;
    }
    if (msg.t !== 'to-guest') return;
    const chiaro = await apri(msg.payload);
    if (!chiaro) return finito();
    let r; try { r = JSON.parse(chiaro); } catch { return finito(); }
    if (r.status !== 200) return finito();

    const b = r.body || {};
    mostra(b.text || b.name || 'Senza titolo', [b.status, b.project_id]);
    nota.textContent = 'Sola lettura. Il contenuto è cifrato: chi lo trasporta non può leggerlo.';
  };
}
</script>
</html>`;
