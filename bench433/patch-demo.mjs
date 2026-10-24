// patch-demo.mjs <path to client/src/demo/landing-boot.js>
// Bench-only edit of the landing demo, applied to a CI checkout (never
// committed): it opens in Italian, takes the theme from the URL, serves a
// providers snapshot (Claude Code, Codex and the Topics engine, ready) and
// opens a board TASK chat (a card topic: no runtime pinned, a Claude model,
// "Run in Topics" written ON) in its own space, so the composer's model menu
// can be opened. Each edit is anchored on exact text and fails loudly when the
// anchor is missing or not unique, so a drifted demo never ships a half-patch.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
let src = readFileSync(file, 'utf8');

function edit(name, anchor, replacement, { before = false } = {}) {
  const first = src.indexOf(anchor);
  if (first < 0) throw new Error(`anchor not found: ${name}`);
  if (src.indexOf(anchor, first + 1) >= 0) throw new Error(`anchor not unique: ${name}`);
  src = before
    ? src.slice(0, first) + replacement + anchor + src.slice(first + anchor.length)
    : src.slice(0, first) + replacement + src.slice(first + anchor.length);
}

// Language and theme.
edit('language', 'language: "en" }));', 'language: "it" }));');
edit('theme seed', 'set("theme", JSON.stringify("dark"));',
  'var LIGHT = /theme=light/.test(location.search);\n  set("theme", JSON.stringify(LIGHT ? "light" : "dark"));');
edit('dark class', 'document.documentElement.classList.add("dark");',
  'if (!LIGHT) document.documentElement.classList.add("dark");');

// Providers snapshot, the task chat pane and its space. The fleet of
// client/src/components/Shared/ModelSelector/fixtures.ts (measured 2026-10-02),
// with Claude Code listing claude-haiku-5-5 as current and claude-haiku-4-5 as
// older, as the server of d2c21279be declares them (claudeModelGenerations).
// The catalog drops the "topics" entry, so Claude Code is where the row comes
// from. Both trees get the same fleet.
const seed = String.raw`
  /* bench433: providers snapshot, a board task chat in its own space. */
  var TASK_CHAT = "t-task", SPACE_TASKS = "space:tasks";
  var PROVIDERS_SNAPSHOT = (function () {
    var at = "2026-10-02T00:00:00Z";
    var ccIds = ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-sonnet-5-5[1m]", "claude-haiku-5-5", "claude-haiku-4-5",
      "claude-fable-5-1", "claude-opus-4-8", "claude-opus-4-8[1m]", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]", "claude-haiku-3-5"];
    var older = ["claude-haiku-4-5", "claude-opus-4-8", "claude-opus-4-8[1m]", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]", "claude-haiku-3-5"];
    var engineIds = ["claude-opus-5-5[1m]", "claude-opus-5-5", "claude-opus-5[1m]", "claude-opus-5", "claude-sonnet-5-5[1m]", "claude-sonnet-5-5",
      "claude-sonnet-5", "claude-fable-5-1", "claude-fable-5", "claude-opus-4-8[1m]", "claude-opus-4-8", "claude-opus-4-6",
      "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    var codex = [
      ["gpt-6.1-sol", "GPT-6.1-Sol", "current", "Latest workhorse model for coding and everyday work."],
      ["gpt-6-astra", "GPT-6-Astra", "current", "Frontier intelligence for the most demanding work."],
      ["gpt-6-sol", "GPT-6-Sol", "current", "Previous generation workhorse model."],
      ["gpt-6-luna", "GPT-6-Luna", "current", "Fast and affordable model for easier tasks."],
      ["gpt-5.6-sol", "GPT-5.6-Sol", "older", "Older generation workhorse model."],
      ["gpt-5.6-terra", "GPT-5.6-Terra", "older", "Older balanced model for straightforward work."],
      ["gpt-5.6-luna", "GPT-5.6-Luna", "older", "Older fast and efficient model."],
      ["gpt-5.5", "GPT-5.5", "older", "Legacy coding model."],
    ];
    function entry(name, label, models, extra) {
      var e = { name: name, label: label, status: "ready", isDefault: false, models: models, capabilities: ["coding-tasks"], requirements: [], fetchedAt: at };
      for (var k in extra) e[k] = extra[k];
      return e;
    }
    var ccInfo = {};
    ccIds.forEach(function (id) { ccInfo[id] = { generation: older.indexOf(id) >= 0 ? "older" : "current" }; });
    var cxInfo = {}, cxWin = {};
    codex.forEach(function (c) { cxInfo[c[0]] = { label: c[1], generation: c[2], description: c[3] }; cxWin[c[0]] = 272000; });
    return {
      providers: [
        entry("claude-code", "Claude Code", ccIds, { isDefault: true, modelInfo: ccInfo }),
        entry("codex", "Codex", codex.map(function (c) { return c[0]; }), { modelContextWindows: cxWin, modelInfo: cxInfo }),
        entry("topics", "Topics", engineIds),
      ],
      defaultProvider: "claude-code",
      generatedAt: at,
    };
  })();
  set("providers-snapshot-cache", JSON.stringify(PROVIDERS_SNAPSHOT));
  (function seedTaskChat() {
    var snap = JSON.parse(localStorage.getItem("pane-store-v2"));
    snap.panes[TASK_CHAT] = { id: TASK_CHAT, type: "chat", topicId: TASK_CHAT, title: "Landing site rebuild", stableKey: TASK_CHAT, spaceId: SPACE_TASKS };
    snap.groups["group:default"].paneIds.push(TASK_CHAT);
    snap.spaces[SPACE_TASKS] = { id: SPACE_TASKS, name: "Task", order: 2, updatedAt: 1748856600000 };
    set("pane-store-v2", JSON.stringify(snap));
    set("pane-store-active-space", SPACE_TASKS);
    set("pane-store-focused-id", TASK_CHAT);
  })();
`;
edit('pane seed', '  set("pane-store-focused-id", PROJ_A);\n', '  set("pane-store-focused-id", PROJ_A);\n' + seed);

