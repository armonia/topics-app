/**
 * THE ATTENTION STATE, DRIVEN THROUGH THE REAL SERVER (notifications-redesign,
 * tasks.md section 5).
 *
 * No `attention:*` frame is injected anywhere: the server composes the state
 * from what it really receives, and the specs only feed those inputs. A
 * terminal's turns come from the Claude Code hooks route (the same POST the
 * CLI makes, with the token the test server wrote under its own home), its
 * background tasks from the hooks and from its transcript, a chat's turn from
 * the seen door and the routes the client uses. What is faked is the boundary
 * the browser cannot have in a headless run: the OS banner
 * (`window.Notification`), and the window being "behind another app"
 * (`visibilityState` visible, `hasFocus()` false, the way macOS reports it to
 * a WKWebView).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_BASE, E2E_HOME, testServerEnv } from "./test-server";
import { deriveTranscriptPath } from "../../../server/lib/claude-session-state";
import type { AttentionSnapshot } from "../../../shared/attention";

/** What the stubs below hang on `window`. Not a global declaration: specs declare their own. */
type StubbedWindow = Window & { __bannerLog?: { title: string; body: string; tag?: string }[]; __awake?: boolean };

/**
 * Stubs the OS banner and puts the window behind another app (or, with
 * `awake`, in front of you; `window.__awake` flips it later). Must run before
 * `goto`: a window whose permission is not `granted` never builds a banner.
 * The stub paints what it was asked, so a video shows the banner.
 */
export async function stubBannersAndWindow(page: Page, { awake = false }: { awake?: boolean } = {}): Promise<void> {
  await page.addInitScript((startAwake: boolean) => {
    const w = window as StubbedWindow;
    w.__bannerLog = [];
    w.__awake = startAwake;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.hasFocus = () => w.__awake === true;
    class FakeNotification {
      static permission = "granted";
      static requestPermission(): Promise<string> { return Promise.resolve("granted"); }
      onclick: (() => void) | null = null;
      constructor(title: string, opts?: { body?: string; tag?: string }) {
        w.__bannerLog!.push({ title, body: opts?.body ?? "", tag: opts?.tag });
        const card = document.createElement("div");
        card.setAttribute("data-testid", "fake-os-banner");
        card.style.cssText = [
          "position:fixed", "top:16px", "right:16px", "z-index:2147483647", "width:320px",
          "padding:12px 14px", "border-radius:12px", "background:#111", "color:#fff",
          "font:13px/1.4 -apple-system,system-ui,sans-serif", "box-shadow:0 8px 32px rgba(0,0,0,.5)",
          "border-left:4px solid #60a5fa", "pointer-events:none",
        ].join(";");
        const head = document.createElement("div");
        head.style.cssText = "opacity:.55;font-size:10px;letter-spacing:.08em;text-transform:uppercase";
        head.textContent = "OS banner";
        const t = document.createElement("div");
        t.style.cssText = "font-weight:600;margin-top:4px";
        t.textContent = title;
        const b = document.createElement("div");
        b.style.cssText = "opacity:.8;margin-top:2px";
        b.textContent = opts?.body ?? "";
        card.append(head, t, b);
        document.body.appendChild(card);
      }
      close(): void { /* stays on screen so the video shows it */ }
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
  }, awake);
}

export function bannerLog(page: Page): Promise<{ title: string; body: string; tag?: string }[]> {
  return page.evaluate(() => (window as StubbedWindow).__bannerLog ?? []);
}

/** Brings the window to the front (or sends it behind another app), the way the shell reports it. */
export async function setAwake(page: Page, awake: boolean): Promise<void> {
  await page.evaluate((a) => {
    (window as StubbedWindow).__awake = a;
    window.dispatchEvent(new Event(a ? "focus" : "blur"));
    document.dispatchEvent(new Event("visibilitychange"));
  }, awake);
}

export interface AttentionFrames {
  /** The last snapshot of each subject, as the server sent it. */
  rows: () => Map<string, AttentionSnapshot>;
  /** The subjects of every announced epoch, in order. */
  announces: () => string[];
  /** How many `attention:init` arrived: one per opened socket. */
  inits: () => number;
  /** Feeds one frame read off a socket the spec routes itself. */
  feed: (payload: string) => void;
}

/**
 * Every `attention:*` frame the server sends this page, in order: the
 * server's own words, read off the socket the app uses. Installed before
 * `goto`, it follows the sockets of reloads too. Without a page it only
 * records what `feed` gives it (a socket the spec routes, which Playwright
 * does not report as a page websocket).
 */
export function recordAttentionFrames(page?: Page): AttentionFrames {
  const latest = new Map<string, AttentionSnapshot>();
  const announced: string[] = [];
  let inits = 0;
  const feed = (payload: string): void => {
    if (!payload.includes('"attention:')) return;
    let msg: { type?: string; rows?: AttentionSnapshot[]; row?: AttentionSnapshot; announce?: { tag?: string } | null };
    try { msg = JSON.parse(payload); } catch { return; }
    if (msg.type === "attention:init") {
      inits += 1;
      latest.clear();
      for (const r of msg.rows ?? []) latest.set(r.subject, r);
    }
    if (msg.type === "attention:updated" && msg.row) {
      latest.set(msg.row.subject, msg.row);
      if (msg.announce) announced.push(msg.row.subject);
    }
  };
  page?.on("websocket", (ws) => {
    ws.on("framereceived", ({ payload }) => { if (typeof payload === "string") feed(payload); });
  });
  return { rows: () => latest, announces: () => [...announced], inits: () => inits, feed };
}

/** The token the hooks route checks, written by the test server under its own home. */
function hookToken(): string {
  const tokenPath = join(testServerEnv().TOPICS_HOME, "claude-hooks", "hook-token");
  expect(existsSync(tokenPath), `the test server wrote no hook token (${tokenPath})`).toBe(true);
  return readFileSync(tokenPath, "utf-8").trim();
}

/** One Claude Code hook, as the CLI posts it. */
export async function postHook(request: APIRequestContext, event: string, body: Record<string, unknown>): Promise<string> {
  const res = await request.post(`${E2E_BASE}/api/claude-hooks/${event}`, {
    headers: { authorization: `Bearer ${hookToken()}` },
    data: body,
  });
  expect(res.ok(), `the ${event} hook was refused: ${res.status()}`).toBe(true);
  return ((await res.json()) as { result?: string }).result ?? "";
}

export interface ClaudeTerminal {
  id: string;
  claudeSessionId: string;
  /** The cwd the SERVER resolved: the transcript path is derived from it. */
  cwd: string;
}

/** A Claude Code terminal session the hooks can drive. */
export async function createClaudeTerminal(request: APIRequestContext, name: string, cwd = "/tmp"): Promise<ClaudeTerminal> {
  const res = await request.post(`${E2E_BASE}/api/terminal/sessions`, { data: { cwd, type: "claude-code", name } });
  expect(res.ok(), "the claude-code terminal was not created").toBe(true);
  const created = (await res.json()) as ClaudeTerminal;
  expect(created.claudeSessionId, "the claude-code terminal has no session id: no hook can reach it").toBeTruthy();
  return created;
}

/**
 * Appends one line to the terminal's transcript, where the server's tail reads
 * the `<task-notification>` that closes a background task. The path is the
 * one the server derives, under the home the server really uses.
 */
export function appendTranscriptLine(term: ClaudeTerminal, line: Record<string, unknown>): void {
  const file = deriveTranscriptPath(E2E_HOME, term.cwd, term.claudeSessionId);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + "\n");
}

