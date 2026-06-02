import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";

type Pane = "browser" | "git" | "processes" | "kanban";

interface Topic {
  id: string; name: string; dot: "run" | "wait" | "idle"; count?: number;
  term: string[];
  branch: string;
  staged: { f: string; s: "M" | "A" | "D" }[];
  unstaged: { f: string; s: "M" | "A" | "D" | "?" }[];
}

const TOPICS: Topic[] = [
  { id: "app", name: "topics-app", dot: "run", count: 2, branch: "main",
    term: [
      '<p>~/topics-app</p> <c>claude</c> <m>"ship the v1.1 release"</m>',
      '<v>✻ Claude Code</v> <m>v2.1 · Opus 4.8 (1M context)</m>',
      '<m>● Reading project context…</m>',
      '<b>✱ Plan</b> <m>bump version · tag · build · publish</m>',
      '<m>  → package.json  v1.1.0</m>',
      '<m>  → .github/workflows/release.yml</m>',
      '<o>✓ Release workflow triggered</o> <m>mac · win · linux</m>',
      '<o>✓ Done.</o> <m>3 files changed · pushed to main</m>',
    ],
    staged: [{ f: "package.json", s: "M" }, { f: ".github/workflows/release.yml", s: "A" }],
    unstaged: [{ f: "CHANGELOG.md", s: "M" }, { f: "src/version.ts", s: "M" }] },
  { id: "landing", name: "landing", dot: "run", count: 3, branch: "feat/landing",
    term: [
      '<p>~/topics-app</p> <c>claude</c> <m>"build the marketing site"</m>',
      '<v>✻ Claude Code</v> <m>· editing landing/</m>',
      '<m>● Drafting hero + interactive demo…</m>',
      '<b>✱ Edit</b> <m>landing/demo-src/main.tsx</m>',
      '<o>✓ Preview ready on :5173</o>',
    ],
    staged: [{ f: "landing/index.html", s: "M" }],
    unstaged: [{ f: "landing/styles.css", s: "M" }, { f: "landing/demo/demo.js", s: "?" }] },
  { id: "auth", name: "auth", dot: "wait", branch: "fix/auth",
    term: [
      '<p>~/topics-app</p> <c>claude</c> <m>"add per-agent token hashing"</m>',
      '<v>✻ Claude Code</v> <m>· running tests</m>',
      '<o>✓ 24 tests · 0 failing</o>',
      '<w>? Apply the migration now?</w> <m>(waiting for you)</m>',
    ],
    staged: [{ f: "server/middleware/auth.ts", s: "M" }],
    unstaged: [{ f: "server/middleware/auth.test.ts", s: "A" }] },
  { id: "docs", name: "docs", dot: "idle", branch: "docs",
    term: [
      '<p>~/topics-app</p> <c>codex</c> <m>"refresh the README"</m>',
      '<v>✻ agent</v> <m>· any CLI works here</m>',
      '<o>✓ README, CONTRIBUTING updated</o>',
    ],
    staged: [],
    unstaged: [{ f: "README.md", s: "M" }, { f: "CONTRIBUTING.md", s: "M" }] },
];

const FILES = [
  { d: "client", open: true, kids: [
    { f: "index.html", z: "3.5k" }, { f: "App.tsx", z: "12k" }, { f: "main.tsx", z: "1.1k" },
  ] },
  { d: "server", open: true, kids: [
    { f: "server.ts", z: "44k" }, { f: "db.ts", z: "10k" }, { f: "routes/", z: "" },
  ] },
  { d: "landing", open: false, kids: [{ f: "index.html", z: "9k" }] },
  { d: "public", open: false, kids: [{ f: "assets/", z: "" }] },
];
const ROOT_FILES = [{ f: "README.md", z: "4.2k" }, { f: "package.json", z: "1.9k" }];

