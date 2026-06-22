import { watch, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { resolveStateDir } from "./lib/data-dir";

export type ActivityCategory =
  | 'tool:exec'
  | 'tool:browser'
  | 'tool:read'
  | 'tool:write'
  | 'tool:edit'
  | 'tool:search'
  | 'tool:message'
  | 'memory'
  | 'channel'
  | 'cron'
  | 'heartbeat'
  | 'session'
  | 'error'
  | 'system';

export interface ActivityEvent {
  id: string;
  timestamp: string;
  category: ActivityCategory;
  level: 'debug' | 'info' | 'warn' | 'error';
  title: string;
  detail?: string;
  subsystem?: string;
  sessionKey?: string;
  raw?: string;
}

type Subscriber = (events: ActivityEvent[]) => void;

export class ActivityMonitor {
  private buffer: ActivityEvent[] = [];
  private maxSize = 2000;
  private subscribers = new Set<Subscriber>();
  private logDir: string;
  private logPath: string;
  private fileOffset = 0;
  private batchBuffer: ActivityEvent[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: ReturnType<typeof watch> | null = null;
  // Single id sequencer: every event id appends ++eventCounter, so ids stay
  // unique across the process lifetime even when Date.now() collides. It is
  // persisted/restored alongside the buffer so ids never repeat after restart.
  private eventCounter = 0;
  private lastLineHash = '';
  private dedupeCount = 0;
  private dedupeTitle = '';
  private persistPath: string;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private rolloverTimer: ReturnType<typeof setInterval> | null = null;
  // Poll that waits for the log file to appear when it's missing at startup.
  // Stored so destroy() can clear it — otherwise a hot reload (or shutdown)
  // before the file ever appears orphans a live interval pinning this instance.
  private fileWaitTimer: ReturnType<typeof setInterval> | null = null;

  constructor(logDir = "/tmp/openclaw", persistPath?: string) {
    this.logDir = logDir;
    this.logPath = this.getLogPath();
    this.persistPath = persistPath || join(resolveStateDir(process.cwd()), "data", "activity-buffer.json");
    this.init();
  }

  private getLogPath(): string {
    const dateStr = new Date().toISOString().slice(0, 10);
    return join(this.logDir, `openclaw-${dateStr}.log`);
  }

  private init() {
    // Restore persisted buffer from previous run (events survive restart)
    this.restoreBuffer();
    // Read tail of existing log for initial state
    this.readInitialTail();
    // Watch for changes
    this.startWatching();
    // Check for date rollover every minute. Store the handle so destroy()
    // (called on graceful shutdown AND every `bun --watch` hot reload) can
    // clear it — otherwise each reload orphans a live interval pinning the
    // dead instance.
    this.rolloverTimer = setInterval(() => this.checkDateRollover(), 60_000);
    // Persist buffer every 30s so restarts lose at most 30s of events
    this.persistTimer = setInterval(() => this.persistBuffer(), 30_000);
  }

  private restoreBuffer() {
    try {
      if (!existsSync(this.persistPath)) return;
      const data = JSON.parse(readFileSync(this.persistPath, "utf-8"));
      if (Array.isArray(data?.events)) {
        // Keep only the most recent maxSize events (defensive against on-disk drift)
        this.buffer = data.events.slice(-this.maxSize);
        if (typeof data.eventCounter === "number") this.eventCounter = data.eventCounter;
      }
    } catch (err) {
      console.warn("[ActivityMonitor] Failed to restore persisted buffer:", err);
    }
  }

  private persistBuffer() {
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const payload = JSON.stringify({ events: this.buffer, eventCounter: this.eventCounter });
      writeFileSync(this.persistPath, payload, "utf-8");
    } catch (err) {
      // Non-fatal; activity feed still works in-memory
    }
  }

  private readInitialTail() {
    if (!existsSync(this.logPath)) return;
    try {
      const content = readFileSync(this.logPath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      // Read last 200 lines for initial state
      const tail = lines.slice(-200);
      for (const line of tail) {
        const event = this.parseLine(line);
        if (event) this.addToBuffer(event);
      }
      // Set offset to end of file
      this.fileOffset = statSync(this.logPath).size;
    } catch (err) {
      console.warn("[ActivityMonitor] Failed to read initial log:", err);
    }
  }

  private startWatching() {
    if (!existsSync(this.logPath)) {
      // Check periodically until file appears. Clear any prior poll first so
      // repeated startWatching() calls (e.g. via date rollover) never stack
      // intervals, and keep the handle so destroy() can stop it.
      if (this.fileWaitTimer) clearInterval(this.fileWaitTimer);
      this.fileWaitTimer = setInterval(() => {
        if (existsSync(this.logPath)) {
          if (this.fileWaitTimer) clearInterval(this.fileWaitTimer);
          this.fileWaitTimer = null;
          this.readInitialTail();
          this.startWatching();
        }
      }, 5000);
      return;
    }

    try {
      this.watcher = watch(this.logPath, () => this.readNewLines());
    } catch (err) {
      console.warn("[ActivityMonitor] Failed to watch log file:", err);
    }
  }

  private checkDateRollover() {
    const newPath = this.getLogPath();
    if (newPath !== this.logPath) {
      console.log("[ActivityMonitor] Date rollover, switching to new log file");
      const oldWatcher = this.watcher;
      this.watcher = null;
      this.logPath = newPath;
      this.fileOffset = 0;
      // Start watching new file before closing old watcher to avoid gap
      this.startWatching();
      // Close old watcher after a brief overlap
      if (oldWatcher) {
        setTimeout(() => {
          try { oldWatcher.close(); } catch {}
        }, 2000);
      }
    }
  }

  private readNewLines() {
    if (!existsSync(this.logPath)) return;
    try {
      const stat = statSync(this.logPath);
      if (stat.size <= this.fileOffset) return;

      const content = readFileSync(this.logPath, "utf-8");
      const newContent = content.slice(this.fileOffset);
      this.fileOffset = stat.size;

      const lines = newContent.split("\n").filter(Boolean);
      for (const line of lines) {
        const event = this.parseLine(line);
        if (event) {
          // Deduplication: group consecutive identical titles
          if (event.title === this.dedupeTitle) {
            this.dedupeCount++;
            continue;
          }
          // Flush previous deduped group
          if (this.dedupeCount > 0) {
            this.flushDedupe();
          }
          this.dedupeTitle = event.title;
          this.dedupeCount = 0;
          this.addToBuffer(event);
          this.batchBuffer.push(event);
        }
      }

      // Batch notifications: collect for 100ms then send
      // Force-flush if buffer exceeds 500 to prevent unbounded growth
      if (this.batchBuffer.length >= 500) {
        if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }
        if (this.dedupeCount > 0) this.flushDedupe();
        const events = [...this.batchBuffer];
        this.batchBuffer = [];
        this.notifySubscribers(events);
      } else if (this.batchBuffer.length > 0 && !this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          if (this.dedupeCount > 0) this.flushDedupe();
          const events = [...this.batchBuffer];
          this.batchBuffer = [];
          this.batchTimer = null;
          this.notifySubscribers(events);
        }, 100);
      }
    } catch (err) {
      // Ignore read errors (file may be rotated)
    }
  }

  private flushDedupe() {
    if (this.dedupeCount > 0 && this.buffer.length > 0) {
      const last = this.buffer[this.buffer.length - 1];
      last.title = `${last.title} (x${this.dedupeCount + 1})`;
      this.dedupeCount = 0;
    }
  }

  private parseLine(line: string): ActivityEvent | null {
    try {
      const parsed = JSON.parse(line);
      return this.classify(parsed, line);
    } catch {
      // Not JSON - try to parse as plain text log
      return this.classifyPlainText(line);
    }
  }

  private classify(logLine: any, raw: string): ActivityEvent | null {
    const meta = logLine._meta || {};
    const levelName = (meta.logLevelName || 'INFO').toUpperCase();
    const level = this.mapLevel(levelName);
    const time = logLine.time || meta.date || new Date().toISOString();

    // Extract subsystem from _meta.name
    let subsystem: string | undefined;
    try {
      if (meta.name) {
        const nameObj = JSON.parse(meta.name);
        subsystem = nameObj.subsystem || nameObj.module;
      }
    } catch {
      subsystem = meta.name;
    }

    // Build the message text from fields 0, 1, 2
    const field0 = typeof logLine["0"] === 'string' ? logLine["0"] : '';
    const field2 = typeof logLine["2"] === 'string' ? logLine["2"] : '';
    const message = field2 || field0 || '';

    if (!message && !subsystem) return null;

    const category = this.categorize(message, subsystem, logLine);
    const title = this.extractTitle(message, subsystem, category);

    // Skip debug-level by default unless it's something interesting
    if (level === 'debug' && category === 'system') return null;

    return {
      id: `act_${Date.now()}_${++this.eventCounter}`,
      timestamp: time,
      category,
      level,
      title,
      detail: message.length > 100 ? message : undefined,
      subsystem,
      raw: raw.length < 500 ? raw : undefined,
    };
  }

  private classifyPlainText(line: string): ActivityEvent | null {
    if (!line.trim() || line.trim().length < 5) return null;

    const category = this.categorize(line, undefined, null);
    if (category === 'system' && !line.includes('error') && !line.includes('Error')) return null;

    return {
      id: `act_${Date.now()}_${++this.eventCounter}`,
      timestamp: new Date().toISOString(),
      category,
      level: line.toLowerCase().includes('error') ? 'error' : 'info',
      title: line.slice(0, 120),
    };
  }

  private categorize(message: string, subsystem?: string, logLine?: any): ActivityCategory {
    const msg = message.toLowerCase();

    // Error detection first
    if (logLine?._meta?.logLevelName === 'ERROR') return 'error';
    if (msg.includes('failed:') || msg.includes('error:')) return 'error';

    // Tool categories
    if (msg.includes('[tools] exec') || msg.includes('tool:exec') || msg.includes('command_exec')) return 'tool:exec';
    if (msg.includes('[tools] browser') || msg.includes('tool:browser') || msg.includes('browser_action')) return 'tool:browser';
    if (msg.includes('[tools] read') || msg.includes('tool:read') || msg.includes('file_read')) return 'tool:read';
    if (msg.includes('[tools] write') || msg.includes('tool:write') || msg.includes('file_write')) return 'tool:write';
    if (msg.includes('[tools] edit') || msg.includes('tool:edit') || msg.includes('file_edit')) return 'tool:edit';
    if (msg.includes('web_search') || msg.includes('web_fetch')) return 'tool:search';
    if (msg.includes('[tools] message') || msg.includes('tool:message')) return 'tool:message';

    // Subsystem categories
    if (subsystem === 'memory' || msg.includes('memory') || msg.includes('embedding')) return 'memory';
    if (subsystem?.includes('discord') || subsystem?.includes('slack') || msg.includes('channel')) return 'channel';
    if (msg.includes('cron') || subsystem === 'cron') return 'cron';
    if (msg.includes('heartbeat') || msg.includes('HEARTBEAT')) return 'heartbeat';
    if (msg.includes('session') || subsystem === 'session') return 'session';

    return 'system';
  }

  private extractTitle(message: string, subsystem?: string, category?: ActivityCategory): string {
    // Clean up the message for display
    let title = message.replace(/\s+/g, ' ').trim();
    if (title.length > 120) title = title.slice(0, 117) + '...';

    // Add subsystem prefix if available and not already in message
    if (subsystem && !title.toLowerCase().includes(subsystem.toLowerCase())) {
      title = `${subsystem}: ${title}`;
    }

    return title || category || 'Unknown event';
  }

  private mapLevel(level: string): 'debug' | 'info' | 'warn' | 'error' {
    switch (level) {
      case 'DEBUG': case 'TRACE': return 'debug';
      case 'WARN': case 'WARNING': return 'warn';
      case 'ERROR': case 'FATAL': return 'error';
      default: return 'info';
    }
  }

  private addToBuffer(event: ActivityEvent) {
    this.buffer.push(event);
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize);
    }
  }

  private notifySubscribers(events: ActivityEvent[]) {
    for (const fn of this.subscribers) {
      try { fn(events); } catch {}
    }
  }

  /** Also allow external events to be pushed (e.g. from streaming) */
  pushEvent(event: Omit<ActivityEvent, 'id'>) {
    const full: ActivityEvent = {
      ...event,
      id: `act_${Date.now()}_${++this.eventCounter}`,
    };
    this.addToBuffer(full);
    this.notifySubscribers([full]);
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  getRecent(limit = 100): ActivityEvent[] {
    return this.buffer.slice(-limit);
  }

  destroy() {
    if (this.watcher) this.watcher.close();
    if (this.batchTimer) clearTimeout(this.batchTimer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    if (this.rolloverTimer) clearInterval(this.rolloverTimer);
    if (this.fileWaitTimer) clearInterval(this.fileWaitTimer);
    this.persistBuffer();
    this.subscribers.clear();
  }
}
