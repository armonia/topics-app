import type { ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";

export interface WSData {
  id: string;
  focusedTopicId: string | null;
  lastPong: number;
  terminalId?: string;
  _termHandler?: { message: (data: string | Buffer | ArrayBuffer) => void; close: () => void };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  status?: 'pending' | 'running' | 'success' | 'error';
  result?: string;
  error?: string;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  media?: string[];
  partial?: boolean;
  streamedAt?: string;
  planStatus?: 'approved' | 'rejected';
}

export interface Topic {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  links: string[];
  sessionKey: string;
  color: string;
  icon: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  systemPrompt?: string;
  contextFiles?: string[];
  pinnedMessages?: string[];
  projectPath?: string;
  sortOrder?: number;
  autonomyLevel?: 'ask' | 'auto-apply' | 'yolo';
  disabledContextTemplates?: string[];
  disabledContextSources?: string[];
}

export interface TopicsData {
  topics: Record<string, Topic>;
}

export interface UnreadData {
  [topicId: string]: {
    lastReadAt: string;
    unreadCount: number;
  };
}

export interface ActiveStream {
  sessionKey: string;
  startedAt: string;
  isThinking: boolean;
  lastActivity: string;
  content: string;
  thinking: string;
  messageId: string;
  abortController?: AbortController;
}

export interface ErrorResponseOptions {
  log?: boolean;
  details?: unknown;
}

export interface AppContext {
  // Database
  db: Database;

  // Paths
  PORT: number;
  GATEWAY_URL: string;
  GATEWAY_TOKEN: string;
  TOPICS_FILE: string;
  UNREAD_FILE: string;
  PUBLIC_DIR: string;
  UPLOADS_DIR: string;
  CONTEXT_DIR: string;
  OPENCLAW_DIR: string;
  SESSIONS_DIR: string;
  MESSAGES_DIR: string;
  BASE_DIR: string;

  // State
  activeStreams: Map<string, ActiveStream>;
  wsClients: Set<ServerWebSocket<WSData>>;

  // Utils
  broadcast: (message: object, exclude?: ServerWebSocket<WSData>) => void;
  broadcastToAll: (message: object) => void;
  broadcastToTopic: (topicId: string, message: object, exclude?: ServerWebSocket<WSData>) => void;
  loadTopics: () => TopicsData;
  saveTopics: (data: TopicsData) => void;
  loadUnread: () => UnreadData;
  saveUnread: (data: UnreadData) => void;
  loadLocalMessages: (sessionKey: string) => StoredMessage[];
  saveLocalMessages: (sessionKey: string, msgs: StoredMessage[]) => void;
  appendLocalMessage: (sessionKey: string, role: "user" | "assistant", content: string) => StoredMessage;
  createPartialMessage: (sessionKey: string, role: "user" | "assistant") => StoredMessage;
  updateLastMessage: (sessionKey: string, updates: Partial<StoredMessage>) => StoredMessage | null;
  appendToLastMessage: (sessionKey: string, contentDelta: string, thinkingDelta?: string) => StoredMessage | null;
  finalizeLastMessage: (sessionKey: string) => StoredMessage | null;
  addToolCallToLastMessage: (sessionKey: string, toolCall: ToolCall) => StoredMessage | null;
  updateToolCallResult: (sessionKey: string, toolCallId: string, result: string, error?: string) => StoredMessage | null;
  startStream: (sessionKey: string, messageId: string, abortController?: AbortController) => void;
  updateStreamActivity: (sessionKey: string, isThinking?: boolean) => void;
  updateStreamContent: (sessionKey: string, content: string, thinking: string) => void;
  getStreamContent: (sessionKey: string) => { content: string; thinking: string; messageId: string } | null;
  endStream: (sessionKey: string) => void;
  isStreaming: (sessionKey: string) => ActiveStream | undefined;
  readJSON: (req: Request) => Promise<any>;
  json: (data: any, status?: number) => Response;
  matchRoute: (pathname: string, pattern: string) => Record<string, string> | null;
  errorResponse: (status: number, message: string, options?: ErrorResponseOptions) => Response;
  slugify: (name: string) => string;
  resolveSafePath: (inputPath: string, allowedBases?: string[]) => string | null;
  resolveProjectPath: (inputPath: string) => string | null;
  getMimeType: (filepath: string) => string;
  isPathAllowed: (filepath: string) => boolean;
  findNewMediaFiles: (sinceMs: number) => string[];
  updateLastMessageWithMedia: (sessionKey: string, mediaPaths: string[]) => void;
  atomicWriteJSON: (filepath: string, data: object) => void;
  logRequest: (method: string, path: string, status: number, startTime: number) => void;
  searchTranscripts: (query: string, limit?: number) => any[];
  getMessagesPath: (sessionKey: string) => string;

  // Constants
  ALLOWED_UPLOAD_MIMES: Set<string>;
}

export type RouteHandler = (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
