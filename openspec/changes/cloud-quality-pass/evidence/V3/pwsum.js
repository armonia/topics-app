// Summarise Playwright JSON reports: counts and non-passing tests. Usage: node pwsum.js a.json [b.json...]
const fs = require('fs');
const out = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 }; const bad = [];
for (const f of process.argv.slice(2)) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const k of Object.keys(out)) out[k] += j.stats?.[k] ?? 0;
  const walk = (s, file) => {
    for (const sp of s.specs || []) for (const t of sp.tests || []) {
      if (t.status === 'unexpected' || t.status === 'flaky') {
        const last = t.results[t.results.length - 1];
        const err = (t.results.find(r => r.error)?.error?.message || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 160);
        bad.push(`${t.status.toUpperCase()} ${sp.file}:${sp.line} ${sp.title} [${t.results.map(r => r.status).join(',')}] ${err}`);
      }
    }
    for (const c of s.suites || []) walk(c, file);
  };
  for (const s of j.suites || []) walk(s);
}
console.log(JSON.stringify(out)); for (const b of bad) console.log(b);
