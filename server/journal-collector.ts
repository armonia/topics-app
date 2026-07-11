import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface JournalEvent {
  id: string;
  timestamp: string;
  sessionKey: string;
  type: 'tool_call' | 'message' | 'session_start' | 'session_end' | 'error';
  summary: string;
  detail?: string;
}

interface CollectorState {
  lastProcessedAt: Record<string, number>; // sessionKey -> timestamp
}

export class JournalCollector {
  private eventsDir: string;
  private digestsDir: string;
  private stateFile: string;
  private state: CollectorState;
  private gatewayUrl: string;
  private gatewayToken: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private eventCounter = 0;
  private gatewayDown = false;

  constructor(baseDir: string, gatewayUrl: string, gatewayToken: string) {
    this.eventsDir = join(baseDir, "journal", "events");
    this.digestsDir = join(baseDir, "journal", "digests");
    this.stateFile = join(baseDir, "journal", "state.json");
    this.gatewayUrl = gatewayUrl;
    this.gatewayToken = gatewayToken;

    mkdirSync(this.eventsDir, { recursive: true });
    mkdirSync(this.digestsDir, { recursive: true });

    this.state = this.loadState();
  }

  start(intervalMs = 300_000) {
    // Standalone / self-contained bundle: there is no OpenClaw gateway to sync the
    // journal to, so every collect() would spam "Collection failed: Unable to
    // connect" (ConnectionRefused) into the field logs. Skip entirely — same flag
    // the shell sets for the sidecar (TOPICS_EMBEDDED, or the precise
    // TOPICS_DISABLE_PTY_BRIDGE). No gateway integration runs in standalone mode.
    if (process.env.TOPICS_EMBEDDED === "1" || process.env.TOPICS_DISABLE_PTY_BRIDGE === "1") {
      console.log("[JournalCollector] standalone mode — gateway journal sync disabled");
      return;
    }
    this.collect(); // initial collection
    this.timer = setInterval(() => this.collect(), intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private loadState(): CollectorState {
    try {
      if (existsSync(this.stateFile)) {
        return JSON.parse(readFileSync(this.stateFile, "utf-8"));
      }
    } catch {}
    return { lastProcessedAt: {} };
  }

  private saveState() {
    try {
      writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.warn("[JournalCollector] Failed to save state:", err);
    }
  }

  private getDateStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private getEventsPath(date: string): string {
    return join(this.eventsDir, `${date}.json`);
  }

  getDigestPath(date: string): string {
    return join(this.digestsDir, `${date}.md`);
  }

  loadEvents(date: string): JournalEvent[] {
    const path = this.getEventsPath(date);
    try {
      if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8"));
    } catch {}
    return [];
  }

  private saveEvents(date: string, events: JournalEvent[]) {
    writeFileSync(this.getEventsPath(date), JSON.stringify(events, null, 2));
  }

  loadDigest(date: string): string | null {
    const path = this.getDigestPath(date);
    try {
      if (existsSync(path)) return readFileSync(path, "utf-8");
    } catch {}
    return null;
  }

  saveDigest(date: string, content: string) {
    writeFileSync(this.getDigestPath(date), content);
  }

  private async collect() {
    try {
      const resp = await fetch(`${this.gatewayUrl}/tools/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.gatewayToken}` },
        body: JSON.stringify({ tool: "sessions_list", args: { activeMinutes: 10, messageLimit: 5 } }),
        // A hung gateway would otherwise pile up one pending collect() per tick.
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) return;
      if (this.gatewayDown) {
        this.gatewayDown = false;
        console.log("[JournalCollector] Gateway reachable again, journal sync resumed");
      }

      const data = await resp.json() as any;
      const sessions = data?.result?.sessions || [];
      const dateStr = this.getDateStr();
      const events = this.loadEvents(dateStr);
      let added = 0;

      for (const session of sessions) {
        const key = session.key || session.sessionKey;
        if (!key) continue;
        const lastTs = this.state.lastProcessedAt[key] || 0;

        // Process messages into events
        const messages = session.messages || [];
        for (const msg of messages) {
          const msgTs = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;
          if (msgTs <= lastTs) continue;

          const content = typeof msg.content === 'string' ? msg.content : '';
          if (!content.trim()) continue;

          // Extract tool calls from message content
          const toolMatches = content.match(/\[tools?\]\s+(\w+)/gi);
          if (toolMatches) {
            for (const match of toolMatches) {
              events.push({
                id: `je_${Date.now()}_${++this.eventCounter}`,
                timestamp: msg.timestamp || new Date().toISOString(),
                sessionKey: key,
                type: 'tool_call',
                summary: match.replace(/\[tools?\]\s+/i, 'Tool: '),
                detail: content.slice(0, 200),
              });
              added++;
            }
          } else {
            const role = msg.role || 'unknown';
            events.push({
              id: `je_${Date.now()}_${++this.eventCounter}`,
              timestamp: msg.timestamp || new Date().toISOString(),
              sessionKey: key,
              type: 'message',
              summary: `${role}: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`,
            });
            added++;
          }

          this.state.lastProcessedAt[key] = Math.max(this.state.lastProcessedAt[key] || 0, msgTs);
        }
      }

      if (added > 0) {
        this.saveEvents(dateStr, events);
        this.saveState();
      }
    } catch (err) {
      // Log the outage once, not every 5-minute tick: a stopped gateway used to
      // put a multi-line warn in the field logs per tick (thousands of lines).
      if (!this.gatewayDown) {
        this.gatewayDown = true;
        console.warn("[JournalCollector] Gateway unreachable, suppressing repeats until it recovers:", err);
      }
    }
  }
}