// The card topic: no runtime pinned, a Claude model, "Run in Topics" written ON.
const topicSeed = String.raw`  /* bench433: the topic of the "Landing site rebuild" card (a task chat). */
  (function () {
    var t = topic(TASK_CHAT, "Landing site rebuild", "🛠", "#7c6cff");
    t.provider = null; t.model = "claude-opus-5-5"; t.topicsRouting = true;
    TOPICS[TASK_CHAT] = t;
    TASKS.forEach(function (k) { if (k.id === "k6") k.assignedTopicId = TASK_CHAT; });
  })();
`;
edit('task topic', '  // Topics are secondary in this story', topicSeed, { before: true });

// Fetch mocks.
edit('mock settings', '        if (/\\/auth\\/devices\\b/.test(u))',
  '        if (/\\/app-settings\\b/.test(u)) return Promise.resolve(J({ ok: true, settings: { browserStoreReapEnabled: null, browserStoreReapAfterDays: null, firstRunDoneAt: "2026-01-01T00:00:00.000Z", language: "it" } }));\n' +
  '        if (/\\/friendships\\b/.test(u)) return Promise.resolve(J({ friends: [], incoming: [], outgoing: [] }));\n' +
  '        if (/\\/people\\b/.test(u)) return Promise.resolve(J({ people: [] }));\n',
  { before: true });
edit('mock theme', 'if (key === "theme") return Promise.resolve(J({ value: "dark", payload_version: 1, server_seq: 0 }));',
  'if (key === "theme") return Promise.resolve(J({ value: LIGHT ? "light" : "dark", payload_version: 1, server_seq: 0 }));');
edit('mock providers', 'if (/\\/providers\\/snapshot\\b/.test(u)) return Promise.resolve(J({ providers: [], defaultProvider: null, generatedAt: ISO }));',
  'if (/\\/providers\\/snapshot\\b/.test(u)) return Promise.resolve(J(PROVIDERS_SNAPSHOT));');
edit('mock topic get', '        if (/\\/topics\\/[^/]+\\/messages/.test(u))',
  '        var oneTopic = u.split("?")[0].match(/\\/api\\/topics\\/([^/]+)$/);\n' +
  '        if (oneTopic && TOPICS[decodeURIComponent(oneTopic[1])]) return Promise.resolve(J({ topic: TOPICS[decodeURIComponent(oneTopic[1])] }));\n',
  { before: true });

writeFileSync(file, src);
console.log('patched', file);