/** The transcript line the CLI writes when a background task returns. */
export function taskNotificationLine(taskId: string, summary: string): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`,
    },
    timestamp: new Date().toISOString(),
  };
}

/** Polls the attention state the server sent this page for one subject. */
export async function expectAttention(
  frames: AttentionFrames,
  subject: string,
  want: Partial<Pick<AttentionSnapshot, "state" | "lit" | "reason" | "outcome">>,
  message: string,
): Promise<void> {
  await expect
    .poll(() => {
      const r = frames.rows().get(subject);
      if (!r) return null;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(want)) out[k] = r[k as keyof AttentionSnapshot];
      return out;
    }, { timeout: 15_000, message })
    .toEqual(want);
}

/** The session key of a chat, the address of its turns. */
export async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics/${topicId}`);
  return ((await res.json()) as { topic: { sessionKey: string } }).topic.sessionKey;
}

/**
 * One whole chat turn on the real chat route, the door the composer uses:
 * the server runs it on the chat's CLI (a fake one the spec installed) and
 * closes it with its own `stream:end`, from which it composes the state. The
 * response is the turn's stream; it ends when the turn does.
 */
export async function runChatTurn(request: APIRequestContext, topicId: string, text: string): Promise<void> {
  const sessionKey = await sessionKeyOf(request, topicId);
  const res = await request.post(`${E2E_BASE}/api/chat`, {
    data: { sessionKey, messages: [{ role: "user", content: text }], clientMessageId: `e2e-${topicId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    timeout: 60_000,
  });
  expect(res.ok(), `the chat turn was refused: ${res.status()} ${await res.text().catch(() => "")}`).toBe(true);
  await res.body();
}

let injectedEpoch = 1000;

/**
 * An `attention:updated` frame as the server writes it, for the specs that
 * stage a state on the socket instead of driving the server
 * (notifications-redesign, tasks.md 5.5: the specs that injected
 * `stream:end`, `session:state` or `unread:updated` for a mark). The epoch is
 * fresh at each call unless given, as a new cause would make it; `lit`
 * follows the state the way the server composes it (`needs-you`, or
 * `finished` not seen).
 */
export function attentionUpdated(
  subject: string,
  over: Partial<AttentionSnapshot> & { state: AttentionSnapshot["state"] },
  extra: { announce?: Record<string, unknown>; bornSeen?: boolean } = {},
): { type: "attention:updated"; [key: string]: unknown } {
  const epoch = over.epoch ?? ++injectedEpoch;
  const lit = over.lit ?? (over.state === "needs-you" || over.state === "finished");
  const row: AttentionSnapshot = {
    subject,
    reason: null,
    outcome: over.state === "finished" ? "done" : null,
    detail: null,
    since: new Date().toISOString(),
    seenEpoch: lit ? epoch - 1 : epoch,
    unread: 0,
    turnUnseen: false,
    lastTurnAt: null,
    background: [],
    ...over,
    epoch,
    lit,
  };
  return { type: "attention:updated", row, live: true, ...extra };
}
