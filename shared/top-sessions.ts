/** Wire shape of `GET /api/usage/top-sessions`: the heaviest sessions of the last 24 hours. */
export type TopSessionOrigin = "desktop" | "cli" | "topics";

export interface TopSession {
  id: string;
  /** Custom title, else the first prompt; empty when the transcript has neither. */
  title: string;
  origin: TopSessionOrigin;
  cwd: string | null;
  model: string;
  /** Weighted tokens of the last 24 hours, subagents included. */
  points24h: number;
  /** Part (0..1) of all the weighted tokens of the last 7 days. */
  weekShare: number;
  /** Average context (input + cache) per turn, in tokens. */
  avgContext: number;
  /** How long ago the session started, in ms. */
  openMs: number;
  shareOfProject: number;
  /** One session does at least half of a project that has several. */
  dominatesProject: boolean;
  /** Open for more than 24 h and doing at least half of everything. */
  hog: boolean;
}

export interface TopSessionsResult {
  generatedAt: string;
  sessions: TopSession[];
}
