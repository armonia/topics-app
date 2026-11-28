// Chat previews: the same preview flow as a card, for a chat that works in its
// own worktree. Split out of preview-manager to keep that file under its size cap.
import { join } from "path";
import type { PreviewManagerDeps, PreviewWorktree, ChatPreviewOptions } from "./preview-manager";

/** Key of the manager's `live` map: a task id, or `chat:<topicId>` for a chat preview. */
export const CHAT_SOURCE_PREFIX = "chat:";
export const chatSourceId = (topicId: string): string => CHAT_SOURCE_PREFIX + topicId;
export const isChatSource = (sourceId: string): boolean => sourceId.startsWith(CHAT_SOURCE_PREFIX);

interface ChatPreviewContext {
  deps: PreviewManagerDeps;
  live: Map<string, { taskId: string; port: number; url: string }>;
  log(msg: string, err?: unknown): void;
  teardown(sourceId: string): Promise<void>;
  bootPreview(sourceId: string): Promise<{ preview: { url: string; port: number } | null; reason: string | null; attempted: boolean }>;
  worktreeFor(sourceId: string): PreviewWorktree | null;
  isEvidencePage(page: { status: number; body: string }): boolean;
  notePrefix: string;
}

export function createChatPreviews(ctx: ChatPreviewContext) {
  const notePrefix = ctx.notePrefix;
  /** The chat's preview is switched off after this long without a turn: the pool is shared with the cards. */
  const chatIdleMs = ctx.deps.chatIdleMs ?? 30 * 60_000;
  const chatTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const chatBooting = new Set<string>();

  function armChatTimer(topicId: string): void {
    const key = chatSourceId(topicId);
    const old = chatTimers.get(key);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      chatTimers.delete(key);
      ctx.log(`[preview] chat ${topicId} idle: switching its preview off`);
      void ctx.teardown(key);
    }, chatIdleMs);
    (t as { unref?: () => void }).unref?.();
    chatTimers.set(key, t);
  }

  function noteChatTurn(topicId: string): void {
    if (ctx.live.has(chatSourceId(topicId))) armChatTimer(topicId);
  }

  async function ensureForChat(topicId: string, opts?: ChatPreviewOptions): Promise<void> {
    const key = chatSourceId(topicId);
    const auto = opts?.auto === true;
    const say = (content: string, media?: string[]) => {
      try { ctx.deps.postChatMessage?.(topicId, { content, media }); } catch (err) { ctx.log(`[preview] postChatMessage failed for ${topicId}`, err); }
    };
    if (chatBooting.has(key)) return;
    chatBooting.add(key);
    try {
      const wt = ctx.worktreeFor(key);
      if (!wt) { if (!auto) say(`${notePrefix} non disponibile. Questa chat non lavora in un worktree suo: nel checkout vivo l'app vera è già l'anteprima.`); return; }
      if (auto) {
        let ui = false;
        try { ui = (await ctx.deps.touchesInterface?.(wt)) === true; } catch { ui = false; }
        if (!ui) return;
        if (!ctx.deps.resolveCommand(key, wt)) return; // no start command: stay quiet
      }
      const res = await ctx.bootPreview(key);
      if (!res.preview) {
        if (res.attempted || !auto) say(`${notePrefix} non avviata. ${res.reason ?? "motivo sconosciuto"}.`);
        return;
      }
      armChatTimer(topicId);
      const url = res.preview.url;
      const page = ctx.deps.fetchPage ? await ctx.deps.fetchPage(url).catch(() => null) : null;
      if (page && !ctx.isEvidencePage(page)) {
        say(`${notePrefix} viva su ${url}, ma ${page.status >= 400 ? `ha risposto ${page.status}` : "mostra una pagina di placeholder"}. Il worktree probabilmente non ha un bundle costruito.`);
        return;
      }
      const outPath = join(ctx.deps.mediaDir, `chat-${topicId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}.png`);
      let shot = false;
      try { ctx.deps.ensureMediaDir(); shot = await ctx.deps.screenshot(url, outPath, { width: 1440 }); } catch (err) { ctx.log(`[preview] screenshot failed for ${key}`, err); }
      if (shot && ctx.deps.blankShot?.(outPath)) shot = false;
      if (shot && ctx.deps.emptyAppShell && (await ctx.deps.emptyAppShell(url).catch(() => false))) shot = false;
      say(shot ? `${notePrefix} viva su ${url}` : `${notePrefix} viva su ${url}, screenshot non catturato.`, shot ? [outPath] : undefined);
    } catch (err) {
      ctx.log(`[preview] ensureForChat failed for ${topicId}`, err);
    } finally {
      chatBooting.delete(key);
    }
  }

  function clearIdle(key: string): void {
    const idle = chatTimers.get(key);
    if (idle) { clearTimeout(idle); chatTimers.delete(key); }
  }

  function listChats() {
    return Array.from(ctx.live.values()).filter((p) => isChatSource(p.taskId)).map((p) => ({ topicId: p.taskId.slice(CHAT_SOURCE_PREFIX.length), port: p.port, url: p.url }));
  }

  return { ensureForChat, noteChatTurn, clearIdle, listChats };
}
