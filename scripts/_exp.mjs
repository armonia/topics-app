// ESPERIMENTO: le animazioni infinite fanno crescere i layer del compositore?
// Due giri identici tranne una variabile. La misura e' la CRESCITA delle
// regioni `owned unmapped (graphics)` del processo di contenuto della finestra
// di prova — non il valore assoluto, che dipende da cosa c'era prima.
import { webkit } from 'playwright';
import { execSync } from 'child_process';

const regioni = (pid) => {
  try { return Number(execSync(`vmmap ${pid} 2>/dev/null | grep -c 'owned unmapped (graphics)'`, {encoding:'utf-8'}).trim()); }
  catch { return -1; }
};
/** Il WebContent piu' GIOVANE: e' quello che la nostra finestra ha appena
 *  creato. `-o lstart=` da solo, cosi' le colonne sono solo la data. */
const contentPidGiovane = () => {
  const out = execSync(
    `ps -axo pid=,lstart=,command= | grep 'WebKit.WebContent.xpc' | grep -v grep`,
    {encoding:'utf-8'});
  const righe = out.trim().split('\n').filter(Boolean).map((r) => {
    const m = r.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})/);
    return m ? { pid: Number(m[1]), t: Date.parse(m[2]) } : null;
  }).filter(Boolean).sort((a, b) => b.t - a.t);
  return righe[0]?.pid ?? null;
};

async function prova(etichetta, ferma, minuti) {
  const b = await webkit.launch();
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  await p.goto('https://localhost:3333/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(15000);
  if (ferma) {
    await p.addStyleTag({ content: `*, *::before, *::after { animation: none !important; }` });
    await p.waitForTimeout(2000);
  }
  const pid = contentPidGiovane();
  const r0 = regioni(pid);
  const anim = await p.evaluate(() => [...document.getElementsByTagName('*')]
    .filter((e) => getComputedStyle(e).animationIterationCount?.split(',').some((v) => v.trim() === 'infinite')).length);
  await p.waitForTimeout(minuti * 60000);
  const r1 = regioni(pid);
  await b.close();
  console.log(`${etichetta.padEnd(18)} pid ${pid} · ${anim} anim infinite · ${r0} → ${r1} regioni  (${r1 - r0 >= 0 ? '+' : ''}${r1 - r0} in ${minuti} min)`);
  return r1 - r0;
}

const MIN = Number(process.argv[2] || 4);
const vive = await prova('animazioni VIVE', false, MIN);
const ferme = await prova('animazioni FERME', true, MIN);
console.log(`\ndifferenza attribuibile alle animazioni: ${vive - ferme} regioni in ${MIN} min`);
