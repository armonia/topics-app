/**
 * La pagina che risponde a chi apre il relay senza sapere quale macchina cerca.
 *
 * ── IL VICOLO CIECO CHE CHIUDE ──────────────────────────────────────────────
 * La PWA installata ha `start_url: "/"`, quindi ogni avvio bussa alla radice.
 * A dire quale installazione sia è il biscotto `topics_inst`, depositato la
 * prima volta che si è entrati da `/i/<installazione>/`. Finché quel biscotto
 * vive, la radice è casa. Quando scade, quando il telefono lo butta per spazio
 * o per privacy, o quando la PWA viene reinstallata, la radice tornava a essere
 * `404 not found` in testo semplice: nessuna app servita, quindi nessun gesto
 * dentro l'app capace di rimediare, e nessuna frase che dicesse cosa fare.
 *
 * Visto sul telefono il 21/08/2026: la schermata diceva «riprovo da solo fra
 * qualche secondo» e ritentava all'infinito un 404 che non poteva cambiare.
 *
 * ── COSA FA, E COSA NON PUÒ FARE ────────────────────────────────────────────
 * Non può indovinare l'installazione: il relay non tiene un registro, e
 * sceglierne una per conto di chi bussa sarebbe mandare un telefono dentro la
 * macchina di uno sconosciuto. Quindi fa l'unica cosa onesta: dice cosa è
 * successo, e chiede l'indirizzo che l'utente ha già — lo stesso link con cui
 * era entrato la prima volta.
 *
 * Il campo accetta un link intero o il solo nome: da entrambi si ricava
 * `/i/<nome>/`, che è la porta che deposita di nuovo il biscotto. Da lì in poi
 * è l'app di sempre.
 *
 * ── IL RELAY RESTA CIECO ────────────────────────────────────────────────────
 * Questo file è HTML statico: identico per tutti, non nomina nessuna
 * installazione e non ne cerca nessuna. Il nome che l'utente scrive resta nel
 * suo browser fino alla navigazione che lui stesso avvia.
 *
 * Solo `createElement` e `textContent`, mai `innerHTML`, e una CSP che chiude
 * il resto: stessa regola della pagina ospite, per la stessa ragione — una
 * sicurezza che va verificata leggendo i letterali è una sicurezza che prima o
 * poi qualcuno rompe interpolando.
 */
export const PAGINA_SENZA_CASA = `<!doctype html>
<html lang="it">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Quale Topics? · Topics</title>
<style>
  :root { color-scheme: light dark; --b:#e5e5e5; --m:#6b7280; --s:#fafafa; --t:#111; }
  @media (prefers-color-scheme: dark) { :root { --b:#2a2a2a; --m:#9ca3af; --s:#141414; --t:#f5f5f5; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
         display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px 16px; color:var(--t); }
  main { width:100%; max-width:420px; text-align:center; }
  .logo { width:44px; height:44px; margin:0 auto 18px; border-radius:11px; border:1px solid var(--b);
          background:var(--s); display:flex; align-items:center; justify-content:center;
          font-weight:600; font-size:19px; letter-spacing:-.02em; }
  h1 { font-size:19px; line-height:1.35; margin:0 0 10px; font-weight:600; }
  p { font-size:13.5px; color:var(--m); margin:0 0 20px; }
  form { display:flex; gap:8px; }
  input { flex:1; min-width:0; font:inherit; font-size:14px; padding:10px 12px; color:var(--t);
          border:1px solid var(--b); border-radius:10px; background:var(--s); }
  button { font:inherit; font-size:14px; font-weight:500; padding:10px 16px; color:var(--t);
           border:1px solid var(--b); border-radius:10px; background:var(--s); cursor:pointer; }
  .err { font-size:12.5px; color:#b91c1c; margin-top:12px; min-height:1.2em; }
  @media (prefers-color-scheme: dark) { .err { color:#f87171; } }
</style>
<main>
  <div class="logo">T</div>
  <h1>Quale Topics vuoi aprire?</h1>
  <p>Questo browser non ricorda piu&#39; a quale computer era collegato. Incolla il link
     che usi per aprire Topics dal telefono, e ci si rientra.</p>
  <form id="f">
    <input id="q" type="text" inputmode="url" autocomplete="off" autocapitalize="off"
           spellcheck="false" placeholder="Link di Topics" aria-label="Link di Topics">
    <button type="submit">Apri</button>
  </form>
  <div class="err" id="e" role="status"></div>
</main>
<script type="module">
const form = document.getElementById('f');
const campo = document.getElementById('q');
const errore = document.getElementById('e');

/**
 * Il nome dell'installazione, da qualunque cosa sia stata incollata.
 *
 * Un link intero (\`https://…/i/<nome>/qualcosa\`), il solo tratto
 * (\`/i/<nome>\`) o il nome nudo: sono le tre forme che una persona ha
 * davvero sotto mano. La forma la impone il Worker, e qui si rifiuta tutto
 * il resto invece di navigare verso un indirizzo storto.
 */
function nome(grezzo) {
  const s = (grezzo || '').trim();
  if (!s) return null;
  const dentro = s.match(/\\/i\\/([A-Za-z0-9_-]{1,128})/);
  if (dentro) return dentro[1];
  return /^[A-Za-z0-9_-]{1,128}$/.test(s) ? s : null;
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const n = nome(campo.value);
  if (!n) {
    errore.textContent = 'Non riconosco questo link. Dovrebbe contenere /i/ seguito da un codice.';
    return;
  }
  errore.textContent = '';
  // La navigazione la avvia l'utente, verso la porta che deposita il biscotto.
  location.href = '/i/' + n + '/';
});
</script>
`;
