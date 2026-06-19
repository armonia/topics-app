import { useState } from "react";
import { ToastProvider, ToastOutlet } from "../components/Shared/Toast";
import { GitChanges } from "../components/Project/GitChanges";
import { ProcessLogPane } from "../components/Project/ProcessLogPane";
import { gitCache } from "../hooks/useGitStatus";

const PROJECT = "/demo/topics-app";

// Seed the git cache so GitChanges has gitStatus.files on its very first render
// (the component reads gitStatus?.files.map without guarding .files).
gitCache.set(PROJECT, {
  status: {
    branch: "main",
    lastCommit: { hash: "a1b2c3d", message: "feat: cross-platform release", author: "you", ago: "2 min ago" },
    files: [
      { path: "package.json", status: "M" },
      { path: ".github/workflows/release.yml", status: "A" },
      { path: "client/src/App.tsx", status: "M" },
      { path: "CHANGELOG.md", status: "M" },
      { path: "server/routes/release.ts", status: "??" },
    ],
    ahead: 1, behind: 0,
  },
  remotes: [],
});
type Tab = "browser" | "git" | "processes";

const TOPICS = [
  { n: "ship-v1.1", c: "#4d7cff", on: true },
  { n: "landing", c: "#8b6cff", on: true },
  { n: "auth", c: "#22d3ee", on: false },
  { n: "docs", c: "#f5a524", on: false },
];
const TERM = [
  ["~/topics-app", "claude", '"ship the v1.1 release"'],
  ["", "✻ Claude Code", "Opus 4.8 (1M context)"],
  ["", "● Reading project context…", ""],
  ["", "✱ Plan", "bump · tag · build · publish"],
  ["", "✓ Release workflow triggered", "mac · win · linux"],
  ["", "✓ Done", "3 files changed · pushed to main"],
];

function Shell() {
  const [tab, setTab] = useState<Tab>("browser");
  const [topic, setTopic] = useState(0);
  const TABS: { id: Tab; label: string }[] = [
    { id: "browser", label: "Browser" }, { id: "git", label: "Git" },
    { id: "processes", label: "Processes" },
  ];
  return (
    <div className="h-screen w-screen flex flex-col bg-app-bg text-app-text overflow-hidden text-[13px]">
      {/* tab bar */}
      <div className="flex items-center gap-3 px-3 h-9 border-b border-app-border flex-shrink-0">
        <span className="font-semibold">Topics</span>
        <div className="flex gap-0.5 overflow-hidden">
          {TOPICS.map((t, i) => (
            <button key={t.n} onClick={() => setTopic(i)}
              className={`text-[12px] font-mono px-2.5 py-1 rounded-t whitespace-nowrap ${i === topic ? "bg-app-hover text-app-text" : "text-app-text-muted hover:text-app-text-secondary"}`}>{t.n}</button>
          ))}
          <span className="text-[12px] text-app-text-muted px-2 py-1">+</span>
        </div>
      </div>
      <div className="flex flex-1 min-h-0">
        {/* sidebar */}
        <aside className="w-[150px] flex-shrink-0 border-r border-app-border flex flex-col p-2 gap-0.5 overflow-hidden">
          <div className="flex items-center gap-2 text-[11px] text-app-text-muted bg-app-surface border border-app-border rounded px-2 py-1.5 mb-2">⌕ Search<span className="ml-auto font-mono text-[9px] border border-app-border rounded px-1">⌘K</span></div>
          <div className="font-mono text-[9px] tracking-widest text-app-text-muted mt-3 mb-1 px-1">TOPICS</div>
          {TOPICS.map((t, i) => (
            <button key={t.n} onClick={() => setTopic(i)}
              className={`flex items-center gap-2 px-2 py-1.5 rounded text-[12.5px] w-full ${i === topic ? "bg-primary/15 text-app-text" : "text-app-text-secondary hover:bg-app-hover"}`}>
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: t.c, boxShadow: t.on ? `0 0 6px ${t.c}` : "none" }} />{t.n}
            </button>
          ))}
          <div className="mt-auto flex items-center gap-2 font-mono text-[10px] text-app-text-muted pt-2"><span className="w-1.5 h-1.5 rounded-full bg-green-500" />41 MB · 60 fps</div>
        </aside>

        {/* split: terminal | right pane */}
        <div className="flex flex-1 min-w-0">
          {/* terminal (faithful — the real one needs a live PTY/ws) */}
          <section className="flex-1 min-w-0 flex flex-col border-r border-app-border" style={{ background: "hsl(225 22% 7%)" }}>
            <div className="font-mono text-[11px] text-app-text-secondary px-3 py-2 border-b border-app-border flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Claude Code · Opus 4.8</div>
            <pre className="flex-1 font-mono text-[11.5px] leading-[1.7] p-3 m-0 overflow-hidden" style={{ color: "#cfd6e6" }}>
              {TERM.map(([p, c, m], i) => (
                <div key={i}>
                  {p && <span style={{ color: "#5fd0c4" }}>{p}</span>}{p && " "}
                  <span style={{ color: c.startsWith("✓") ? "#4ade80" : c.startsWith("✱") ? "#6ea8ff" : c.startsWith("✻") ? "#c084fc" : "#fff" }}>{c}</span>
                  {m && <span style={{ color: "#7d838d" }}> {m}</span>}
                </div>
              ))}
              <span className="inline-block w-[7px] h-[1em] align-text-bottom animate-pulse" style={{ background: "#5fd0c4" }} />
            </pre>
          </section>

          {/* right pane: REAL components */}
          <section className="flex-1 min-w-0 flex flex-col">
            <div className="flex gap-1 px-2 py-1.5 border-b border-app-border bg-app-surface flex-shrink-0">
              {TABS.map((t) => (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={`text-[11.5px] px-3 py-1 rounded ${tab === t.id ? "bg-primary/20 text-app-text" : "text-app-text-muted hover:text-app-text-secondary"}`}>{t.label}</button>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {tab === "git" && <GitChanges projectPath={PROJECT} />}
              {tab === "processes" && <ProcessLogPane processId="p1" scriptName="dev:server" />}
              {tab === "browser" && (
                <div className="h-full flex flex-col">
                  <div className="flex items-center gap-2 px-2 py-1.5 border-b border-app-border bg-app-elevated">
                    <span className="text-app-text-muted">‹ › ⟳</span>
                    <span className="flex-1 font-mono text-[10.5px] text-app-text-muted bg-app-surface border border-app-border rounded px-2 py-1">localhost:5173</span>
                  </div>
                  <div className="flex-1 p-4 flex flex-col gap-3" style={{ background: "#0c0e14" }}>
                    <div className="text-[15px] font-semibold text-app-text">Dashboard</div>
                    <div className="flex gap-2 items-end h-20">
                      {[58, 84, 47, 95, 71, 63, 88].map((h, i) => <div key={i} className="flex-1 rounded-t" style={{ height: `${h}%`, background: "linear-gradient(180deg,#5e9bff,#0066ff)", opacity: .85 }} />)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      <div className="flex items-center gap-2 font-mono text-[10.5px] text-app-text-muted px-3 py-1.5 border-t border-app-border flex-shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Processes <span className="text-[10px] bg-primary/20 text-primary rounded px-1.5">1</span>
        <span className="ml-auto text-primary">click a topic or a pane tab to explore →</span>
      </div>
    </div>
  );
}

export default function Demo() {
  return (
    <ToastProvider>
      <Shell />
      <ToastOutlet fixed />
    </ToastProvider>
  );
}
