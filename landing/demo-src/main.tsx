import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";

type Tab = "browser" | "processes" | "git" | "kanban";

interface Topic {
  id: string; name: string; dot: string;
  term: string[];
  browser: { url: string; title: string };
  procs: { name: string; meta: string; state: "run" | "idle" }[];
  git: { branch: string; files: { name: string; s: "M" | "A" | "D"; add: number; del: number }[] };
  kanban: { todo: string[]; doing: string[]; done: string[] };
}

const TOPICS: Topic[] = [
  {
    id: "ship", name: "ship-v1.1", dot: "blue",
    term: [
      '<b>~/app</b> <w>claude</w> <d>"ship the v1.1 release"</d>',
      '<v>✻ Claude Code</v> <d>· Opus 4.8 (1M context)</d>',
      '<d>● Reading project context…</d>',
      '<bl>✱ Plan</bl> <d>bump version · tag · build · publish</d>',
      '<d>  → package.json  v1.1.0</d>',
      '<o>✓ Release workflow triggered</o> <d>mac · win · linux</d>',
      '<o>✓ Done</o> <d>3 files changed · pushed to main</d>',
    ],
    browser: { url: "localhost:5173/changelog", title: "v1.1 — Changelog" },
    procs: [
      { name: "bun server.ts", meta: ":3333 · 41 MB", state: "run" },
      { name: "vite dev", meta: ":5173 · HMR", state: "run" },
      { name: "claude-code", meta: "pid 4821", state: "run" },
    ],
    git: { branch: "main", files: [
      { name: "package.json", s: "M", add: 2, del: 2 },
      { name: ".github/workflows/release.yml", s: "A", add: 64, del: 0 },
      { name: "CHANGELOG.md", s: "M", add: 18, del: 0 },
    ] },
    kanban: { todo: ["Sign macOS build", "Write release notes"], doing: ["Tag v1.1.0"], done: ["Build matrix", "Auto-update"] },
  },
  {
    id: "landing", name: "landing-site", dot: "violet",
    term: [
      '<b>~/app</b> <w>claude</w> <d>"add a hero with the product demo"</d>',
      '<v>✻ Claude Code</v> <d>· editing landing/</d>',
      '<d>● Drafting interactive demo…</d>',
      '<bl>✱ Edit</bl> <d>landing/demo-src/main.tsx</d>',
      '<o>✓ Preview ready</o> <d>open the browser pane →</d>',
    ],
    browser: { url: "localhost:5173", title: "Topics — landing preview" },
    procs: [
      { name: "vite dev", meta: ":5173 · HMR", state: "run" },
      { name: "tailwind", meta: "watch", state: "run" },
      { name: "tsc --watch", meta: "idle", state: "idle" },
    ],
    git: { branch: "feat/landing", files: [
      { name: "landing/index.html", s: "M", add: 31, del: 12 },
      { name: "landing/styles.css", s: "M", add: 88, del: 5 },
      { name: "landing/demo-src/main.tsx", s: "A", add: 210, del: 0 },
    ] },
    kanban: { todo: ["Mobile pass", "OG image"], doing: ["Interactive demo"], done: ["Hero", "Grain + aurora"] },
  },
  {
    id: "auth", name: "auth-hardening", dot: "teal",
    term: [
      '<b>~/app</b> <w>claude</w> <d>"add per-agent token hashing"</d>',
      '<v>✻ Claude Code</v> <d>· running tests</d>',
      '<d>● 24 tests · 0 failing</d>',
      '<o>✓ middleware/agent-auth.ts hardened</o>',
    ],
    browser: { url: "localhost:5173/settings/security", title: "Security settings" },
    procs: [
      { name: "bun test --watch", meta: "24 pass", state: "run" },
      { name: "bun server.ts", meta: ":3333", state: "run" },
    ],
    git: { branch: "fix/auth", files: [
      { name: "server/middleware/agent-auth.ts", s: "M", add: 22, del: 4 },
      { name: "server/middleware/agent-auth.test.ts", s: "A", add: 96, del: 0 },
    ] },
    kanban: { todo: ["Rate-limit login"], doing: ["Token hashing"], done: ["CSRF check", "Audit log"] },
  },
  {
    id: "docs", name: "docs-sweep", dot: "amber",
    term: [
      '<b>~/app</b> <w>codex</w> <d>"update the README and screenshots"</d>',
      '<v>✻ agent</v> <d>· any CLI works here</d>',
      '<o>✓ README, CONTRIBUTING refreshed</o>',
    ],
    browser: { url: "localhost:5173/docs", title: "Docs preview" },
    procs: [
      { name: "vite dev", meta: ":5173", state: "run" },
      { name: "markdownlint", meta: "clean", state: "idle" },
    ],
    git: { branch: "docs", files: [
      { name: "README.md", s: "M", add: 40, del: 22 },
      { name: "CONTRIBUTING.md", s: "M", add: 6, del: 1 },
    ] },
    kanban: { todo: ["API reference"], doing: ["README"], done: ["Quickstart"] },
  },
];