const PROCS = [
  { name: "bun server.ts", meta: ":3333 · 41 MB · 0.4% cpu", state: "run" },
  { name: "vite dev", meta: ":5173 · HMR ready in 312ms", state: "run" },
  { name: "claude-code", meta: "pid 4821 · streaming", state: "run" },
  { name: "tsc --watch", meta: "no errors", state: "idle" },
  { name: "playwright", meta: "exited 0", state: "done" },
];
const KANBAN: { col: string; tone: string; cards: string[] }[] = [
  { col: "Backlog", tone: "muted", cards: ["Telemetry opt-in", "i18n pass"] },
  { col: "Todo", tone: "blue", cards: ["Sign macOS build", "Empty states"] },
  { col: "In Progress", tone: "amber", cards: ["Ship v1.1", "Landing site"] },
  { col: "Review", tone: "violet", cards: ["Token hashing"] },
  { col: "Done", tone: "green", cards: ["Split panes", "Auto-update", "Grain pass"] },
];

function Term({ t }: { t: Topic }) {
  const [n, setN] = useState(t.term.length);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setN(t.term.length); return; }
    setN(0); let i = 0; let id: number;
    const tick = () => { i++; setN(i); if (i < t.term.length) id = window.setTimeout(tick, 300); };
    id = window.setTimeout(tick, 260);
    return () => clearTimeout(id);
  }, [t.id]);
  return (
    <div className="td-pane td-termpane">
      <div className="td-phead"><span className="td-dot run" /> Claude Code · Opus 4.8</div>
      <pre className="td-term">
        {t.term.slice(0, n).map((l, i) => <div key={i} dangerouslySetInnerHTML={{ __html: l }} />)}
        <span className="td-caret" />
      </pre>
      <div className="td-pfoot">Opus 4.8 (1M context) · {t.name}<span className="td-pfr">shift+tab to cycle</span></div>
    </div>
  );
}

function Browser() {
  return (
    <div className="td-pane">
      <div className="td-bt">
        <span className="td-bb">‹</span><span className="td-bb">›</span><span className="td-bb">⟳</span>
        <span className="td-addr">localhost:5173</span>
      </div>
      <div className="td-web">
        <div className="td-web-h">Dashboard</div>
        <div className="td-web-cards">{[0, 1, 2].map(i => <div key={i} className="td-wc"><span/><b/></div>)}</div>
        <div className="td-chart">{[58, 84, 47, 95, 71, 63, 88].map((h, i) => <i key={i} style={{ ["--h" as any]: h + "%" }} />)}</div>
      </div>
    </div>
  );
}

function Git({ t }: { t: Topic }) {
  const [staged, setStaged] = useState(true);
  const [unstaged, setUnstaged] = useState(true);
  const Row = ({ f, s }: { f: string; s: string }) => (
    <div className="td-grow"><span className={"td-gs s-" + s}>{s}</span><span className="td-gf">{f}</span></div>
  );
  return (
    <div className="td-pane">
      <div className="td-bt"><span className="td-branch">⎇ {t.branch}</span><span className="td-bb">↓</span><span className="td-bb">↑</span></div>
      <div className="td-gitbody">
        <button className="td-acc" onClick={() => setStaged(s => !s)}><span className={"td-chev" + (staged ? " open" : "")}>▸</span>Staged ({t.staged.length})</button>
        {staged && (t.staged.length ? t.staged.map((x, i) => <Row key={i} f={x.f} s={x.s} />) : <div className="td-empty">nothing staged</div>)}
        <button className="td-acc" onClick={() => setUnstaged(s => !s)}><span className={"td-chev" + (unstaged ? " open" : "")}>▸</span>Changes ({t.unstaged.length})</button>
        {unstaged && t.unstaged.map((x, i) => <Row key={i} f={x.f} s={x.s} />)}
      </div>
      <div className="td-commit"><div className="td-cinput">Commit message…</div><div className="td-cbtn">Commit</div></div>
    </div>
  );
}

