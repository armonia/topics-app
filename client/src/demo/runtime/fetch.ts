/* window.fetch stand-in: every /api/* call is answered from the scenario.
 *
 * ORDER MATTERS, and it is the order the original shim had: several patterns
 * are prefixes of others (/scripts/<id>/output before /scripts, /files/package-
 * scripts before /files, /providers/snapshot before /providers), and the generic
 * /projects rule still answers /all-boards/projects and /projects/icon for a
 * scenario that does not say otherwise. A URL no rule knows gets the generic
 * answer at the bottom; set window.__DEMO_TRACE__ = true before the bundle runs
 * to see which ones fall through. */
import type { LandingApi, LandingScenario } from "../scenario";
import type { gitApi } from "../../lib/api";

type Route = [RegExp, (u: string, api: LandingApi) => Response];

function json<T>(v: T): Response {
  return new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
}
function text(s: string): Response {
  return new Response(s, { status: 200, headers: { "content-type": "text/plain" } });
}
const pathParam = (u: string, re: RegExp): string => decodeURIComponent((u.match(re) || [])[1] || "");

/* GET /api/ui-state/<key> answers the server's envelope (server/routes/ui-state.ts
 * servedUiStateRow); only the theme is seeded, every other key reads as unset. */
interface UiStateEnvelope { value: unknown; payload_version?: number; server_seq?: number }
// The editor gutter asks it per open file; no scenario has uncommitted lines.
type LineChangesWire = Awaited<ReturnType<typeof gitApi.lineChanges>>;

function routes(theme: string): Route[] {
  return [
    // IDENTITY FIRST: refreshSession() asks it before anything renders, and an
    // answer without `paired` shows the pairing screen instead of the app.
    [/\/auth\/session\b/, (_u, a) => json(a.session)],
    // The address book and friendships answer with the objects the client reads,
    // never a bare []: `people.find` and `friends.map` throw on an array.
    [/\/app-settings(\?|$)/, (_u, a) => json(a.appSettings)],
    [/\/people(\?|$)/, (_u, a) => json(a.people)],
    [/\/friendships(\?|$)/, (_u, a) => json(a.friendships)],
    [/\/auth\/devices\b/, (_u, a) => json(a.devices)],
    [/\/auth\//, () => json({})],
    // text endpoints (the caller does response.text())
    [/\/git\/(diff|show)\b/, (_u, a) => text(a.gitDiff)],
    [/\/files\/content\b/, (_u, a) => text(a.fileContent)],
    [/\/api\/ui-state\/([^?]+)/, (u) => json<UiStateEnvelope>(
      pathParam(u, /\/api\/ui-state\/([^?]+)/) === "theme" ? { value: theme, payload_version: 1, server_seq: 0 } : { value: null })],
    [/\/ui-state\b/, () => json({ data: {}, meta: {} })],
    [/\/system\/status\b/, (_u, a) => json(a.systemStatus)],
    [/\/system\/dispatch-capacity\b/, (_u, a) => json(a.dispatchCapacity)],
    // The list only: any URL with /topics/ in it is a single-topic route.
    [/^(?!.*\/topics\/).*\/topics\b/, (_u, a) => json(a.topics)],
    [/\/git\/status\b/, (_u, a) => json(a.gitStatus)],
    [/\/git\/branches\b/, (_u, a) => json(a.gitBranches)],
    [/\/git\/remotes\b/, (_u, a) => json(a.gitRemotes)],
    [/\/git\/line-changes\b/, () => json<LineChangesWire>({ changes: [] })],
    [/\/git\/log\b/, (_u, a) => json(a.gitLog)],
    // `all-boards/tasks` is the cross-project feed App() spreads: a bare [] here
    // was a render-time «tasks is not iterable», i.e. a white demo.
    [/\/(all-)?boards\/tasks\b/, (_u, a) => json({ tasks: a.allBoardTasks })],
    [/\/boards\/[^/]+\/tasks\b/, (u, a) => json({ tasks: a.projectBoardTasks(pathParam(u, /\/boards\/([^/]+)\/tasks/)) })],
    [/\/boards\/[^/]+\/settings\b/, (u, a) => json(a.boardSettings(pathParam(u, /\/boards\/([^/]+)\/settings/)))],
    [/\/scripts\/[^/]+\/output\b/, (_u, a) => json(a.scriptOutput)],
    [/\/scripts\b/, (_u, a) => json({ scripts: a.scripts })],
    [/\/terminal\/sessions\b/, (_u, a) => json(a.terminalSessions)],
    [/\/providers\/snapshot\b/, (_u, a) => json(a.providersSnapshot)],
    [/\/providers\b/, (_u, a) => json(a.providers)],
    // MUST precede /projects: the client asks /api/usage/projects?range=, and
    // the old shim answered it with the project LIST instead of the usage.
    [/\/usage\//, (_u, a) => json(a.usage)],
    // A scenario without its own board index gets what the generic rule below
    // has always answered here (acme's Board generale relies on that).
    [/\/all-boards\/projects\b/, (_u, a) => json(a.boardProjects ?? { projects: a.projects })],
    [/\/projects\b/, (_u, a) => json({ projects: a.projects })],
    [/\/machines\b/, (_u, a) => json({ machines: a.machines })],
    [/\/worktrees\b/, (_u, a) => json({ worktrees: a.worktrees })],
    [/\/dashboard\/kpis\b/, (_u, a) => json(a.kpis)],
    // The pane asks per metric: hand back that metric's series so switching
    // metric visibly redraws instead of replaying one curve for everything.
    [/\/dashboard\/timeseries\b/, (u, a) => json({ points: a.timeseries((u.match(/metric=([^&]+)/) || [])[1] || "") })],
    // MUST precede /files: `.scripts` is a LIST (shared/project-scripts.ts).
    [/\/files\/package-scripts\b/, (_u, a) => json(a.packageScripts)],
    [/\/files\b/, (_u, a) => json(a.files)],
    [/\/history\//, (u, a) => json(a.history(pathParam(u, /\/history\/([^/?]+)/)))],
  ];
}

export function installFetchStub(scenario: LandingScenario): void {
  const api = scenario.api;
  const table = routes(scenario.seed.theme);
  const trace = () => (window as unknown as { __DEMO_TRACE__?: boolean }).__DEMO_TRACE__;
  const realFetch = window.fetch ? window.fetch.bind(window) : null;

  const stubFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = typeof input === "string" ? input : (input && (input as Request).url) || "";
    try {
      if (/\/api\//.test(u) || /^\/api/.test(u)) {
        for (const [re, answer] of table) if (re.test(u)) return Promise.resolve(answer(u, api));
        if (/snapshot|settings|status|state|kpis|summary|monitor|count|config/i.test(u)) {
          if (trace()) console.warn("[demo] fallback {} ←", u);
          return Promise.resolve(json({}));
        }
        if (trace()) console.warn("[demo] fallback [] ←", u);
        return Promise.resolve(json([]));
      }
      if (/\/preview\//.test(u)) return Promise.resolve(json({}));
    } catch (_e) { /* fall through */ }
    if (realFetch && !/\/(api|preview|ws)\b/.test(u)) return realFetch(input, init);
    return Promise.resolve(json({}));
  };
  window.fetch = stubFetch as typeof window.fetch;
}
