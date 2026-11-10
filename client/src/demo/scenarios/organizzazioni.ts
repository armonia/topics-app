/* organizzazioni: the same app, opened by someone who runs four organizations
 * instead of four repos. Each organization is a PROJECT (the model Topics
 * already has), its practices are board cards and its conversations are chats;
 * no component exists only for this demo.
 *   Principale (implicit) -> the Board generale alone: every organization's
 *                            cards in one board, each with its chip.
 *   Organizzazioni        -> the four project windows in a 2x2 grid, each
 *                            open on its two chats.
 * The data and the rule on what is true and what is an example live in
 * organizzazioni-data.ts. */
import type { LandingScenario } from "../scenario";
import type { HistoryMessage, Pane, ToolCall } from "../../types";
import { projectIdForPath } from "../../../../shared/board";
import { ORGANIZATIONS } from "./organizzazioni-data";
import { appSettings, boardSettings, boardTask, emptyUsage, idleDispatchCapacity, paneStore, projectPaneId, systemStatus, topic } from "./common";

const SPACE_ORGS = "space:orgs";
const BOARD_APP = "__board__";
/* A basename is what the sidebar and the board chip print, so the folder IS
 * the organization's name, spaces included. */
const orgPath = (name: string) => `/org/${name}`;

export function createOrganizationsScenario(): LandingScenario {
  const now = Date.now();
  const ISO = new Date(now - 4 * 60000).toISOString();
  // Older than twelve hours, so the card prints a numeric date in either language.
  const BOARD_ISO = new Date(now - 26 * 3600 * 1000).toISOString();

  const orgs = ORGANIZATIONS.map((org, i) => {
    const path = orgPath(org.name);
    const boardId = projectIdForPath(path);
    const tasks = org.cards.map((c, n) => boardTask({
      id: `o${i}-k${n}`, projectId: boardId, text: c.title, description: c.description,
      status: c.status, priority: c.priority, kanbanOrder: n, at: BOARD_ISO,
    }));
    const chats = org.chats.map((chat, n) => ({
      topic: topic({ id: `o${i}-t${n}`, name: chat.title, icon: "", color: org.color, at: ISO, projectPath: path }),
      // A reply every two minutes, the last one a few minutes ago.
      messages: chat.turns.map((turn, m): HistoryMessage => {
        const at = new Date(now - (chat.turns.length - m) * 2 * 60000).toISOString();
        const message: HistoryMessage = { id: `o${i}-t${n}-m${m}`, role: turn.role, content: turn.text, timestamp: at };
        if (turn.view) {
          const call: ToolCall = {
            id: `o${i}-t${n}-v${m}`, name: "show_view", args: { ...turn.view }, status: "success",
            result: "shown", detail: { type: "view", view: turn.view },
          };
          message.toolCalls = [call];
        }
        return message;
      }),
    }));
    return { org, path, boardId, pane: projectPaneId(path), tasks, chats };
  });

  const tasks = orgs.flatMap((o) => o.tasks);
  const topics = orgs.flatMap((o) => o.chats.map((c) => c.topic));
  const history = new Map(orgs.flatMap((o) => o.chats.map((c) => [c.topic.sessionKey, c.messages] as const)));
  const projectPanes: Pane[] = orgs.map((o) => ({
    id: o.pane, type: "project", projectPath: o.path, title: o.org.name, stableKey: o.pane, spaceId: SPACE_ORGS,
  }));
  const [a, b, c, d] = orgs.map((o) => "solo:" + o.pane);

  return {
    name: "organizzazioni",
    seed: {
      paneStore: paneStore([
        { id: BOARD_APP, type: "board", title: "Board generale", stableKey: BOARD_APP },
        ...projectPanes,
      ], {
        [SPACE_ORGS]: { id: SPACE_ORGS, name: "Organizzazioni", order: 0, updatedAt: 1748856600000 },
      }),
      focusedPaneId: BOARD_APP,
      gridLayouts: {
        [SPACE_ORGS]: {
          gridRows: [{ itemKeys: [a, b], widths: [0.5, 0.5] }, { itemKeys: [c, d], widths: [0.5, 0.5] }],
          gridRowHeights: [0.5, 0.5],
          soloCells: orgs.map((o) => [o.pane]),
          soloTopicIds: orgs.map((o) => o.pane),
        },
      },
      // Each window opens on its chats, the first one in front; the sidebar
      // stays closed because a quarter of the screen has no room for it.
      projects: orgs.map((o) => {
        const ids = o.chats.map((ch) => ch.topic.id);
        const group = `og${o.boardId}`;
        return {
          path: o.path,
          panes: { nonChatPanes: [], openChatTopicIds: ids, activeChatTopicId: ids[0] },
          layout: {
            groups: [{ id: group, paneIds: ids.map((id) => `chat:${id}`), activePaneId: `chat:${ids[0]}`, type: "chat" as const }],
            rows: [{ groupIds: [group], widths: [1] }], rowHeights: [1], sidebarCollapsed: true, focusedGroupId: group,
          },
        };
      }),
      theme: "dark",
      // Italian: the organizations work in Italian, and so does their data.
      settings: { sidebarCollapsed: false, language: "it" },
      sidebar: {
        expandedNodes: orgs.map((o) => "project:" + o.path),
        viewMode: "timeline", showArchived: false,
        showProjects: true, showChats: true, showTerminals: true,
        showProjectsArchived: false, showChatsArchived: false, browserExpanded: false,
      },
      gitStatusCache: {},
      sidebarSections: { files: false, git: false, processes: false },
    },
    api: {
      session: { paired: true, as: "loopback", name: "Questo Mac", deviceId: "demo-loopback", role: "owner", personId: null }, // allow-italian: the device name, in the scenario's language
      appSettings: appSettings(),
      people: { people: [] },
      friendships: { friends: [], incoming: [], outgoing: [] },
      devices: { devices: [] },
      gitDiff: "",
      fileContent: "",
      systemStatus: systemStatus(ISO, 0, topics.length),
      topics: { topics: Object.fromEntries(topics.map((t) => [t.id, t])), workspaceProjects: orgs.map((o) => o.path) },
      // Organizations are folders of documents, not repositories: this is what
      // the server answers for a folder that is not a repo.
      gitStatus: { branch: "", ahead: 0, behind: 0, files: [], lastCommit: null },
      gitBranches: [],
      gitRemotes: [],
      gitLog: [],
      allBoardTasks: tasks,
      projectBoardTasks: (boardId) => tasks.filter((t) => t.projectId === boardId),
      boardSettings: (boardId) => boardSettings(boardId),
      dispatchCapacity: idleDispatchCapacity(),
      boardProjects: { projects: orgs.map((o) => ({ projectId: o.boardId, name: o.org.name, path: o.path })), newProjectDir: null },
      scriptOutput: { output: "", offset: 0, done: true, status: "done" },
      scripts: [],
      terminalSessions: [],
      history: (sessionKey) => ({ messages: history.get(sessionKey) ?? [] }),
      providersSnapshot: { providers: [], defaultProvider: null, generatedAt: ISO },
      providers: { providers: [], default: null },
      projects: orgs.map((o, i) => ({
        id: `p-org-${i}`, name: o.org.name, path: o.path, slug: o.boardId, color: o.org.color, icon: null,
        archived: false, createdAt: ISO, updatedAt: ISO,
      })),
      machines: [],
      worktrees: [],
      // No usage numbers: there is no measured base for them (DATI-VERI).
      kpis: { throughputDay: 0, throughputWeek: 0, avgCycleTimeHours: 0, wipCount: 0, errorRate: 0, tokenSpendDay: 0, tokenSpendWeek: 0, approvalTurnaroundHours: 0, pendingApprovals: 0 },
      timeseries: () => [],
      packageScripts: { scripts: [], found: [], looked: [] },
      files: [],
      usage: emptyUsage(ISO),
    },
    sockets: {
      terminals: { transcripts: {}, fallback: [] },
      browser: { url: "about:blank", frameB64: "", snapshot: [] },
      main: {
        sessions: { type: "terminal:sessions", sessions: [] },
        presence: { type: "presence:windows", windows: [] },
      },
    },
  };
}