function Procs() {
  return (
    <div className="td-pane">
      <div className="td-phead2">Processes</div>
      <div className="td-procs">
        {PROCS.map((p, i) => (
          <div className="td-proc" key={i}>
            <span className={"td-dot " + p.state} /><span className="td-pn">{p.name}</span><span className="td-pm">{p.meta}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Kanban() {
  return (
    <div className="td-pane">
      <div className="td-phead2">Board</div>
      <div className="td-kan">
        {KANBAN.map((c, i) => (
          <div className="td-kcol" key={i}>
            <div className={"td-kh tone-" + c.tone}>{c.col} <span>{c.cards.length}</span></div>
            {c.cards.map((card, j) => <div className={"td-kc tone-" + c.tone} key={j}>{card}</div>)}
          </div>
        ))}
      </div>
    </div>
  );
}

function FileTree() {
  const [open, setOpen] = useState<Record<string, boolean>>(Object.fromEntries(FILES.map(d => [d.d, d.open])));
  return (
    <div className="td-files">
      <div className="td-fhead">Tasks <span>▾</span></div>
      <div className="td-task-empty">No tasks yet</div>
      <div className="td-addtask">+ Add task</div>
      <div className="td-fhead">Files <span>▾</span></div>
      <div className="td-tree">
        {FILES.map((d) => (
          <div key={d.d}>
            <button className="td-dir" onClick={() => setOpen(o => ({ ...o, [d.d]: !o[d.d] }))}>
              <span className={"td-chev" + (open[d.d] ? " open" : "")}>▸</span>{d.d}
            </button>
            {open[d.d] && d.kids.map((k) => (
              <div className="td-file sub" key={k.f}>{k.f}<span>{k.z}</span></div>
            ))}
          </div>
        ))}
        {ROOT_FILES.map((k) => <div className="td-file" key={k.f}>{k.f}<span>{k.z}</span></div>)}
      </div>
      <div className="td-git-row">⎇ Git <span>▸</span></div>
    </div>
  );
}

const PANES: { id: Pane; label: string }[] = [
  { id: "browser", label: "Browser" }, { id: "git", label: "Git" },
  { id: "processes", label: "Processes" }, { id: "kanban", label: "Board" },
];

function Demo() {
  const [ti, setTi] = useState(0);
  const [pane, setPane] = useState<Pane>("browser");
  const t = TOPICS[ti];
  return (
    <div className="td">
      <div className="td-tabbar">
        <span className="td-logo">Topics <span className="td-chev open">▾</span></span>
        <div className="td-ttabs">
          {TOPICS.map((x, i) => (
            <button key={x.id} className={"td-ttab" + (i === ti ? " active" : "")} onClick={() => setTi(i)}>{x.name}</button>
          ))}
          <span className="td-ttab add">+</span>
        </div>
      </div>
      <div className="td-body">
        <aside className="td-side">
          <div className="td-search"><span className="td-si">⌕</span>Search<span className="td-kbd">⌘K</span></div>
          <div className="td-srow">Board</div>
          <div className="td-srow">Master <span className="td-badge">2</span></div>
          <div className="td-shead">TOPICS</div>
          {TOPICS.map((x, i) => (
            <button key={x.id} className={"td-topic" + (i === ti ? " active" : "")} onClick={() => setTi(i)}>
              <span className={"td-dot " + x.dot} />{x.name}{x.count ? <span className="td-tc">{x.count}</span> : null}
            </button>
          ))}
          <div className="td-sfoot"><span className="td-dot run" />41 MB · 60 fps</div>
        </aside>
        <FileTree />
        <div className="td-split">
          <Term t={t} />
          <div className="td-divider" />
          <div className="td-pane td-right">
            <div className="td-ptabs">
              {PANES.map((p) => (
                <button key={p.id} className={"td-ptab" + (p.id === pane ? " active" : "")} onClick={() => setPane(p.id)}>{p.label}</button>
              ))}
            </div>
            <div className="td-pbody">
              {pane === "browser" && <Browser />}
              {pane === "git" && <Git t={t} />}
              {pane === "processes" && <Procs />}
              {pane === "kanban" && <Kanban />}
            </div>
          </div>
        </div>
      </div>
      <div className="td-statusbar">
        <span className="td-dot run" /> Processes <span className="td-badge">1</span>
        <span className="td-sb-r">click a topic, a folder, or a pane tab to explore →</span>
      </div>
    </div>
  );
}

const el = document.getElementById("topics-demo");
if (el) createRoot(el).render(<Demo />);
