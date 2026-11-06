/* The contract between the landing demo and the client it stands in for.
 *
 * The demo runs the REAL Topics client with no server: a boot script seeds the
 * browser storage and answers fetch and WebSocket from a scenario. Every value a
 * scenario hands over is typed here with the type the client READS, imported
 * from the client and from shared/. When an endpoint changes shape, the
 * scenario stops compiling instead of dying at render on the landing page,
 * which is what an untyped shim did more than once (the pairing gate, the
 * `scripts` list that used to be a map).
 *
 * Only routes the client actually calls are here. The mocks whose readers were
 * deleted (the old Agents pane, approvals, board memory, webhooks, tags, unread
 * counts) went with them: there is no type left to check them against. */
import type { AppBehaviorSettings, DashboardKPIs, FriendPerson, OpenClawContextResponse, PersonWithProfile, ProviderListEntry, ScriptOutput, ScriptProcessInfo, filesApi, gitApi } from '../lib/api';
import type { SessionWire } from '../lib/auth/session';
import type { BoardProjectRef, BoardSettings, BoardTask, DispatchCapacity } from '../lib/board';
import type { DevicesWire } from '../lib/devicesRead';
import type { SystemStatus } from '../hooks/useSystemStatus';
import type { gitCache } from '../hooks/useGitStatus';
import type { hydrateSidebarState } from '../hooks/useSidebarState';
import type { selectLocalSnapshot } from '../state/pane/selectors';
import type { PersistedLayoutState, PersistedTabState } from '../components/Layout/hooks/projectPersistence';
import type {
  AppSettings, FileNode, GitBranch, GitLogEntry, GitStatus, HistoryResponse, Machine, PanelGridRow, Project,
  ProvidersSnapshot, TerminalSessionInfo, ThemeMode, TopicsData, Worktree, WSPresenceWindowsMessage,
  WSTerminalSessionsMessage,
} from '../types';
import type { ProjectUsageResponse } from '../../../shared/usage-shapes';

/* ---- storage seeds ------------------------------------------------------ */

/** `pane-store-v2` as persistLocal writes it. Tombstones are left out: the reader
 * tolerates their absence and a fresh store has none. */
export type PaneStoreSeed = Omit<ReturnType<typeof selectLocalSnapshot>, 'tombstones' | 'tombstoneSeqs'> & {
  server_seq: number;
  savedAt: number;
  senderId: string;
};

/** `topics-panel-grid-layout[:<spaceId>]`, read by usePanelGridPersistence. */
export interface PanelGridSeed {
  gridRows: PanelGridRow[];
  gridRowHeights: number[];
  soloCells: string[][];
  soloTopicIds: string[];
}

/** One project window: its tabs and its inner split. */
export interface ProjectSeed {
  path: string;
  panes: PersistedTabState;
  layout: PersistedLayoutState;
}

export type GitCacheEntry = Parameters<typeof gitCache.set>[1];
export type SidebarSeed = Parameters<typeof hydrateSidebarState>[0];
/** ProjectSidebar's section switches (the plain-key fallback it still reads). */
export type SidebarSections = Record<'files' | 'git' | 'processes', boolean>;

export interface LandingSeed {
  paneStore: PaneStoreSeed;
  focusedPaneId: string;
  /** Keyed by space id; the default space is the bare key. */
  gridLayouts: Record<string, PanelGridSeed>;
  projects: ProjectSeed[];
  theme: ThemeMode;
  settings: Partial<AppSettings>;
  sidebar: SidebarSeed;
  /** sessionStorage `git-status-cache:<path>`. */
  gitStatusCache: Record<string, GitCacheEntry>;
  sidebarSections: SidebarSections;
}

/* ---- HTTP answers ------------------------------------------------------- */

/** GET /api/app-settings. `outputLanguage` is sent by the server and read by
 * lib/i18n.ts through its own cast, outside AppBehaviorSettings. */
export interface AppSettingsWire { settings: AppBehaviorSettings & { outputLanguage: string | null } }
export type GitRemote = Awaited<ReturnType<typeof gitApi.remotes>>[number];
export type PackageScriptsWire = Awaited<ReturnType<typeof filesApi.packageScripts>>;
export interface BoardProjectsWire { projects: BoardProjectRef[]; newProjectDir: string | null }

export interface LandingApi {
  session: SessionWire;
  appSettings: AppSettingsWire;
  people: { people: PersonWithProfile[] };
  friendships: { friends: FriendPerson[]; incoming: FriendPerson[]; outgoing: FriendPerson[] };
  devices: DevicesWire;
  /** text/plain bodies: git diff/show, and every file's content. */
  gitDiff: string;
  fileContent: string;
  systemStatus: SystemStatus;
  topics: TopicsData;
  gitStatus: GitStatus;
  gitBranches: GitBranch[];
  gitRemotes: GitRemote[];
  gitLog: GitLogEntry[];
  /** GET /api/all-boards/tasks, the Board generale. */
  allBoardTasks: BoardTask[];
  /** GET /api/boards/<boardId>/tasks, a project's own board. */
  projectBoardTasks: (boardId: string) => BoardTask[];
  boardSettings: (boardId: string) => BoardSettings;
  /** The board's load chip reads it; every agent idle shows no chip. */
  dispatchCapacity: DispatchCapacity;
  /** GET /api/all-boards/projects. Absent = the generic /projects answer, as acme has always had. */
  boardProjects?: BoardProjectsWire;
  scriptOutput: ScriptOutput;
  scripts: ScriptProcessInfo[];
  terminalSessions: TerminalSessionInfo[];
  /** POST /api/history/<sessionKey>, the chat transcript. */
  history: (sessionKey: string) => HistoryResponse;
  providersSnapshot: ProvidersSnapshot;
  providers: { providers: ProviderListEntry[]; default: string | null };
  projects: Project[];
  machines: Machine[];
  worktrees: Worktree[];
  kpis: DashboardKPIs;
  /** GET /api/dashboard/timeseries?metric=<metric>. */
  timeseries: (metric: string) => { date: string; value: number }[];
  packageScripts: PackageScriptsWire;
  files: FileNode[];
  usage: ProjectUsageResponse;
  openclawContext: OpenClawContextResponse;
}

/* ---- sockets ------------------------------------------------------------ */

export interface LandingSockets {
  /** /ws/terminal/<sessionId>: ANSI lines, CRLF added at emit time. */
  terminals: { transcripts: Record<string, readonly string[]>; fallback: readonly string[] };
  /** /ws/browser/<id>: the page the Browser pane replays (rrweb Meta + FullSnapshot). */
  browser: { url: string; frameB64: string; snapshot: readonly unknown[] };
  /** The main /ws socket. */
  main: { sessions: WSTerminalSessionsMessage; presence: WSPresenceWindowsMessage };
}

export interface LandingScenario {
  /** The value of `?scenario=`. */
  name: string;
  seed: LandingSeed;
  api: LandingApi;
  sockets: LandingSockets;
}