const TABS: { id: Tab; label: string }[] = [
  { id: "browser", label: "Browser" },
  { id: "processes", label: "Processes" },
  { id: "git", label: "Git" },
  { id: "kanban", label: "Kanban" },
];

function Terminal({ lines, topicId }: { lines: string[]; topicId: string }) {
  const [shown, setShown] = useState(lines.length);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(lines.length); return; }
    setShown(0);
    let i = 0; let timer: number;
    const tick = () => { i++; setShown(i); if (i < lines.length) timer = window.setTimeout(tick, 320); };
    timer = window.setTimeout(tick, 280);
    return () => clearTimeout(timer);
  }, [topicId]);
  return (
    <pre className="td-term">
      {lines.slice(0, shown).map((l, i) => (
        <div key={i} dangerouslySetInnerHTML={{ __html: l }} />
      ))}
      <span className="td-caret" />
    </pre>
  );
}

function RightPane({ t, tab }: { t: Topic; tab: Tab }) {
  if (tab === "browser") return (
    <div className="td-browser">
      <div className="td-urlbar"><span className="td-dotrow"><i/><i/><i/></span><span className="td-url">{t.browser.url}</span></div>
      <div className="td-page">
        <div className="td-page-h">{t.browser.title}</div>
        <div className="td-bars">{[62, 88, 47, 95, 73, 58].map((h, i) => <i key={i} style={{ ["--h" as any]: h + "%" }} />)}</div>
        <div className="td-skel"><span/><span/><span style={{ width: "60%" }}/></div>
      </div>
    </div>
  );
  if (tab === "processes") return (
    <div className="td-list">
      {t.procs.map((p, i) => (
        <div className="td-proc" key={i}>
          <span className={"td-pdot " + (p.state === "run" ? "run" : "idle")} />
          <span className="td-pname">{p.name}</span>
          <span className="td-pmeta">{p.meta}</span>
        </div>
      ))}
    </div>
  );
  if (tab === "git") return (
    <div className="td-list">
      <div className="td-gitbranch">⎇ {t.git.branch}</div>
      {t.git.files.map((f, i) => (
        <div className="td-gfile" key={i}>
          <span className={"td-gs s-" + f.s}>{f.s}</span>
          <span className="td-gname">{f.name}</span>
          <span className="td-gstat"><span className="add">+{f.add}</span> <span className="del">−{f.del}</span></span>
        </div>
      ))}
    </div>
  );
  return (
    <div className="td-kanban">
      {([["Todo", t.kanban.todo], ["Doing", t.kanban.doing], ["Done", t.kanban.done]] as const).map(([col, items]) => (
        <div className="td-kcol" key={col}>
          <div className="td-khead">{col}</div>
          {items.map((c, i) => <div className={"td-card" + (col === "Done" ? " done" : col === "Doing" ? " hot" : "")} key={i}>{c}</div>)}
        </div>
      ))}
    </div>
  );
}

function Demo() {
  const [topic, setTopic] = useState(0);
  const [tab, setTab] = useState<Tab>("browser");
  const t = TOPICS[topic];
  return (
    <div className="td">
      <div className="td-bar">
        <span className="td-traffic"><i/><i/><i/></span>
        <div className="td-tabs-top">
          {TOPICS.map((x, i) => (
            <button key={x.id} className={"td-ttab" + (i === topic ? " active" : "")} onClick={() => setTopic(i)}>
              {i === topic && <span className="td-live" />}{x.name}
            </button>
          ))}
          <span className="td-ttab add">+</span>
        </div>
      </div>
      <div className="td-body">
        <aside className="td-side">
          <div className="td-search">⌘K <span>Search…</span></div>
          <div className="td-srow">Board</div>
          <div className="td-srow">Master <span className="td-badge">2</span></div>
          <div className="td-shead">TOPICS</div>
          {TOPICS.map((x, i) => (
            <button key={x.id} className={"td-topic" + (i === topic ? " active" : "")} onClick={() => setTopic(i)}>
              <span className={"td-tdot d-" + x.dot} />{x.name}
            </button>
          ))}
          <div className="td-sfoot"><span className="td-live" />41 MB · 60 fps</div>
        </aside>
        <section className="td-split-term">
          <div className="td-ptab"><span className="td-live" /> Claude Code · Opus 4.8</div>
          <Terminal lines={t.term} topicId={t.id} />
        </section>
        <section className="td-right">
          <div className="td-rtabs">
            {TABS.map((x) => (
              <button key={x.id} className={"td-rtab" + (x.id === tab ? " active" : "")} onClick={() => setTab(x.id)}>{x.label}</button>
            ))}
          </div>
          <div className="td-rpane"><RightPane t={t} tab={tab} /></div>
        </section>
      </div>
      <div className="td-foot">
        <span>⎇ {t.git.branch}</span><span className="td-live" /><span>2 agents</span>
        <span className="td-fright">click a topic or a tab to explore →</span>
      </div>
    </div>
  );
}

const el = document.getElementById("topics-demo");
if (el) createRoot(el).render(<Demo />);
