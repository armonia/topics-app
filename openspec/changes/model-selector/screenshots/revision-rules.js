// Revision 2026-10-04 of the model selector: the pure rules of §3 (maker, merge key,
// generation, label, columns, group engine), runnable in node and inlined in the mockup.
(function (root) {
  const MAKERS = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', meta: 'Meta', mistral: 'Mistral', qwen: 'Qwen', deepseek: 'DeepSeek',
    nvidia: 'NVIDIA', zai: 'Z.ai', moonshot: 'Moonshot', ibm: 'IBM', microsoft: 'Microsoft', xai: 'xAI', cohere: 'Cohere', writer: 'Writer',
    '01ai': '01.AI', ai21: 'AI21 Labs', aisingapore: 'AI Singapore', bigcode: 'BigCode' };
  const VENDOR = { anthropic: 'anthropic', openai: 'openai', google: 'google', meta: 'meta', 'meta-llama': 'meta', mistralai: 'mistral', 'nv-mistralai': 'mistral',
    'deepseek-ai': 'deepseek', deepseek: 'deepseek', moonshotai: 'moonshot', 'z-ai': 'zai', zai: 'zai', thudm: 'zai', 'x-ai': 'xai', '01-ai': '01ai', ai21labs: 'ai21',
    aisingapore: 'aisingapore', bigcode: 'bigcode', qwen: 'qwen', nvidia: 'nvidia', ibm: 'ibm', microsoft: 'microsoft', writer: 'writer', cohere: 'cohere' };
  const FAMILY = [[/^claude-/, 'anthropic'], [/^(gpt-|o\d|codex)/, 'openai'], [/^(gemini|gemma|codegemma|recurrentgemma|diffusiongemma)/, 'google'],
    [/^(llama|codellama)/, 'meta'], [/^(mistral|mixtral|codestral|devstral|magistral|ministral)/, 'mistral'], [/^(qwen|qwq)/, 'qwen'],
    [/^deepseek/, 'deepseek'], [/^(nemotron|nvidia$)/, 'nvidia'], [/^(glm|zai-)/, 'zai'], [/^kimi/, 'moonshot'], [/^granite/, 'ibm'], [/^phi/, 'microsoft'],
    [/^grok/, 'xai'], [/^command/, 'cohere'], [/^palmyra/, 'writer']];
  const RUNTIMES = new Set(['topics', 'claude-code', 'codex', 'jcode', 'claude', 'openai', 'gemini']);
  const FIXED = ['anthropic', 'openai', 'google'];

  function bareId(id) {
    let m = id.trim().toLowerCase();
    const c = m.indexOf(':');
    if (c > 0 && RUNTIMES.has(m.slice(0, c))) m = m.slice(c + 1);
    return m;
  }
  function modelMaker(id, offeredBy) {
    const m = bareId(id);
    const slash = m.indexOf('/');
    if (slash > 0) {
      const v = m.slice(0, slash);
      const k = VENDOR[v];
      return k ? { id: k, label: MAKERS[k] } : { id: 'vendor:' + v, label: v[0].toUpperCase() + v.slice(1) };
    }
    const bare = m.split(':')[0];
    for (const [re, k] of FAMILY) if (re.test(bare)) return { id: k, label: MAKERS[k] };
    return { id: 'provider:' + offeredBy.name, label: offeredBy.label };
  }
  // §3.3: one row per model whatever engine serves it. `vendor/` goes, `:tag` becomes `-tag`
  // (`:latest` goes), dots become dashes: gpt-oss:20b and openai/gpt-oss-20b are one key.
  function mergeKey(id) {
    let m = bareId(id);
    const slash = m.indexOf('/');
    if (slash > 0) m = m.slice(slash + 1);
    m = m.replace(/:latest$/, '').replace(/:/g, '-').replace(/\./g, '-').replace(/-\d{8}(?=\[|$)/, '');
    return m;
  }
  const DATE8 = /^\d{8}$/;
  // §3.4: family = the key without its version run; version = the first run of bare numbers.
  function familyVersion(key) {
    const base = key.replace(/\[[^\]]*\]$/, '');
    const words = base.split('-').filter((w) => !DATE8.test(w));
    const at = words.findIndex((w) => /^\d+$/.test(w));
    if (at < 0) return { family: base, version: null };
    let end = at;
    while (end < words.length && end - at < 2 && /^\d+$/.test(words[end])) end++;
    const version = words.slice(at, end).map(Number);
    const family = words.slice(0, at).concat(words.slice(end)).join('-') + (key.match(/\[[^\]]*\]$/)?.[0] ?? '');
    return { family, version };
  }
  const cmpV = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };

  // §3.6: one label rule for every maker but Anthropic (which keeps today's rule).
  const UPPER = new Set(['glm', 'it', 'moe', 'xs', 'er', 'dbrx', 'oss']);
  const NAMES = { deepseek: 'DeepSeek', qwen: 'Qwen', nvidia: 'NVIDIA', ibm: 'IBM' };
  const MMDD = /^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;
  function claudeLabel(id) {
    const m = bareId(id).replace(/\[1m\]$/, '').replace(/-\d{8}$/, '').replace(/\./g, '-');
    const p = m.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
    if (!p) return m;
    return p[1][0].toUpperCase() + p[1].slice(1) + ' ' + p[2] + (p[3] ? '.' + p[3] : '');
  }
  function modelLabel(id, info) {
    if (info && info.label) return info.label;
    let m = bareId(id);
    const slash = m.indexOf('/');
    const hadVendor = slash > 0;
    if (hadVendor) m = m.slice(slash + 1);
    if (/^claude-/.test(m)) return claudeLabel(m);
    let suffix = '';
    m = m.replace(/\[([a-z0-9]+)\]$/i, (_, t) => { suffix = ` (${t})`; return ''; });
    let tag = '';
    const c = m.indexOf(':');
    if (c > 0) { tag = m.slice(c + 1); m = m.slice(0, c); }
    let words = m.split('-');
    if (tag && tag !== 'latest') words.push(tag);
    while (words.length > 1 && (DATE8.test(words[words.length - 1]) || MMDD.test(words[words.length - 1]))) words.pop();
    if (words.length > 2 && /^\d{4}$/.test(words[words.length - 1]) && /^(0[1-9]|1[0-2])$/.test(words[words.length - 2])) words.splice(-2, 2);
    if (!hadVendor && words.length > 1 && words[0] === 'zai') words.shift();
    if (/^o\d/.test(words[0])) return words.join('-') + suffix;
    const gpt = words[0] === 'gpt';
    if (gpt) words.shift();
    const out = words.map((w, i) => {
      if (/^\d+(\.\d+)?[bmk]$/i.test(w) || /^a\d+(\.\d+)?[bm]$/i.test(w) || /^\d+x\d+[bm]$/i.test(w)) return w.toUpperCase().replace('X', 'x');
      if (/^v\d/.test(w)) return w;
      if (i === 0 && NAMES[w]) return NAMES[w];
      if (UPPER.has(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
    if (gpt) return 'GPT-' + out[0] + (out.length > 1 ? ' ' + out.slice(1).join(' ') : '') + suffix;
    return out.join(' ') + suffix;
  }

  // The static window table of shared/context-window.ts (substring match, longest first).
  const WINDOWS = { 'claude-fable-5': '1M', 'claude-opus': '200K', 'claude-sonnet': '200K', 'claude-haiku': '200K', 'gpt-4o-mini': '128K', 'gpt-4o': '128K', 'gpt-4-1': '1M', 'gpt-4.1': '1M',
    'gpt-5-codex': '400K', 'gpt-5': '400K', 'o3-mini': '200K', 'o3': '200K', 'gemini-2-5-pro': '1M', 'gemini-2.5-pro': '1M' };
  function windowOf(id, declared) {
    if (declared) return declared >= 1e6 ? Math.round(declared / 1e6) + 'M' : Math.round(declared / 1000) + 'K';
    const l = id.toLowerCase();
    const k = Object.keys(WINDOWS).sort((a, b) => b.length - a.length).find((key) => l.includes(key));
    return k ? WINDOWS[k] : '';
  }

  // Build the catalog: rows merged by key, grouped by maker; each group gets its engine (§3.5).
  function buildCatalog(snapshot, opts = {}) {
    const topicsModels = new Set((snapshot.providers.find((p) => p.name === 'topics')?.models ?? []).map(mergeKey));
    const order = snapshot.providers.filter((p) => p.name !== 'topics').map((p) => p.name);
    const engines = snapshot.providers.filter((p) => p.name !== 'topics');
    const label = Object.fromEntries(engines.map((p) => [p.name, p.label]));
    const rows = new Map();
    for (const p of engines) {
      if (p.status !== 'ready') continue;
      for (const id of p.models) {
        if (/\[1m\]$/i.test(id) && p.models.includes(id.replace(/\[1m\]$/i, ''))) continue; // the 1M switch
        const key = mergeKey(id);
        let r = rows.get(key);
        if (!r) {
          const mk = modelMaker(id, p);
          r = { key, id, maker: mk.id, makerLabel: mk.label, engines: [], gen: null, label: modelLabel(id, p.modelInfo?.[id]), m1: p.models.includes(id + '[1m]'),
            win: windowOf(id, p.modelContextWindows?.[id]) };
          rows.set(key, r);
        }
        if (!r.engines.includes(p.name)) r.engines.push(p.name);
        const g = p.modelInfo?.[id]?.generation;
        if (g && !r.gen) r.gen = g;
        if (p.modelInfo?.[id]?.label) r.label = p.modelInfo[id].label;
      }
    }
    // generation: declared wins; otherwise newest version of each family of the same maker
    const all = [...rows.values()];
    for (const r of all) {
      if (r.gen) continue;
      const fv = familyVersion(r.key);
      if (!fv.version) { r.gen = 'current'; continue; }
      const newer = all.some((o) => o !== r && o.maker === r.maker && familyVersion(o.key).family === fv.family && familyVersion(o.key).version && cmpV(familyVersion(o.key).version, fv.version) > 0);
      r.gen = newer ? 'older' : 'current';
    }
    const groups = new Map();
    for (const r of all) {
      if (!groups.has(r.maker)) groups.set(r.maker, { maker: r.maker, label: r.makerLabel, rows: [], older: [] });
      (r.gen === 'older' ? groups.get(r.maker).older : groups.get(r.maker).rows).push(r);
    }
    // a ready engine with no models: «Automatico» row in its maker's group (§3.7)
    for (const p of engines) {
      if (p.status !== 'ready' || p.models.length) continue;
      const mk = p.maker ? { id: p.maker, label: MAKERS[p.maker] } : { id: 'provider:' + p.name, label: p.label };
      if (!groups.has(mk.id)) groups.set(mk.id, { maker: mk.id, label: mk.label, rows: [], older: [] });
      groups.get(mk.id).rows.unshift({ key: 'auto:' + p.name, auto: true, label: 'Automatico', engines: [p.name], win: '' });
    }
    // not-ready engines present in the snapshot: connect box of their maker (§4.6)
    for (const p of engines) {
      if (p.status === 'ready' || !p.maker) continue;
      if (opts.hidden?.includes(p.name)) continue;
      if (!groups.has(p.maker)) groups.set(p.maker, { maker: p.maker, label: MAKERS[p.maker], rows: [], older: [] });
      const g = groups.get(p.maker);
      (g.connect ??= []).push(p);
    }
    const saved = opts.saved; // {provider, key}
    const routeOn = opts.routeOn !== false;
    for (const g of groups.values()) {
      const served = [...new Set([...g.rows, ...g.older].flatMap((r) => r.engines))];
      g.engineList = order.filter((n) => served.includes(n));
      let eng = null;
      if (saved && [...g.rows, ...g.older].some((r) => r.key === saved.key)) eng = saved.provider;
      else if (served.includes(snapshot.defaultProvider)) eng = snapshot.defaultProvider;
      else eng = g.engineList[0] ?? null;
      g.engine = eng;
      const display = (r, e) => (routeOn && (e === 'claude-code') && topicsModels.has(r.key) ? 'Topics' : label[e]);
      g.display = eng ? (routeOn && eng === 'claude-code' ? 'Topics' : label[eng]) : null;
      for (const r of [...g.rows, ...g.older]) {
        const e = r.engines.includes(eng) ? eng : order.find((n) => r.engines.includes(n));
        r.engine = e;
        r.display = r.auto ? label[e] : display(r, e);
        r.via = r.auto ? null : (r.display !== g.display ? 'via ' + r.display : null);
      }
      g.rows.sort((a, b) => (a.auto ? -1 : b.auto ? 1 : 0));
    }
    // columns: Anthropic, OpenAI, Google fixed; the rest stack in the fourth, by rows then name
    const list = [...groups.values()];
    const fixed = FIXED.map((m) => list.find((g) => g.maker === m)).filter(Boolean);
    const rest = list.filter((g) => !FIXED.includes(g.maker)).sort((a, b) => (b.rows.length + b.older.length) - (a.rows.length + a.older.length) || a.label.localeCompare(b.label));
    const cols = fixed.map((g) => [g]);
    if (fixed.length + rest.length <= 4) rest.forEach((g) => cols.push([g])); else if (rest.length) cols.push(rest);
    return { cols, groups: list, label };
  }

  // Providers level (§5.2): one list, static order, makers each card serves.
  const PROVIDER_ORDER = ['claude-code', 'topics', 'claude', 'codex', 'openai', 'gemini', 'jcode', 'openclaw', 'goose'];
  const STATIC_MAKER = { 'claude-code': 'anthropic', topics: 'anthropic', claude: 'anthropic', codex: 'openai', openai: 'openai', gemini: 'google' };
  function providerCards(snapshot) {
    const rank = (p) => { const i = PROVIDER_ORDER.indexOf(p.name); return i < 0 ? PROVIDER_ORDER.length + (p.name.startsWith('direct-') ? 0 : 1) : i; };
    return [...snapshot.providers].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)).map((p) => {
      const counts = {};
      for (const id of p.models) { if (/\[1m\]$/i.test(id)) continue; const mk = modelMaker(id, p); counts[mk.label] = (counts[mk.label] || 0) + 1; }
      let makers = Object.keys(counts);
      if (!makers.length && STATIC_MAKER[p.name]) makers = [MAKERS[STATIC_MAKER[p.name]]];
      const fixedFirst = ['Anthropic', 'OpenAI', 'Google'];
      makers.sort((a, b) => { const ia = fixedFirst.indexOf(a), ib = fixedFirst.indexOf(b); if (ia >= 0 || ib >= 0) return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib); return (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b); });
      return { name: p.name, label: p.label, status: p.status, models: p.models.filter((m) => !/\[1m\]$/i.test(m)).length, makers, p };
    });
  }

  root.MSEL = { modelMaker, mergeKey, familyVersion, modelLabel, windowOf, buildCatalog, providerCards, MAKERS };
})(typeof module !== 'undefined' ? module.exports : window);
