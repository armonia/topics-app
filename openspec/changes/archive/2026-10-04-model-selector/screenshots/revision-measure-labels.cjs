// How many lines each label of revision-rules.js needs in the selector's label cell (WebKit, 12px/16px).
// Run from the repo: node openspec/changes/model-selector/screenshots/revision-measure-labels.cjs <file with one model id per line>
const path = require('path');
const fs = require('fs');
const { webkit } = require(path.join(__dirname, '../../../../node_modules', 'playwright'));
const { modelLabel, windowOf } = require('./revision-rules.js').MSEL;
const ids = fs.readFileSync(process.argv[2], 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
const rows = ids.filter((id) => !/^claude-/.test(id.replace(/^[^/]+\//, ''))).map((id) => [id, modelLabel(id), !!windowOf(id)]);
(async () => {
  const b = await webkit.launch();
  const p = await b.newPage({ viewport: { width: 800, height: 600 } });
  await p.setContent('<style>body{font:12px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}.lb{line-height:16px;overflow-wrap:anywhere}</style><div id=x class=lb></div>');
  // 121 px = label cell with four columns; 158 px = three columns. A known window takes 30 px more.
  const res = await p.evaluate(({ rows, widths }) => {
    const el = document.getElementById('x');
    const out = {};
    for (const w of widths) out[w] = rows.map(([id, l, win]) => { el.style.width = (win ? w - 30 : w) + 'px'; el.textContent = l; return { id, l, lines: Math.round(el.getBoundingClientRect().height / 16) }; }).filter((r) => r.lines > 2);
    return out;
  }, { rows, widths: [121, 158] });
  for (const [w, over] of Object.entries(res)) console.log(`${w}px: ${over.length} of ${rows.length} labels need more than 2 lines`, over.map((r) => r.l).join(' | '));
  await b.close();
})();
