/**
 * RAM per pane di un browser Chromium-family QUALSIASI, con l'attribuzione
 * giusta: contano solo i pid NATI da questo banco.
 *
 * Il filtro per nome comando da solo mente e l'ho visto: Helium era gia' aperto
 * dall'utente con 33 processi, e la prima pane risultava 3533 MB invece di ~300.
 */
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';

const exe = process.argv[2], tag = process.argv[3];
const pids = () => new Set(execSync('ps -eo pid').toString().split('\n').slice(1).map(s => s.trim()).filter(Boolean));
const before = pids();
const rssNuovi = () => {
  let t = 0;
  for (const l of execSync('ps -eo pid,rss').toString().split('\n').slice(1)) {
    const [p, r] = l.trim().split(/\s+/);
    if (p && !before.has(p)) t += parseInt(r || '0', 10);
  }
  return Math.round(t / 1024);
};

const b = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--use-mock-keychain'] });
const out = [];
for (let i = 0; i < 6; i++) {
  const c = await b.newContext();
  const p = await c.newPage();
  await p.goto('data:text/html,<h1>pane ' + i + '</h1>');
  await new Promise(r => setTimeout(r, 700));
  out.push(rssNuovi());
}
console.log(`${tag}: 1a ${out[0]} MB -> 6 ${out[5]} MB | marginale ${Math.round((out[5]-out[0])/5)} MB/pane`);
await b.close();
