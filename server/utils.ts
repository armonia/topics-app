import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from "fs";
import { join, resolve, extname } from "path";
import type { ServerWebSocket } from "bun";
import type {
  WSData, StoredMessage, ToolCall, Topic, TopicsData, UnreadData,
  ActiveStream, ErrorResponseOptions, AppContext,
} from "./types";

export function createAppContext(baseDir: string): AppContext {
  const PORT = parseInt(process.env.PORT || "3333");
  const GATEWAY_URL = process.env.GATEWAY_URL || "http://127.0.0.1:18789";
  const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN!;

  const TOPICS_FILE = join(baseDir, "topics.json");
  const UNREAD_FILE = join(baseDir, "unread.json");
  const PUBLIC_DIR = join(baseDir, "public");
  const UPLOADS_DIR = join(baseDir, "uploads");
  const CONTEXT_DIR = join(baseDir, "context-files");
  const OPENCLAW_DIR = process.env.OPENCLAW_DIR || `${process.env.HOME}/.openclaw`;
  const SESSIONS_DIR = process.env.SESSIONS_DIR || `${OPENCLAW_DIR}/agents/main/sessions`;
  const MESSAGES_DIR = join(baseDir, "messages");

  mkdirSync(MESSAGES_DIR, { recursive: true });

  // State
  const activeStreams = new Map<string, ActiveStream>();
  const wsClients = new Set<ServerWebSocket<WSData>>();

  // --- Broadcast helpers ---
  function broadcast(message: object, exclude?: ServerWebSocket<WSData>) {
    const payload = JSON.stringify(message);
    for (const ws of wsClients) {
      if (ws !== exclude && ws.readyState === 1) {
        try { ws.send(payload); } catch (err) {
          console.error(`[WS] Send error to ${ws.data.id}:`, err);
        }
      }
    }
  }

  function broadcastToAll(message: object) {
    const payload = JSON.stringify(message);
    for (const ws of wsClients) {
      if (ws.readyState === 1) {
        try { ws.send(payload); } catch (err) {
          console.error(`[WS] Send error to ${ws.data.id}:`, err);
        }
      }
    }
  }

  function broadcastToTopic(topicId: string, message: object, exclude?: ServerWebSocket<WSData>) {
    const payload = JSON.stringify(message);
    for (const ws of wsClients) {
      if (ws !== exclude && ws.data.focusedTopicId === topicId && ws.readyState === 1) {
        try { ws.send(payload); } catch (err) {
          console.error(`[WS] Send error to ${ws.data.id}:`, err);
        }
      }
    }
  }

  // --- Atomic write ---
  function atomicWriteJSON(filepath: string, data: object): void {
    const tempPath = filepath + ".tmp." + process.pid + "." + Date.now();
    try {
      writeFileSync(tempPath, JSON.stringify(data, null, 2));
      renameSync(tempPath, filepath);
    } catch (err) {
      try { unlinkSync(tempPath); } catch {}
      throw err;
    }
  }

  // --- Topics/Unread ---
  function loadTopics(): TopicsData {
    try { return JSON.parse(readFileSync(TOPICS_FILE, "utf-8")); } catch { return { topics: {} }; }
  }
  function saveTopics(data: TopicsData) { atomicWriteJSON(TOPICS_FILE, data); }
  function loadUnread(): UnreadData {
    try { return JSON.parse(readFileSync(UNREAD_FILE, "utf-8")); } catch { return {}; }
  }
  function saveUnread(data: UnreadData) { atomicWriteJSON(UNREAD_FILE, data); }

  // --- Messages ---
  function getMessagesPath(sessionKey: string): string {
    const safe = sessionKey.replace(/[^a-zA-Z0-9_:-]/g, "_");
    return join(MESSAGES_DIR, safe + ".json");
  }

  function loadLocalMessages(sessionKey: string): StoredMessage[] {
    try { return JSON.parse(readFileSync(getMessagesPath(sessionKey), "utf-8")); } catch { return []; }
  }

  function saveLocalMessages(sessionKey: string, msgs: StoredMessage[]) {
    atomicWriteJSON(getMessagesPath(sessionKey), msgs);
  }

  function appendLocalMessage(sessionKey: string, role: "user" | "assistant", content: string): StoredMessage {
    const msgs = loadLocalMessages(sessionKey);
    const stored: StoredMessage = { id: crypto.randomUUID(), role, content, timestamp: new Date().toISOString() };
    msgs.push(stored);
    saveLocalMessages(sessionKey, msgs);
    return stored;
  }

  function createPartialMessage(sessionKey: string, role: "user" | "assistant"): StoredMessage {
    const msgs = loadLocalMessages(sessionKey);
    const stored: StoredMessage = { id: crypto.randomUUID(), role, content: "", timestamp: new Date().toISOString(), partial: true, streamedAt: new Date().toISOString() };
    msgs.push(stored);
    saveLocalMessages(sessionKey, msgs);
    return stored;
  }

  function updateLastMessage(sessionKey: string, updates: Partial<StoredMessage>): StoredMessage | null {
    const msgs = loadLocalMessages(sessionKey);
    if (msgs.length === 0) return null;
    const lastMsg = msgs[msgs.length - 1];
    Object.assign(lastMsg, updates);
    saveLocalMessages(sessionKey, msgs);
    return lastMsg;
  }

  function appendToLastMessage(sessionKey: string, contentDelta: string, thinkingDelta?: string): StoredMessage | null {
    const msgs = loadLocalMessages(sessionKey);
    if (msgs.length === 0) return null;
    const lastMsg = msgs[msgs.length - 1];
    if (contentDelta) lastMsg.content += contentDelta;
    if (thinkingDelta) lastMsg.thinking = (lastMsg.thinking || "") + thinkingDelta;
    saveLocalMessages(sessionKey, msgs);
    return lastMsg;
  }

  function finalizeLastMessage(sessionKey: string): StoredMessage | null {
    const msgs = loadLocalMessages(sessionKey);
    if (msgs.length === 0) return null;
    const lastMsg = msgs[msgs.length - 1];
    delete lastMsg.partial;
    delete lastMsg.streamedAt;
    saveLocalMessages(sessionKey, msgs);
    return lastMsg;
  }

  function addToolCallToLastMessage(sessionKey: string, toolCall: ToolCall): StoredMessage | null {
    const msgs = loadLocalMessages(sessionKey);
    if (msgs.length === 0) return null;
    const lastMsg = msgs[msgs.length - 1];
    if (!lastMsg.toolCalls) lastMsg.toolCalls = [];
    lastMsg.toolCalls.push(toolCall);
    saveLocalMessages(sessionKey, msgs);
    return lastMsg;
  }

  function updateToolCallResult(sessionKey: string, toolCallId: string, result: string, error?: string): StoredMessage | null {
    const msgs = loadLocalMessages(sessionKey);
    if (msgs.length === 0) return null;
    const lastMsg = msgs[msgs.length - 1];
    const tc = lastMsg.toolCalls?.find(t => t.id === toolCallId);
    if (tc) {
      tc.result = result;
      tc.error = error;
      tc.status = error ? 'error' : 'success';
      saveLocalMessages(sessionKey, msgs);
    }
    return lastMsg;
  }

  // --- Streams ---
  function startStream(sessionKey: string) {
    activeStreams.set(sessionKey, { sessionKey, startedAt: new Date().toISOString(), isThinking: false, lastActivity: new Date().toISOString() });
  }

  function updateStreamActivity(sessionKey: string, isThinking?: boolean) {
    const stream = activeStreams.get(sessionKey);
    if (stream) {
      stream.lastActivity = new Date().toISOString();
      if (isThinking !== undefined) stream.isThinking = isThinking;
    }
  }

  function endStream(sessionKey: string) { activeStreams.delete(sessionKey); }

  function isStreaming(sessionKey: string): ActiveStream | undefined {
    const stream = activeStreams.get(sessionKey);
    if (!stream) return undefined;
    const lastActivity = new Date(stream.lastActivity).getTime();
    const STREAM_TIMEOUT_MS = 3 * 60 * 1000;
    if (Date.now() - lastActivity > STREAM_TIMEOUT_MS) {
      console.log(`[isStreaming] Auto-expiring stale stream for ${sessionKey} (last activity: ${stream.lastActivity})`);
      activeStreams.delete(sessionKey);
      return undefined;
    }
    return stream;
  }

  // --- Request helpers ---
  async function readJSON(req: Request): Promise<any> {
    try { return await req.json(); } catch { return null; }
  }

  function json(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }

  function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
    const patternParts = pattern.split("/");
    const pathParts = pathname.split("/");
    if (patternParts.length !== pathParts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(":")) {
        params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (patternParts[i] !== pathParts[i]) {
        return null;
      }
    }
    return params;
  }

  function errorResponse(status: number, message: string, options: ErrorResponseOptions = {}): Response {
    const { log = true, details } = options;
    if (log && status >= 500) console.error(`[Error ${status}] ${message}`, details || "");
    else if (log && status >= 400) console.warn(`[Warn ${status}] ${message}`);
    const body: { error: string; details?: unknown } = { error: message };
    if (details !== undefined) body.details = details;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function slugify(name: string): string {
    return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  // --- Path resolution ---
  const ALLOWED_FILE_BASES = [OPENCLAW_DIR, process.env.HOME ? join(process.env.HOME, ".openclaw") : null].filter(Boolean) as string[];

  function resolveSafePath(inputPath: string, allowedBases: string[] = ALLOWED_FILE_BASES): string | null {
    if (!inputPath) return null;
    let expanded = inputPath;
    if (inputPath.startsWith("~")) {
      const home = process.env.HOME;
      if (!home) return null;
      expanded = inputPath.replace(/^~/, home);
    }
    const resolved = resolve(expanded);
    const isAllowed = allowedBases.some(base => {
      const normalizedBase = resolve(base);
      return resolved === normalizedBase || resolved.startsWith(normalizedBase + "/");
    });
    if (!isAllowed) {
      console.warn(`[Security] Path access denied: ${inputPath} -> ${resolved}`);
      return null;
    }
    return resolved;
  }

  function resolveProjectPath(inputPath: string): string | null {
    if (!inputPath) return null;
    let expanded = inputPath;
    if (inputPath.startsWith("~")) {
      const home = process.env.HOME;
      if (!home) return null;
      expanded = inputPath.replace(/^~/, home);
    }
    return resolve(expanded);
  }

  // --- Media helpers ---
  const ALLOWED_MEDIA_BASES = [
    `${OPENCLAW_DIR}/media/`,
    `${OPENCLAW_DIR}/workspace/`,
  ];

  function getMimeType(filepath: string): string {
    const ext = extname(filepath).toLowerCase().replace(".", "");
    const types: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm",
      mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
      aac: "audio/aac", opus: "audio/opus", pdf: "application/pdf",
      json: "application/json", txt: "text/plain", md: "text/markdown",
      csv: "text/csv", html: "text/html", css: "text/css", js: "application/javascript",
      zip: "application/zip", doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
    return types[ext] || "application/octet-stream";
  }

  function isPathAllowed(filepath: string): boolean {
    const resolved = resolve(filepath);
    if (resolved.startsWith(resolve(UPLOADS_DIR) + "/")) return true;
    if (resolved.startsWith(resolve(CONTEXT_DIR) + "/")) return true;
    return ALLOWED_MEDIA_BASES.some((base) => resolved.startsWith(base));
  }

  const MEDIA_SCAN_DIRS = [
    join(process.env.HOME || "", ".openclaw/media/browser"),
    join(process.env.HOME || "", ".openclaw/media"),
  ];
  const MEDIA_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "mp3", "wav", "ogg", "m4a", "aac", "opus", "webm", "mp4", "pdf"]);

  function findNewMediaFiles(sinceMs: number): string[] {
    const results: string[] = [];
    const seen = new Set<string>();
    for (const dir of MEDIA_SCAN_DIRS) {
      if (!existsSync(dir)) continue;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) continue;
          const ext = extname(entry.name).toLowerCase().replace(".", "");
          if (!MEDIA_EXTENSIONS.has(ext)) continue;
          const fullPath = join(dir, entry.name);
          if (seen.has(fullPath)) continue;
          seen.add(fullPath);
          try { const stat = statSync(fullPath); if (stat.mtimeMs >= sinceMs) results.push(fullPath); } catch {}
        }
      } catch {}
    }
    return results;
  }

  function updateLastMessageWithMedia(sessionKey: string, mediaPaths: string[]): void {
    const msgsPath = getMessagesPath(sessionKey);
    if (!existsSync(msgsPath)) return;
    try {
      const msgs = JSON.parse(readFileSync(msgsPath, "utf-8"));
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") {
          const mediaLines = mediaPaths.map((p: string) => `\nMEDIA:${p}`).join("");
          msgs[i].content += mediaLines;
          atomicWriteJSON(msgsPath, msgs);
          break;
        }
      }
    } catch (err) {
      console.warn(`[Media] Failed to update message with media for ${sessionKey}:`, err);
    }
  }

  function logRequest(method: string, path: string, status: number, startTime: number): void {
    const duration = Date.now() - startTime;
    const statusColor = status >= 500 ? "❌" : status >= 400 ? "⚠️" : "✓";
    console.log(`[HTTP] ${statusColor} ${method} ${path} ${status} ${duration}ms`);
  }

  // --- Search ---
  function searchTranscripts(query: string, limit = 50): any[] {
    const results: any[] = [];
    const lowerQuery = query.toLowerCase();
    const data = loadTopics();
    const sessionToTopic: Record<string, Topic> = {};
    for (const topic of Object.values(data.topics)) { sessionToTopic[topic.sessionKey] = topic; }
    const sessionsStorePath = join(SESSIONS_DIR, "sessions.json");
    if (!existsSync(sessionsStorePath)) return results;
    try {
      const store = JSON.parse(readFileSync(sessionsStorePath, "utf-8"));
      for (const [key, entry] of Object.entries(store) as any[]) {
        if (!entry?.sessionId) continue;
        if (!key.startsWith("topic:")) continue;
        if (!sessionToTopic[key]) continue;
        const jsonlPath = join(SESSIONS_DIR, entry.sessionId + ".jsonl");
        if (!existsSync(jsonlPath)) continue;
        const topic = sessionToTopic[key];
        try {
          const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const d = JSON.parse(line);
              if (d.type === "message" && d.message) {
                const msg = d.message;
                if (msg.role === "user" || msg.role === "assistant") {
                  let text = "";
                  if (typeof msg.content === "string") text = msg.content;
                  else if (Array.isArray(msg.content)) text = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
                  if (text.toLowerCase().includes(lowerQuery)) {
                    results.push({ sessionKey: key, topicId: topic?.id || null, topicName: topic?.name || key, topicIcon: topic?.icon || "💬", role: msg.role, content: text, timestamp: d.timestamp || null });
                    if (results.length >= limit) return results;
                  }
                }
              }
            } catch {}
          }
        } catch {}
      }
    } catch {}
    return results;
  }

  const ALLOWED_UPLOAD_MIMES = new Set([
    "text/plain", "text/markdown", "text/csv", "text/html", "text/css", "text/javascript",
    "application/json", "application/xml", "application/pdf", "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
    "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm",
  ]);

  return {
    PORT, GATEWAY_URL, GATEWAY_TOKEN,
    TOPICS_FILE, UNREAD_FILE, PUBLIC_DIR, UPLOADS_DIR, CONTEXT_DIR,
    OPENCLAW_DIR, SESSIONS_DIR, MESSAGES_DIR, BASE_DIR: baseDir,
    activeStreams, wsClients,
    broadcast, broadcastToAll, broadcastToTopic,
    loadTopics, saveTopics, loadUnread, saveUnread,
    loadLocalMessages, saveLocalMessages, appendLocalMessage,
    createPartialMessage, updateLastMessage, appendToLastMessage,
    finalizeLastMessage, addToolCallToLastMessage, updateToolCallResult,
    startStream, updateStreamActivity, endStream, isStreaming,
    readJSON, json, matchRoute, errorResponse, slugify,
    resolveSafePath, resolveProjectPath, getMimeType, isPathAllowed,
    findNewMediaFiles, updateLastMessageWithMedia, atomicWriteJSON, logRequest,
    searchTranscripts, getMessagesPath,
    ALLOWED_UPLOAD_MIMES,
  };
}
