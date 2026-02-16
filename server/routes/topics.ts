import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import type { AppContext, RouteHandler, ToolCall, Topic } from "../types";
import { appendUsageRecord } from "../usage/store";
import { loadMemoryForTopic } from "./memory";
import { calculateCost } from "../usage/pricing";

export function createTopicsRouter(ctx: AppContext): RouteHandler {
  const {
    GATEWAY_URL, GATEWAY_TOKEN, UPLOADS_DIR, CONTEXT_DIR, SESSIONS_DIR, MESSAGES_DIR,
    broadcastToAll, broadcast,
    loadTopics, saveTopics, loadUnread, saveUnread,
    loadLocalMessages, saveLocalMessages, appendLocalMessage,
    createPartialMessage, updateLastMessage, addToolCallToLastMessage,
    startStream, updateStreamActivity, endStream, isStreaming,
    readJSON, json, matchRoute, errorResponse, slugify,
    resolveProjectPath, findNewMediaFiles, updateLastMessageWithMedia,
    searchTranscripts, getMessagesPath, atomicWriteJSON,
    ALLOWED_UPLOAD_MIMES,
  } = ctx;

  // Track which topics already had a browser navigate this session to avoid duplicate triggers
  const browserNavigatedTopics = new Set<string>();

  function detectAndBroadcastBrowserMarker(content: string, topic: Topic | null): string {
    if (!topic) return content;

    // 1. Check for explicit {{BROWSER:url}} markers (highest priority)
    const browserMatch = content.match(/\{\{BROWSER:(.*?)\}\}/);
    if (browserMatch) {
      let browserUrl = browserMatch[1];
      if (browserUrl.startsWith("file:///")) {
        browserUrl = `http://localhost:${process.env.PORT || 3333}/preview/${browserUrl.slice(8)}`;
      } else if (!browserUrl.startsWith("http")) {
        if (topic.projectPath) {
          const projectDir = resolveProjectPath(topic.projectPath);
          if (projectDir) browserUrl = `http://localhost:${process.env.PORT || 3333}/preview${join(projectDir, browserUrl)}`;
        }
      }
      console.log(`[Browser] Auto-navigate via marker: ${browserUrl}`);
      broadcastToAll({ type: "browser:navigate", topicId: topic.id, url: browserUrl });
      browserNavigatedTopics.add(topic.id);
      return content.replace(/\{\{BROWSER:.*?\}\}/g, '');
    }

    // 2. Fallback: detect localhost:PORT URLs in response (only once per topic per stream)
    //    Matches http://localhost:PORT, https://localhost:PORT, or bare localhost:PORT
    if (!browserNavigatedTopics.has(topic.id)) {
      const localhostMatch = content.match(/(?:https?:\/\/)?localhost:(\d{4,5})\b/);
      if (localhostMatch) {
        const port = parseInt(localhostMatch[1]);
        const appPort = parseInt(process.env.PORT || "3333");
        if (port !== appPort && port >= 3000 && port <= 65535) {
          const browserUrl = localhostMatch[0].startsWith("http") ? localhostMatch[0] : `http://${localhostMatch[0]}`;
          console.log(`[Browser] Auto-navigate via localhost detection: ${browserUrl}`);
          broadcastToAll({ type: "browser:navigate", topicId: topic.id, url: browserUrl });
          browserNavigatedTopics.add(topic.id);
        }
      }
    }

    return content;
  }

  /**
   * Detect projectPath from user + assistant messages without needing an LLM call.
   * Looks for explicit directory paths in the conversation.
   */
  function detectProjectPathFromMessages(messages: { role: string; content: string }[]): string | null {
    const allText = messages.map(m => m.content).join('\n');
    // Match explicit paths like /tmp/something, ~/projects/xxx, /Users/xxx/yyy
    const pathPatterns = [
      /(?:in|to|at|from|create|mkdir|cd)\s+(\/(?:tmp|Users|home|var|opt|srv)\/[\w./-]+)/gi,
      /(?:in|to|at|from|create|mkdir|cd)\s+(~\/[\w./-]+)/gi,
      /(?:project|app|directory|folder|dir)\s+(?:at|in|is)?\s*(\/[\w./-]+)/gi,
    ];
    const candidates: string[] = [];
    for (const pattern of pathPatterns) {
      let match;
      while ((match = pattern.exec(allText)) !== null) {
        let p = match[1].replace(/[.,;:!?)]+$/, ''); // strip trailing punctuation
        if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
        // Must be at least 2 levels deep
        if (p.split('/').filter(Boolean).length >= 2) {
          candidates.push(p);
        }
      }
    }
    // Return first candidate that looks like a project directory (has package.json, or was explicitly created)
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {}
    }
    // Even if directory doesn't exist yet, return the first candidate from user message
    const userText = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    for (const pattern of pathPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(userText)) !== null) {
        let p = match[1].replace(/[.,;:!?)]+$/, '');
        if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
        if (p.split('/').filter(Boolean).length >= 2) return p;
      }
    }
    return null;
  }

  /**
   * After first AI response: auto-detect projectPath and auto-name the topic (simple heuristic).
   * Runs server-side without needing a second LLM call.
   */
  function autoBindProject(topic: Topic): void {
    if (topic.projectPath) return; // already bound
    const localMsgs = loadLocalMessages(topic.sessionKey);
    if (localMsgs.length < 2) return; // need at least 1 user + 1 assistant
    const detected = detectProjectPathFromMessages(localMsgs);
    if (detected) {
      const topicsData = loadTopics();
      const t = topicsData.topics[topic.id];
      if (t && !t.projectPath) {
        t.projectPath = detected;
        t.updatedAt = new Date().toISOString();
        saveTopics(topicsData);
        broadcastToAll({ type: "topic:updated", topic: t });
        console.log(`[AutoBind] Detected projectPath for "${t.name}": ${detected}`);
      }
    }
  }

  function matchHistoryRoute(pathname: string): string | null {
    const prefix = "/api/history/";
    if (pathname.startsWith(prefix)) return decodeURIComponent(pathname.slice(prefix.length));
    return null;
  }

  // --- Tasks helpers (initialized once, not per-request) ---
  const TASKS_DIR = join(ctx.BASE_DIR, "tasks");
  mkdirSync(TASKS_DIR, { recursive: true });

  function loadTasks(projectId: string): any[] {
    const filepath = join(TASKS_DIR, projectId + ".json");
    try { return JSON.parse(readFileSync(filepath, "utf-8")); } catch { return []; }
  }

  function saveTasks(projectId: string, tasks: any[]) {
    atomicWriteJSON(join(TASKS_DIR, projectId + ".json"), tasks);
  }

  function getProjectIdForTopic(topicId: string): string | null {
    const data = loadTopics();
    const topic = data.topics[topicId];
    if (!topic?.projectPath) return null;
    const projectPath = topic.projectPath;
    const pathParts = projectPath.replace(/\/+$/, "").split("/");
    const dirName = pathParts[pathParts.length - 1] || "project";
    let hash = 0;
    for (let i = 0; i < projectPath.length; i++) { hash = ((hash << 5) - hash) + projectPath.charCodeAt(i); hash |= 0; }
    return dirName + "-" + Math.abs(hash).toString(36).slice(0, 6);
  }

  return async function topicsRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // --- Topics CRUD ---
    if (method === "GET" && pathname === "/api/topics") {
      const data = loadTopics();
      let fixed = false;
      for (const topic of Object.values(data.topics)) {
        if (topic.parentId && !data.topics[topic.parentId]) {
          console.log(`[Orphan Fix] Topic "${topic.name}" (${topic.id}) had broken parentId "${topic.parentId}" — moved to root`);
          topic.parentId = null;
          fixed = true;
        }
      }
      if (fixed) saveTopics(data);
      return json(data);
    }

    if (method === "POST" && pathname === "/api/topics") {
      const body = await readJSON(req);
      if (!body || !body.name) return json({ error: "name required" }, 400);
      const data = loadTopics();
      const id = crypto.randomUUID();
      const slug = slugify(body.name);
      const parentId = body.parentId || null;
      const topic: Topic = {
        id, name: body.name, slug, parentId, links: [],
        sessionKey: "", color: body.color || "#5865f2", icon: body.icon || "💬",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        archived: false, systemPrompt: body.systemPrompt || "",
        contextFiles: [], pinnedMessages: [],
        sortOrder: Object.keys(data.topics).length,
      };
      // Set projectPath if explicitly provided (e.g. creating from within a project)
      if (body.projectPath) {
        (topic as any).projectPath = body.projectPath;
      }

      data.topics[id] = topic;
      topic.sessionKey = "topic:" + id.slice(0, 8);
      saveTopics(data);
      broadcastToAll({ type: "topic:created", topic });
      return json(topic, 201);
    }

    // PATCH /api/topics/:id
    {
      const params = matchRoute(pathname, "/api/topics/:id");
      if (params && method === "PATCH") {
        const body = await readJSON(req);
        if (!body) return json({ error: "body required" }, 400);
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "not found" }, 404);
        if (body.name) { topic.name = body.name; topic.slug = slugify(body.name); }
        if (body.color !== undefined) topic.color = body.color;
        if (body.icon !== undefined) topic.icon = body.icon;
        if (body.parentId !== undefined) topic.parentId = body.parentId || null;
        if (body.systemPrompt !== undefined) topic.systemPrompt = body.systemPrompt;
        if (body.contextFiles !== undefined) topic.contextFiles = body.contextFiles;
        if (body.pinnedMessages !== undefined) topic.pinnedMessages = body.pinnedMessages;
        if (body.projectPath !== undefined) topic.projectPath = body.projectPath || undefined;
        if (body.autonomyLevel !== undefined) {
          const valid: Topic['autonomyLevel'][] = ['ask', 'auto-apply', 'yolo'];
          topic.autonomyLevel = valid.includes(body.autonomyLevel) ? body.autonomyLevel : 'ask';
        }
        if (body.disabledContextSources !== undefined) topic.disabledContextSources = body.disabledContextSources;
        if (body.disabledContextTemplates !== undefined) topic.disabledContextTemplates = body.disabledContextTemplates;
        topic.updatedAt = new Date().toISOString();
        saveTopics(data);
        broadcastToAll({ type: "topic:updated", topic });
        return json(topic);
      }

      if (params && method === "DELETE") {
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "not found" }, 404);
        let archive = true;
        try { const body = await req.json(); if (typeof body.archived === 'boolean') archive = body.archived; } catch {}
        topic.archived = archive;
        topic.updatedAt = new Date().toISOString();
        saveTopics(data);
        broadcastToAll({ type: "topic:archived", topic });
        return json(topic);
      }
    }

    // POST /api/topics/:id/link
    {
      const params = matchRoute(pathname, "/api/topics/:id/link");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body || !body.targetId) return json({ error: "targetId required" }, 400);
        const data = loadTopics();
        const topic = data.topics[params.id];
        const target = data.topics[body.targetId];
        if (!topic || !target) return json({ error: "not found" }, 404);
        if (!topic.links.includes(body.targetId)) topic.links.push(body.targetId);
        if (!target.links.includes(params.id)) target.links.push(params.id);
        topic.updatedAt = new Date().toISOString();
        target.updatedAt = new Date().toISOString();
        saveTopics(data);
        return json({ ok: true });
      }
    }

    // DELETE /api/topics/:id/link/:targetId
    {
      const params = matchRoute(pathname, "/api/topics/:id/link/:targetId");
      if (params && method === "DELETE") {
        const data = loadTopics();
        const topic = data.topics[params.id];
        const target = data.topics[params.targetId];
        if (!topic) return json({ error: "not found" }, 404);
        topic.links = topic.links.filter((l) => l !== params.targetId);
        if (target) target.links = target.links.filter((l) => l !== params.id);
        topic.updatedAt = new Date().toISOString();
        if (target) target.updatedAt = new Date().toISOString();
        saveTopics(data);
        return json({ ok: true });
      }
    }

    // POST /api/topics/reorder
    if (method === "POST" && pathname === "/api/topics/reorder") {
      const body = await readJSON(req);
      if (!body?.order || !Array.isArray(body.order)) return json({ error: "order array required" }, 400);
      const data = loadTopics();
      for (let i = 0; i < body.order.length; i++) {
        const topicId = body.order[i];
        if (data.topics[topicId]) data.topics[topicId].sortOrder = i;
      }
      saveTopics(data);
      broadcastToAll({ type: "topics:reordered", order: body.order });
      return json({ ok: true });
    }

    // GET /api/unread
    if (method === "GET" && pathname === "/api/unread") {
      return json(loadUnread());
    }

    // POST /api/topics/:id/read
    {
      const params = matchRoute(pathname, "/api/topics/:id/read");
      if (params && method === "POST") {
        const unread = loadUnread();
        unread[params.id] = { lastReadAt: new Date().toISOString(), unreadCount: 0 };
        saveUnread(unread);
        broadcastToAll({ type: "unread:updated", topicId: params.id, unreadCount: 0 });
        return json({ ok: true });
      }
    }

    // POST /api/topics/:id/system-message
    {
      const params = matchRoute(pathname, "/api/topics/:id/system-message");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.content) return json({ error: "content required" }, 400);
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "Topic not found" }, 404);
        const stored = appendLocalMessage(topic.sessionKey, "assistant", body.content);
        broadcastToAll({ type: "message", sessionKey: topic.sessionKey, message: { id: stored.id, role: "assistant", content: body.content, timestamp: stored.timestamp } });
        return json({ ok: true, message: stored });
      }
    }

    // POST /api/topics/:id/messages/:msgId/plan-status
    {
      const params = matchRoute(pathname, "/api/topics/:id/messages/:msgId/plan-status");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.status || !['approved', 'rejected'].includes(body.status)) {
          return json({ error: "status must be 'approved' or 'rejected'" }, 400);
        }
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "Topic not found" }, 404);
        const messages = loadLocalMessages(topic.sessionKey);
        const msg = messages.find(m => m.id === params.msgId);
        if (!msg) return json({ error: "Message not found" }, 404);
        msg.planStatus = body.status;
        saveLocalMessages(topic.sessionKey, messages);
        broadcastToAll({ type: "message:plan-status", topicId: params.id, messageId: params.msgId, planStatus: body.status });
        return json({ ok: true, planStatus: body.status });
      }
    }

    // --- Search ---
    if (method === "POST" && pathname === "/api/search") {
      const body = await readJSON(req);
      if (!body || !body.query) return json({ error: "query required" }, 400);
      return json({ results: searchTranscripts(body.query, body.limit || 50) });
    }

    // --- STT ---
    if (method === "POST" && pathname === "/api/stt") {
      try {
        const formData = await req.formData();
        const audioFile = formData.get("audio");
        if (!audioFile || typeof audioFile === "string") return json({ error: "audio file required" }, 400);
        const ts = Date.now();
        const tempWebm = `/tmp/stt-${ts}.webm`;
        const tempWav = `/tmp/stt-${ts}.wav`;
        const buffer = await (audioFile as File).arrayBuffer();
        writeFileSync(tempWebm, Buffer.from(buffer));
        const ffmpeg = Bun.spawnSync(["ffmpeg", "-i", tempWebm, "-ar", "16000", "-ac", "1", tempWav, "-y"], { timeout: 30000, stdout: "pipe", stderr: "pipe" });
        if (ffmpeg.exitCode !== 0) throw new Error(`ffmpeg conversion failed: ${ffmpeg.stderr.toString()}`);
        const whisper = Bun.spawnSync(["whisper-cli", "-m", "/tmp/ggml-large-v3-turbo.bin", "-l", "it", "-f", tempWav, "--no-timestamps"], { timeout: 60000, stdout: "pipe", stderr: "pipe" });
        if (whisper.exitCode !== 0) throw new Error(`Whisper failed: ${whisper.stderr.toString()}`);
        const transcript = whisper.stdout.toString().split("\n").filter((line: string) => !line.match(/^(whisper|ggml|system|main):/i) && line.trim()).join(" ").trim();
        try { unlinkSync(tempWebm); } catch {}
        try { unlinkSync(tempWav); } catch {}
        return json({ transcript });
      } catch (err: any) {
        console.error("STT error:", err);
        return json({ error: "STT failed: " + err.message }, 500);
      }
    }

    // --- TTS ---
    if (method === "POST" && pathname === "/api/tts") {
      const body = await readJSON(req);
      if (!body?.text) return json({ error: "text required" }, 400);
      if (!process.env.ELEVENLABS_API_KEY) return json({ error: "ELEVENLABS_API_KEY not configured" }, 500);
      try {
        const voiceId = body.voiceId || "iP95p4xoKVk53GoZ742B";
        const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "xi-api-key": process.env.ELEVENLABS_API_KEY || "" },
          body: JSON.stringify({ text: body.text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true } }),
        });
        if (!resp.ok) { const errText = await resp.text(); return json({ error: "TTS failed: " + errText }, 502); }
        const audioBuffer = await resp.arrayBuffer();
        return new Response(audioBuffer, { headers: { "Content-Type": "audio/mpeg", "Content-Length": audioBuffer.byteLength.toString() } });
      } catch (err: any) { return json({ error: "TTS error: " + err.message }, 500); }
    }

    // --- Context file upload ---
    if (method === "POST" && pathname === "/api/context-upload") {
      try {
        const formData = await req.formData();
        const file = formData.get("file");
        const topicId = formData.get("topicId") as string;
        if (!file || typeof file === "string") return json({ error: "file required" }, 400);
        if (!topicId) return json({ error: "topicId required" }, 400);
        const fileType = (file as File).type;
        if (!ALLOWED_UPLOAD_MIMES.has(fileType)) return json({ error: `File type not allowed: ${fileType}. Allowed types: text, documents, images, audio.` }, 400);
        const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
        if ((file as File).size > MAX_UPLOAD_SIZE) return json({ error: "File too large. Maximum size is 10MB." }, 400);
        const topicDir = join(CONTEXT_DIR, topicId);
        mkdirSync(topicDir, { recursive: true });
        const safeName = (file as File).name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const filename = `${Date.now()}-${safeName}`;
        const filepath = join(topicDir, filename);
        const buffer = await (file as File).arrayBuffer();
        writeFileSync(filepath, Buffer.from(buffer));
        const data = loadTopics();
        const topic = data.topics[topicId];
        if (topic) {
          if (!topic.contextFiles) topic.contextFiles = [];
          topic.contextFiles.push(filepath);
          topic.updatedAt = new Date().toISOString();
          saveTopics(data);
        }
        return json({ path: filepath, filename: (file as File).name, size: (file as File).size });
      } catch (err: any) { return json({ error: "Upload failed: " + err.message }, 500); }
    }

    // --- Chat proxy (streaming) ---
    if (method === "POST" && pathname === "/api/chat") {
      const body = await readJSON(req);
      if (!body) return json({ error: "body required" }, 400);
      // Reset browser navigate tracking for this topic so new URLs can trigger
      const topicsForReset = loadTopics();
      for (const t of Object.values(topicsForReset.topics)) {
        if (t.sessionKey === body.sessionKey) { browserNavigatedTopics.delete(t.id); break; }
      }
      const sessionKey = body.sessionKey;
      const planMode = body.planMode === true;
      const messages = body.messages;
      if (!messages || !Array.isArray(messages) || messages.length === 0) return json({ error: "messages array required" }, 400);

      const topicsData = loadTopics();
      let matchedTopic: Topic | null = null;
      for (const t of Object.values(topicsData.topics)) { if (t.sessionKey === sessionKey) { matchedTopic = t; break; } }

      const lastUserMsg = messages[messages.length - 1];
      if (lastUserMsg?.role === "user" && lastUserMsg?.content) {
        appendLocalMessage(sessionKey, "user", lastUserMsg.content);
        if (matchedTopic) {
          broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "user", content: lastUserMsg.content, preview: lastUserMsg.content.slice(0, 100) });
        }
      }

      const finalMessages = [...messages];
      if (matchedTopic) {
        const disabled = matchedTopic.disabledContextSources || [];
        const isSourceEnabled = (id: string) => !disabled.includes(id);

        if (matchedTopic.systemPrompt && isSourceEnabled("prompt:system")) {
          finalMessages.unshift({ role: "system", content: matchedTopic.systemPrompt });
        }
        if (matchedTopic.contextFiles && matchedTopic.contextFiles.length > 0) {
          const contextParts: string[] = [];
          for (const filePath of matchedTopic.contextFiles) {
            if (!isSourceEnabled(`file:${filePath}`)) continue;
            if (existsSync(filePath)) {
              try {
                const content = readFileSync(filePath, "utf-8");
                const fileName = filePath.split("/").pop() || filePath;
                contextParts.push(`--- File: ${fileName} ---\n${content}`);
              } catch (err) { console.warn(`[Context] Failed to read context file ${filePath}:`, err); }
            }
          }
          if (contextParts.length > 0) {
            const contextMsg = { role: "system", content: `Context files for this topic:\n\n${contextParts.join("\n\n")}` };
            const insertIdx = (matchedTopic.systemPrompt && isSourceEnabled("prompt:system")) ? 1 : 0;
            finalMessages.splice(insertIdx, 0, contextMsg);
          }
        }
        if (matchedTopic.projectPath) {
          const projectDir = resolveProjectPath(matchedTopic.projectPath);
          if (projectDir && existsSync(projectDir)) {
            const TEMPLATE_FILES = ["CLAUDE.md", "README.md", ".cursorrules", "AGENTS.md"];
            const disabledFiles = matchedTopic.disabledContextTemplates || [];
            const templateParts: string[] = [];
            for (const name of TEMPLATE_FILES) {
              if (disabledFiles.includes(name)) continue;
              let filePath = join(projectDir, name);
              let displayName = name;
              if (!existsSync(filePath) && name === "CLAUDE.md") {
                const altPath = join(projectDir, ".claude", "CLAUDE.md");
                if (existsSync(altPath)) { filePath = altPath; displayName = ".claude/CLAUDE.md"; }
              }
              if (existsSync(filePath)) {
                try {
                  const content = readFileSync(filePath, "utf-8");
                  templateParts.push(`--- Project file: ${displayName} ---\n${content}`);
                } catch (err) { console.warn(`[ContextTemplates] Failed to read ${filePath}:`, err); }
              }
            }
            if (templateParts.length > 0) {
              const templateMsg = { role: "system", content: `Project context files (from ${matchedTopic.projectPath}):\n\n${templateParts.join("\n\n")}` };
              const insertIdx = finalMessages.findIndex(m => m.role !== "system");
              finalMessages.splice(insertIdx >= 0 ? insertIdx : finalMessages.length, 0, templateMsg);
            }
          }
        }
        // Browser auto-navigate: instruct the AI to use structured markers
        const browserInstruction = { role: "system", content: `When you want to open a URL or file in the embedded browser panel, include the marker {{BROWSER:url}} in your response. Examples:
- After creating an HTML file: {{BROWSER:file:///path/to/file.html}}
- After starting a dev server: {{BROWSER:http://localhost:3000}}
- To show a webpage: {{BROWSER:https://example.com}}
The marker will be automatically processed and removed from the visible output. Do not mention the marker to the user.` };
        const browserInsertIdx = finalMessages.findIndex(m => m.role !== "system");
        finalMessages.splice(browserInsertIdx >= 0 ? browserInsertIdx : finalMessages.length, 0, browserInstruction);

        // Inject memory content into system prompt (respect disabled sources)
        if (isSourceEnabled("memory:global") || isSourceEnabled("memory:topic")) {
          const memoryContent = loadMemoryForTopic(ctx.BASE_DIR, matchedTopic.id, {
            includeGlobal: isSourceEnabled("memory:global"),
            includeTopic: isSourceEnabled("memory:topic"),
          });
          if (memoryContent) {
            const memoryMsg = { role: "system", content: memoryContent };
            const memInsertIdx = finalMessages.findIndex(m => m.role !== "system");
            finalMessages.splice(memInsertIdx >= 0 ? memInsertIdx : finalMessages.length, 0, memoryMsg);
          }
        }

        // Inject pinned messages as context
        if (isSourceEnabled("pinned:messages") && matchedTopic.pinnedMessages && matchedTopic.pinnedMessages.length > 0) {
          const localMsgs = loadLocalMessages(matchedTopic.sessionKey);
          const pinned = localMsgs.filter(m => matchedTopic.pinnedMessages!.includes(m.id));
          if (pinned.length > 0) {
            const pinnedContent = pinned.map(m => `[${m.role}]: ${m.content}`).join("\n\n");
            const pinnedMsg = { role: "system", content: `Pinned messages from this conversation (important context):\n\n${pinnedContent}` };
            const pinnedInsertIdx = finalMessages.findIndex(m => m.role !== "system");
            finalMessages.splice(pinnedInsertIdx >= 0 ? pinnedInsertIdx : finalMessages.length, 0, pinnedMsg);
          }
        }
      }

      // Plan Mode: prepend instruction to analyze and propose a plan instead of executing
      if (planMode) {
        const planInstruction = { role: "system", content: `IMPORTANT: You are in PLAN MODE. Analyze the user's request and provide a detailed implementation plan. Do NOT execute any changes yet. Format your response as follows:

## Plan

1. **Step title** — Description of what this step does
2. **Step title** — Description of what this step does
3. ...

## Summary
Brief summary of the approach and any considerations.

Wait for the user to approve the plan before executing any changes.` };
        const planInsertIdx = finalMessages.findIndex(m => m.role !== "system");
        finalMessages.splice(planInsertIdx >= 0 ? planInsertIdx : finalMessages.length, 0, planInstruction);
      }

      try {
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), 300000);
        const requestStartMs = Date.now();

        const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}`, "x-openclaw-session-key": sessionKey },
          body: JSON.stringify({ model: "openclaw", stream: true, messages: finalMessages }),
          signal: abortController.signal,
        });
        clearTimeout(timeoutId);

        if (!resp.ok) {
          const text = await resp.text();
          return new Response(text, { status: resp.status, headers: { "Content-Type": "application/json" } });
        }

        const contentType = resp.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await resp.json() as any;
          let content = data?.choices?.[0]?.message?.content || "";
          content = detectAndBroadcastBrowserMarker(content, matchedTopic);
          // Capture usage data from non-streaming response
          if (data?.usage) {
            const model = data.model || "unknown";
            const inputTokens = data.usage.prompt_tokens || 0;
            const outputTokens = data.usage.completion_tokens || 0;
            appendUsageRecord({
                timestamp: Date.now(),
                sessionKey,
                topicId: matchedTopic?.id,
                model,
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                costUsd: calculateCost(model, inputTokens, outputTokens),
              }).catch(err => console.warn("[Usage] Failed to record usage:", err));
          }
          if (content) appendLocalMessage(sessionKey, "assistant", content);
          if (matchedTopic) {
            broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", preview: content.slice(0, 100) });
            const unread = loadUnread();
            if (!unread[matchedTopic.id]) unread[matchedTopic.id] = { lastReadAt: new Date().toISOString(), unreadCount: 0 };
            unread[matchedTopic.id].unreadCount += 1;
            saveUnread(unread);
            broadcastToAll({ type: "unread:updated", topicId: matchedTopic.id, unreadCount: unread[matchedTopic.id].unreadCount });
          }
          setTimeout(() => {
            try {
              const newMedia = findNewMediaFiles(requestStartMs);
              if (newMedia.length > 0 && sessionKey) {
                updateLastMessageWithMedia(sessionKey, newMedia);
                broadcastToAll({ type: "message:media", sessionKey, topicId: matchedTopic?.id, media: newMedia });
              }
            } catch {}
          }, 500);
          // Auto-bind project path from conversation content (no LLM needed)
          if (matchedTopic && !matchedTopic.projectPath) {
            setTimeout(() => autoBindProject(matchedTopic!), 100);
          }
          const ssePayload = `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(content)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
          return new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
        }

        // Streaming
        const originalBody = resp.body!;
        let fullContent = "";
        let fullThinking = "";
        let isInThinking = false;
        let chunkCount = 0;
        let lastSaveChunk = 0;
        const SAVE_INTERVAL = 10;
        let streamUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;
        let streamModel: string = "unknown";
        const partialMsg = createPartialMessage(sessionKey, "assistant");
        startStream(sessionKey);
        broadcastToAll({ type: "stream:start", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id });

        const transform = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            const text = new TextDecoder().decode(chunk);
            const lines = text.split("\n");
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") {
                updateLastMessage(sessionKey, { content: fullContent, thinking: fullThinking || undefined, partial: undefined, streamedAt: undefined });
                // Record usage from streaming response
                if (streamUsage) {
                  const inputTokens = streamUsage.prompt_tokens || 0;
                  const outputTokens = streamUsage.completion_tokens || 0;
                  appendUsageRecord({
                      timestamp: Date.now(),
                      sessionKey,
                      topicId: matchedTopic?.id,
                      model: streamModel,
                      inputTokens,
                      outputTokens,
                      totalTokens: inputTokens + outputTokens,
                      costUsd: calculateCost(streamModel, inputTokens, outputTokens),
                    }).catch(err => console.warn("[Usage] Failed to record streaming usage:", err));
                }
                if (matchedTopic) {
                  endStream(sessionKey);
                  broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", preview: fullContent.slice(0, 100) });
                  broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id });
                  const unread = loadUnread();
                  if (!unread[matchedTopic.id]) unread[matchedTopic.id] = { lastReadAt: new Date().toISOString(), unreadCount: 0 };
                  unread[matchedTopic.id].unreadCount += 1;
                  saveUnread(unread);
                  broadcastToAll({ type: "unread:updated", topicId: matchedTopic.id, unreadCount: unread[matchedTopic.id].unreadCount });
                }
                setTimeout(() => {
                  try {
                    const newMedia = findNewMediaFiles(requestStartMs);
                    if (newMedia.length > 0 && sessionKey) {
                      updateLastMessageWithMedia(sessionKey, newMedia);
                      broadcastToAll({ type: "message:media", sessionKey, topicId: matchedTopic?.id, media: newMedia });
                    }
                  } catch {}
                }, 1000);
                // Auto-bind project path from conversation content (no LLM needed)
                if (matchedTopic && !matchedTopic.projectPath) {
                  setTimeout(() => autoBindProject(matchedTopic!), 500);
                }
                continue;
              }
              try {
                const parsed = JSON.parse(data);
                // Capture usage and model from stream chunks
                if (parsed.usage) streamUsage = parsed.usage;
                if (parsed.model) streamModel = parsed.model;
                const delta = parsed.choices?.[0]?.delta;
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (tc.function?.name) {
                      const toolCall: ToolCall = { id: tc.id || crypto.randomUUID(), name: tc.function.name, args: tc.function.arguments ? JSON.parse(tc.function.arguments) : {}, status: 'pending' };
                      addToolCallToLastMessage(sessionKey, toolCall);
                      broadcastToAll({ type: "stream:tool_call", sessionKey, topicId: matchedTopic?.id, toolCall });
                    }
                  }
                }
                if (delta?.content) {
                  const content = delta.content;
                  if (content.includes('<thinking>')) { isInThinking = true; updateStreamActivity(sessionKey, true); broadcastToAll({ type: "stream:thinking_start", sessionKey, topicId: matchedTopic?.id }); }
                  if (content.includes('</thinking>')) { isInThinking = false; updateStreamActivity(sessionKey, false); broadcastToAll({ type: "stream:thinking_end", sessionKey, topicId: matchedTopic?.id }); }
                  if (isInThinking) {
                    const cleaned = content.replace(/<\/?thinking>/g, '');
                    fullThinking += cleaned;
                    broadcastToAll({ type: "stream:thinking_chunk", sessionKey, topicId: matchedTopic?.id, content: cleaned });
                  } else {
                    const cleaned = content.replace(/<\/?thinking>/g, '');
                    if (cleaned) {
                      fullContent += cleaned;
                      broadcastToAll({ type: "stream:content_chunk", sessionKey, topicId: matchedTopic?.id, content: cleaned });
                      // Detect browser marker in accumulated content
                      fullContent = detectAndBroadcastBrowserMarker(fullContent, matchedTopic);
                    }
                  }
                  chunkCount++;
                  if (chunkCount - lastSaveChunk >= SAVE_INTERVAL) {
                    lastSaveChunk = chunkCount;
                    updateLastMessage(sessionKey, { content: fullContent, thinking: fullThinking || undefined });
                  }
                }
              } catch {}
            }
          },
        });

        const transformedStream = originalBody.pipeThrough(transform);
        return new Response(transformedStream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
      } catch (err: any) {
        if (err.name === "AbortError") return json({ error: "Request timeout (5 min)" }, 504);
        return json({ error: "Gateway unreachable: " + err.message }, 502);
      }
    }

    // --- History ---
    {
      const sessionKey = matchHistoryRoute(pathname);
      if (sessionKey && (method === "POST" || method === "GET")) {
        const body = method === "POST" ? await readJSON(req) : {};
        const urlParams = new URL(req.url, `http://localhost`).searchParams;
        const limit = body?.limit || parseInt(urlParams.get('limit') || '50');
        const offset = body?.offset || parseInt(urlParams.get('offset') || '0');

        const localMsgs = loadLocalMessages(sessionKey);
        const completeMsgs = localMsgs.filter(m => !m.partial || (m.content && m.content.trim()));
        const activeStream = isStreaming(sessionKey);
        let needsSave = completeMsgs.length !== localMsgs.length;
        if (!activeStream) { completeMsgs.forEach(m => { if (m.partial) { m.partial = false; needsSave = true; } }); }
        if (needsSave) saveLocalMessages(sessionKey, completeMsgs);

        if (completeMsgs.length > 0) {
          const total = completeMsgs.length;
          const sliced = offset > 0 ? completeMsgs.slice(0, Math.max(0, total - offset)) : completeMsgs;
          const result = sliced.slice(-limit);
          const lastMsg = completeMsgs[completeMsgs.length - 1];
          const hasOrphanedMessage = lastMsg?.role === 'user';
          const currentStream = isStreaming(sessionKey);
          return json({ messages: result, total, hasOrphanedMessage, isStreaming: !!currentStream, streamState: currentStream ? { startedAt: currentStream.startedAt, isThinking: currentStream.isThinking } : null });
        }

        // Fallback: Gateway
        try {
          const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` },
            body: JSON.stringify({ tool: "sessions_history", args: { sessionKey, limit: limit + offset, includeTools: false } }),
          });
          const data = await resp.json() as any;
          const gatewayMessages = data?.result?.messages || data?.result?.details?.messages || [];
          if (gatewayMessages.length > 0) {
            for (const msg of gatewayMessages) {
              if ((msg.role === "user" || msg.role === "assistant") && msg.content) {
                const content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : "";
                if (content.trim() && !content.startsWith("[Chat messages since your last reply")) appendLocalMessage(sessionKey, msg.role, content);
              }
            }
            const migrated = loadLocalMessages(sessionKey);
            const total = migrated.length;
            const sliced = offset > 0 ? migrated.slice(0, Math.max(0, total - offset)) : migrated;
            return json({ messages: sliced.slice(-limit), total });
          }
        } catch (err) { console.warn(`[Messages] Gateway migration failed for ${sessionKey}:`, err); }

        // Last resort: JSONL
        try {
          const sessionsStorePath = join(SESSIONS_DIR, "sessions.json");
          if (existsSync(sessionsStorePath)) {
            const store = JSON.parse(readFileSync(sessionsStorePath, "utf-8"));
            const entry = store[sessionKey];
            if (entry?.sessionId) {
              const jsonlPath = join(SESSIONS_DIR, entry.sessionId + ".jsonl");
              if (existsSync(jsonlPath)) {
                const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
                const messages: any[] = [];
                for (const line of lines) {
                  try {
                    const d = JSON.parse(line);
                    if (d.type === "message" && d.message) {
                      const msg = d.message;
                      if (msg.role === "user" || msg.role === "assistant") {
                        let text = "";
                        if (typeof msg.content === "string") text = msg.content;
                        else if (Array.isArray(msg.content)) text = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
                        if (text.trim() && !text.startsWith("[Chat messages since your last reply")) messages.push({ role: msg.role, content: text, timestamp: d.timestamp });
                      }
                    }
                  } catch {}
                }
                for (const msg of messages) appendLocalMessage(sessionKey, msg.role, msg.content);
                const total = messages.length;
                const sliced = offset > 0 ? messages.slice(0, Math.max(0, total - offset)) : messages;
                return json({ messages: sliced.slice(-limit), total });
              }
            }
          }
        } catch (err) { console.warn(`[Messages] JSONL migration failed for ${sessionKey}:`, err); }

        return json({ messages: [], total: 0 });
      }
    }

    // --- Media serving ---
    if (method === "GET" && pathname === "/api/media") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return json({ error: "path parameter required" }, 400);
      const resolved = resolve(filePath);
      if (!ctx.isPathAllowed(resolved)) return json({ error: "forbidden: path not in allowed directories" }, 403);
      if (!existsSync(resolved)) return new Response("Not Found", { status: 404 });
      const file = Bun.file(resolved);
      const contentType = ctx.getMimeType(resolved);
      return new Response(file, { headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" } });
    }

    // --- Base64 image upload ---
    if (method === "POST" && pathname === "/api/upload-image") {
      try {
        const body = await readJSON(req);
        if (!body?.dataUrl || !body?.mimeType) return json({ error: "dataUrl and mimeType required" }, 400);
        const { dataUrl, mimeType } = body;
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return json({ error: "Invalid data URL format" }, 400);
        const ext = mimeType === "image/png" ? "png" : "jpg";
        mkdirSync(UPLOADS_DIR, { recursive: true });
        const filename = `${Date.now()}-paste.${ext}`;
        const filepath = join(UPLOADS_DIR, filename);
        const buffer = Buffer.from(match[2], "base64");
        writeFileSync(filepath, buffer);
        return json({ url: filepath });
      } catch (err: any) { return json({ error: "Image upload failed: " + err.message }, 500); }
    }

    // --- File upload ---
    if (method === "POST" && pathname === "/api/upload") {
      try {
        const formData = await req.formData();
        const file = formData.get("file");
        if (!file || typeof file === "string") return json({ error: "file required" }, 400);
        mkdirSync(UPLOADS_DIR, { recursive: true });
        const safeName = (file as File).name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const filename = `${Date.now()}-${safeName}`;
        const filepath = join(UPLOADS_DIR, filename);
        const buffer = await (file as File).arrayBuffer();
        writeFileSync(filepath, Buffer.from(buffer));
        return json({ path: filepath, filename: (file as File).name, size: (file as File).size });
      } catch (err: any) { return json({ error: "Upload failed: " + err.message }, 500); }
    }

    // --- Context file deletion ---
    if (method === "DELETE" && pathname === "/api/context-file") {
      const body = await readJSON(req);
      if (!body?.topicId || !body?.filePath) return json({ error: "topicId and filePath required" }, 400);
      const data = loadTopics();
      const topic = data.topics[body.topicId];
      if (!topic) return json({ error: "not found" }, 404);
      topic.contextFiles = (topic.contextFiles || []).filter(f => f !== body.filePath);
      topic.updatedAt = new Date().toISOString();
      saveTopics(data);
      return json({ ok: true });
    }

    // --- Auto-name ---
    {
      const params = matchRoute(pathname, "/api/topics/:id/auto-name");
      if (params && method === "POST") {
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "not found" }, 404);
        const localMsgs = loadLocalMessages(topic.sessionKey);
        const recentMsgs = localMsgs.slice(-4);
        if (recentMsgs.length < 2) return json({ error: "Not enough messages yet" }, 400);

        const existingProjects = Object.values(data.topics).filter(t => t.projectPath && !t.archived).map(t => ({ name: t.name, path: t.projectPath }));
        const discoverProjects = (): { name: string; path: string }[] => {
          const home = homedir();
          const projectDirs = [join(home, 'Sites'), join(home, 'Projects'), join(home, 'Code'), join(home, 'Developer'), join(home, 'workspace'), join(home, '.openclaw', 'workspace')];
          const discovered: { name: string; path: string }[] = [];
          for (const dir of projectDirs) {
            if (!existsSync(dir)) continue;
            try {
              const entries = readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
                const projectPath = join(dir, entry.name);
                const hasPackageJson = existsSync(join(projectPath, 'package.json'));
                const hasClaudeMd = existsSync(join(projectPath, 'CLAUDE.md'));
                const hasGit = existsSync(join(projectPath, '.git'));
                if (hasPackageJson || hasClaudeMd || hasGit) {
                  if (!existingProjects.some(p => p.path === projectPath)) discovered.push({ name: entry.name, path: projectPath });
                }
              }
            } catch {}
          }
          return discovered;
        };
        const discoveredProjects = discoverProjects();
        const allProjects = [...existingProjects, ...discoveredProjects.map(p => ({ name: `[new] ${p.name}`, path: p.path }))];
        const projectsContext = allProjects.length > 0 ? `\n\nKnown projects:\n${allProjects.map(p => `- ${p.name}: ${p.path}`).join('\n')}` : '';
        const nameMessages = [
          { role: "system", content: `Given this conversation start, suggest:\n1. A short title (3-5 words, describing the topic)\n2. One emoji icon that represents the topic\n3. If the conversation is related to a project, suggest its full absolute path. You can pick from the known projects list below, OR suggest a NEW path if the user created/mentioned a specific project directory in the conversation (e.g. /tmp/react-demo, ~/projects/my-app). Suggest null only if no project is involved.\n\nReply ONLY with valid JSON: {"title": "...", "icon": "...", "projectPath": "..." or null}. No other text.${projectsContext}` },
          ...recentMsgs.map((m) => ({ role: m.role, content: m.content.slice(0, 200) })),
        ];

        try {
          const autoNameSessionKey = `auto-name:${params.id}`;
          const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}`, "x-openclaw-session-key": autoNameSessionKey },
            body: JSON.stringify({ model: "openclaw", stream: false, messages: nameMessages }),
          });
          if (!resp.ok) { const errText = await resp.text(); return json({ error: "Gateway error: " + errText }, 502); }
          const result = await resp.json() as any;
          const content = result?.choices?.[0]?.message?.content || "";
          let title = topic.name;
          let icon = topic.icon;
          let suggestedProject: string | null = null;
          try { const jsonMatch = content.match(/\{[^}]+\}/); if (jsonMatch) { const parsed = JSON.parse(jsonMatch[0]); if (parsed.title) title = parsed.title; if (parsed.icon) icon = parsed.icon; if (parsed.projectPath) suggestedProject = parsed.projectPath; } } catch {}
          // Re-read fresh data to avoid overwriting projectPath set by autoBindProject
          const freshData = loadTopics();
          const freshTopic = freshData.topics[params.id];
          if (freshTopic) {
            freshTopic.name = title;
            freshTopic.icon = icon;
            freshTopic.slug = slugify(title);
            freshTopic.updatedAt = new Date().toISOString();
            // Only set projectPath if not already set (autoBindProject may have set it)
            if (!freshTopic.projectPath && suggestedProject) {
              freshTopic.projectPath = suggestedProject;
            }
            saveTopics(freshData);
            broadcastToAll({ type: "topic:updated", topic: freshTopic });
          }
          return json({ title, icon, suggestedProject });
        } catch (err: any) { return json({ error: "Auto-name failed: " + err.message }, 500); }
      }
    }

    // --- Slash commands ---
    if (method === "POST" && pathname === "/api/command") {
      const body = await readJSON(req);
      if (!body?.command || !body?.sessionKey) return json({ error: "command and sessionKey required" }, 400);
      const { command, sessionKey, args } = body;
      try {
        switch (command) {
          case "status": {
            const messages = loadLocalMessages(sessionKey);
            const topic = Object.values(loadTopics().topics).find(t => t.sessionKey === sessionKey);
            const output = [`📍 Session: ${sessionKey}`, `💬 Messages: ${messages.length}`, topic?.projectPath ? `📁 Project: ${topic.projectPath}` : null, topic?.name ? `📝 Topic: ${topic.name}` : null].filter(Boolean).join('\n');
            return json({ ok: true, command: "status", output });
          }
          case "clear": {
            const existingMsgs = loadLocalMessages(sessionKey);
            if (existingMsgs.length > 0) {
              const backupDir = join(ctx.BASE_DIR, "backups");
              try { mkdirSync(backupDir, { recursive: true }); const timestamp = new Date().toISOString().replace(/[:.]/g, "-"); const backupFile = join(backupDir, `${sessionKey.replace(/[^a-zA-Z0-9]/g, "_")}_${timestamp}.json`); writeFileSync(backupFile, JSON.stringify(existingMsgs, null, 2)); console.log(`[clear] Backed up ${existingMsgs.length} messages to ${backupFile}`); } catch (err) { console.warn("[clear] Backup failed:", err); }
            }
            saveLocalMessages(sessionKey, []);
            try { await fetch(`${GATEWAY_URL}/tools/invoke`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` }, body: JSON.stringify({ tool: "sessions_send", args: { sessionKey, message: "/clear" } }) }); } catch (err) { console.warn("Failed to clear gateway session:", err); }
            broadcastToAll({ type: "clear", sessionKey });
            return json({ ok: true, command: "clear", message: "Conversation cleared" });
          }
          case "model": {
            const modelName = args?.model;
            if (!modelName) return json({ error: "model name required" }, 400);
            const resp = await fetch(`${GATEWAY_URL}/api/inference/chat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` }, body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: `/model ${modelName}` }] }) });
            if (!resp.ok) return json({ error: "Failed to set model" }, 500);
            return json({ ok: true, command: "model", model: modelName, message: `Model set to: ${modelName}` });
          }
          case "reasoning": {
            const level = args?.level || "on";
            const resp = await fetch(`${GATEWAY_URL}/api/inference/chat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` }, body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: `/reasoning ${level}` }] }) });
            if (!resp.ok) return json({ error: "Failed to toggle reasoning" }, 500);
            const text = await resp.text();
            return json({ ok: true, command: "reasoning", level, message: `Reasoning set to: ${level}`, output: text });
          }
          default: return json({ error: `Unknown command: ${command}` }, 400);
        }
      } catch (err: any) { return json({ error: `Command failed: ${err.message}` }, 500); }
    }

    // --- Remote Access ---
    if (method === "GET" && pathname === "/api/remote/status") {
      const runCmd = (cmd: string[]) => {
        const result = Bun.spawnSync(cmd, { stderr: "pipe" });
        return result.exitCode === 0 ? result.stdout.toString().trim() : "";
      };
      try {
        try {
          const serveStatus = runCmd(["tailscale", "serve", "status", "--json"]);
          const serve = JSON.parse(serveStatus || '{}');
          const isActive = serve?.TCP?.["3333"] || serve?.Web?.["https://"]?.Handlers?.["/"];
          const tsJson = runCmd(["tailscale", "status", "--json"]);
          const tsStatus = JSON.parse(tsJson || '{}');
          const hostname = (tsStatus?.Self?.DNSName || "").replace(/\.$/, "");
          if (isActive && hostname) return json({ active: true, url: `https://${hostname}`, type: 'tailscale' });
        } catch {}
        try {
          const psResult = Bun.spawnSync(["ps", "aux"], { stderr: "pipe" });
          const procs = psResult.stdout.toString();
          const lines = procs.split("\n").filter(l => /cloudflared|lt |ngrok/.test(l) && !l.includes("grep"));
          const line = lines[0] || "";
          if (line.includes('cloudflared') && line.includes('3333')) return json({ active: true, type: 'cloudflare', url: 'Check cloudflared logs' });
          if (line.includes('ngrok')) {
            try {
              const resp = await fetch("http://localhost:4040/api/tunnels");
              const data = await resp.json() as any;
              const ngrokUrl = data?.tunnels?.[0]?.public_url;
              if (ngrokUrl) return json({ active: true, type: 'ngrok', url: ngrokUrl });
            } catch {}
          }
        } catch {}
        return json({ active: false, type: 'unknown' });
      } catch (err: any) { return json({ active: false, error: err.message }); }
    }

    if (method === "POST" && pathname === "/api/remote/tunnel") {
      try {
        const body = await readJSON(req);
        const action = body?.action;
        if (action === "start") {
          try {
            Bun.spawnSync(["tailscale", "serve", "--bg", "--https=443", "http://localhost:3333"], { stderr: "pipe" });
            Bun.spawnSync(["tailscale", "funnel", "--bg", "443"], { stderr: "pipe" });
            const tsJson = Bun.spawnSync(["tailscale", "status", "--json"], { stderr: "pipe" });
            const tsStatus = JSON.parse(tsJson.stdout.toString() || '{}');
            const hostname = (tsStatus?.Self?.DNSName || "").replace(/\.$/, "");
            return json({ success: true, url: hostname ? `https://${hostname}` : null, message: 'Tailscale Funnel activated' });
          } catch (err: any) { return json({ success: false, error: err.message }, 500); }
        } else if (action === "stop") {
          try {
            Bun.spawnSync(["tailscale", "funnel", "off"], { stderr: "pipe" });
            Bun.spawnSync(["tailscale", "serve", "off"], { stderr: "pipe" });
            return json({ success: true, message: 'Tunnel deactivated' });
          } catch (err: any) { return json({ success: false, error: err.message }, 500); }
        }
        return json({ error: "Invalid action" }, 400);
      } catch (err: any) { return json({ error: err.message }, 500); }
    }

    // --- Processes API ---
    if (method === "GET" && pathname === "/api/processes") {
      const topicId = url.searchParams.get("topicId");
      if (!topicId) return json({ error: "topicId parameter required" }, 400);
      try {
        const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` }, body: JSON.stringify({ tool: "sessions_list", args: { kinds: ["other"], activeMinutes: 30 } }) });
        const result = await resp.json() as any;
        const sessions = result?.result?.sessions || [];
        const processes = sessions.filter((s: any) => s.sessionKey?.includes("subagent")).map((s: any) => ({ sessionKey: s.sessionKey, label: s.label || s.sessionKey.split(":").pop() || "Sub-agent", status: s.status === "active" ? "running" : "done", startedAt: s.createdAt || new Date().toISOString(), completedAt: s.status !== "active" ? (s.updatedAt || new Date().toISOString()) : undefined }));
        return json(processes);
      } catch { return json([]); }
    }

    // --- Projects: context templates ---
    {
      const params = matchRoute(pathname, "/api/projects/:topicId/context-templates");
      if (params && method === "GET") {
        const data = loadTopics();
        const topic = data.topics[params.topicId];
        if (!topic) return json({ error: "Topic not found" }, 404);
        if (!topic.projectPath) return json({ error: "Topic has no project" }, 400);
        const projectDir = resolveProjectPath(topic.projectPath);
        if (!projectDir || !existsSync(projectDir)) return json({ error: "Project directory not found" }, 404);
        const CONTEXT_FILE_NAMES = ["CLAUDE.md", "README.md", ".cursorrules", "AGENTS.md"];
        const contextFiles: any[] = [];
        for (const name of CONTEXT_FILE_NAMES) {
          let filePath = join(projectDir, name);
          let displayName = name;
          if (!existsSync(filePath) && name === "CLAUDE.md") { const altPath = join(projectDir, ".claude", "CLAUDE.md"); if (existsSync(altPath)) { filePath = altPath; displayName = ".claude/CLAUDE.md"; } }
          if (existsSync(filePath)) {
            try { const stat = statSync(filePath); const content = readFileSync(filePath, "utf-8"); contextFiles.push({ name: displayName, path: filePath, size: stat.size, tokenEstimate: Math.round(content.length / 4), content }); } catch (err) { console.warn(`[ContextTemplates] Failed to read ${filePath}:`, err); }
          }
        }
        return json({ projectPath: topic.projectPath, files: contextFiles, totalTokenEstimate: contextFiles.reduce((sum, f) => sum + f.tokenEstimate, 0) });
      }
    }

    // PUT /api/projects/:topicId/context-templates/disabled
    {
      const params = matchRoute(pathname, "/api/projects/:topicId/context-templates/disabled");
      if (params && method === "PUT") {
        const data = loadTopics();
        const topic = data.topics[params.topicId];
        if (!topic) return json({ error: "Topic not found" }, 404);
        const body = await req.json() as { disabledFiles?: string[] };
        topic.disabledContextTemplates = body.disabledFiles || [];
        saveTopics(data);
        return json({ ok: true, disabledFiles: topic.disabledContextTemplates });
      }
    }

    // --- Tasks ---
    {
      const params = matchRoute(pathname, "/api/projects/:projectId/tasks");
      if (params && method === "GET") return json({ tasks: loadTasks(params.projectId) });
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.text) return json({ error: "text required" }, 400);
        const tasks = loadTasks(params.projectId);
        const maxOrder = tasks.reduce((max: number, t: any) => Math.max(max, t.kanbanOrder ?? 0), 0);
        const task = { id: crypto.randomUUID(), text: body.text, status: body.status || "todo", kanbanOrder: maxOrder + 1, createdAt: new Date().toISOString(), completedAt: null, chatId: body.chatId || null };
        tasks.push(task);
        saveTasks(params.projectId, tasks);
        broadcastToAll({ type: "task:created", projectId: params.projectId, task });
        return json(task, 201);
      }
    }

    {
      const params = matchRoute(pathname, "/api/projects/:projectId/tasks/:taskId");
      if (params && method === "PATCH") {
        const body = await readJSON(req);
        if (!body) return json({ error: "body required" }, 400);
        const tasks = loadTasks(params.projectId);
        const task = tasks.find((t: any) => t.id === params.taskId);
        if (!task) return json({ error: "Task not found" }, 404);
        if (body.text !== undefined) task.text = body.text;
        if (body.status !== undefined) { task.status = body.status; task.completedAt = body.status === "done" ? new Date().toISOString() : null; }
        if (body.kanbanOrder !== undefined) task.kanbanOrder = body.kanbanOrder;
        saveTasks(params.projectId, tasks);
        broadcastToAll({ type: "task:updated", projectId: params.projectId, task });
        return json(task);
      }
      if (params && method === "DELETE") {
        const tasks = loadTasks(params.projectId);
        const idx = tasks.findIndex((t: any) => t.id === params.taskId);
        if (idx === -1) return json({ error: "Task not found" }, 404);
        tasks.splice(idx, 1);
        saveTasks(params.projectId, tasks);
        broadcastToAll({ type: "task:deleted", projectId: params.projectId, taskId: params.taskId });
        return json({ ok: true });
      }
    }

    {
      const params = matchRoute(pathname, "/api/topics/:topicId/project-id");
      if (params && method === "GET") {
        const projectId = getProjectIdForTopic(params.topicId);
        if (!projectId) return json({ error: "Topic has no project" }, 400);
        return json({ projectId });
      }
    }

    return null;
  };
}
