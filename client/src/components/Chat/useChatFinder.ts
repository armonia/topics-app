import { useEffect, useRef, type RefObject } from 'react';
import type { ChatMessage } from '../../types';
import { ApiError, searchApi } from '../../lib/api';
import { chatFind, mergeLiveHits, CHAT_FIND_MAX_HITS, type ChatFindHit, type FindableMessage } from '../../../../shared/chat-find';
import { getFindState, registerFinder, reportFindResult, subscribeFind, type PaneFinder } from '../../state/findRegistry';
import { requestScrollToMessage } from '../../state/scrollToMessage';
import { setChatFindFocus, getChatFindFocus } from '../../state/chatFindFocus';
import { stepMatchIndex } from '../Browser/findInPageModel';
import { clearFindHighlights, setFindHighlights } from '../../lib/findHighlights';
import { collectText, findMatches, locate, type TextNodeLike } from '../../lib/domFind';

/**
 * The chat's finder (CHAT-FIND-01…03).
 *
 * WHERE IT SEARCHES. Not the DOM: the list is virtual (the rows on screen plus
 * 400 px), the first page holds the last 40 messages, and a closed tool row
 * has no output at all on the client (the history strips it). The server
 * does: `POST /api/history-find` reads the whole thread with the outputs put
 * back from `message_tool_outputs`. The message streaming right now is
 * searched here, on the text that arrives live, with the same pure function,
 * and its hits replace the server's for the same message.
 *
 * A guest has no access to that route (it is outside the guest allowlist):
 * the refusal switches this finder to the client's own text and reasoning.
 *
 * GOING TO A RESULT reuses the palette's jump (`requestScrollToMessage`, which
 * centres the row and merges the missing history when it has to), and marks
 * the result current (`chatFindFocus`) so the closed reasoning, tool row,
 * tool group or clamped body that holds it opens. The word is painted with
 * the Custom Highlight API on the rows that are mounted, repainted when the
 * list mounts or unmounts rows; where it cannot be found on screen (markdown
 * that splits it, an output drawn in part) the row's own jump highlight is
 * what shows.
 */
export function useChatFinder(args: {
  paneId: string;
  topicId: string;
  sessionKey: string;
  messages: readonly ChatMessage[];
  streaming: boolean;
  paneRootRef: RefObject<HTMLElement | null>;
}): void {
  const { paneId, topicId, sessionKey, paneRootRef } = args;
  const messagesRef = useRef(args.messages);
  const streamingRef = useRef(args.streaming);
  useEffect(() => {
    messagesRef.current = args.messages;
    streamingRef.current = args.streaming;
  });

  // Shared between the finder (registered once per pane) and the effects that
  // follow the stream: what the last search answered.
  const stateRef = useRef<{
    query: string;
    matchCase: boolean;
    serverHits: ChatFindHit[];
    serverTotal: number;
    truncated: boolean;
    hits: ChatFindHit[];
    total: number;
    clientOnly: boolean;
    abort: AbortController | null;
    liveId: string | null;
  }>({ query: '', matchCase: false, serverHits: [], serverTotal: 0, truncated: false, hits: [], total: 0, clientOnly: false, abort: null, liveId: null });

  const owner = `chat-find-${paneId}`;

  useEffect(() => {
    const st = stateRef.current;
    const listEl = () => paneRootRef.current?.querySelector<HTMLElement>('[data-testid="chat-message-list"]') ?? null;

    /** The message streaming right now, if any. */
    const liveMessage = (): ChatMessage | null => {
      if (!streamingRef.current) return null;
      const msgs = messagesRef.current;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        if (m.role === 'assistant') return m;
        if (i < msgs.length - 3) break;
      }
      return null;
    };

    /** Server hits + the live message's own, totals kept exact. */
    const combine = () => {
      const live = liveMessage();
      st.liveId = live?.id ?? null;
      if (!live || st.clientOnly) {
        st.hits = st.serverHits;
        st.total = st.serverTotal;
        return;
      }
      const liveHits = chatFind([live as unknown as FindableMessage], st.query, { matchCase: st.matchCase }).hits;
      const serverForLive = st.serverHits.filter((h) => h.messageId === live.id).length;
      st.hits = mergeLiveHits(st.serverHits, live.id, liveHits);
      st.total = st.serverTotal - serverForLive + liveHits.length;
    };

    const clientSearch = () => {
      const r = chatFind(messagesRef.current as unknown as FindableMessage[], st.query, { matchCase: st.matchCase });
      // A guest: only what the client really has, the text and the reasoning.
      const hits = r.hits.filter((h) => h.part !== 'tool');
      return { hits, total: hits.length, truncated: false };
    };

    const fetchHits = async (): Promise<void> => {
      st.abort?.abort();
      if (!st.query) { st.serverHits = []; st.serverTotal = 0; st.truncated = false; return; }
      if (st.clientOnly) {
        const r = clientSearch();
        st.serverHits = r.hits; st.serverTotal = r.total; st.truncated = false;
        return;
      }
      const ac = new AbortController();
      st.abort = ac;
      try {
        const r = await searchApi.historyFind(sessionKey, st.query, st.matchCase, ac.signal);
        if (ac.signal.aborted) return;
        st.serverHits = r.hits; st.serverTotal = r.total; st.truncated = r.truncated;
      } catch (err) {
        if (ac.signal.aborted) throw err;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          st.clientOnly = true;
          const r = clientSearch();
          st.serverHits = r.hits; st.serverTotal = r.total; st.truncated = false;
          return;
        }
        throw err;
      }
    };

    // ── Painting ────────────────────────────────────────────────────────────
    let paintTimers: Array<ReturnType<typeof setTimeout>> = [];
    let observer: MutationObserver | null = null;
    let throttle: ReturnType<typeof setTimeout> | null = null;

    const paint = () => {
      const list = listEl();
      const doc = list?.ownerDocument;
      if (!list || !doc || !st.query || !getFindState(paneId).open) { clearFindHighlights(owner); return; }
      const all: Range[] = [];
      let current: Range | null = null;
      const focus = getChatFindFocus();
      const idx = getFindState(paneId).index;
      const curHit = idx > 0 ? st.hits[idx - 1] : undefined;
      // Which occurrence inside its message the current hit is.
      const ordinal = curHit ? st.hits.slice(0, idx - 1).filter((h) => h.messageId === curHit.messageId).length : -1;
      const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-message-id]'))
        .filter((r) => !r.parentElement?.closest('[data-message-id]'));
      for (const row of rows) {
        const { text, segments } = collectText(row as unknown as TextNodeLike);
        const matches = findMatches(text, st.query, st.matchCase);
        const ranges: Range[] = [];
        for (const [s, e] of matches) {
          const a = locate(segments, s, false);
          const b = locate(segments, e, true);
          if (!a || !b) continue;
          try {
            const r = doc.createRange();
            r.setStart(a.node as unknown as Node, a.offset);
            r.setEnd(b.node as unknown as Node, b.offset);
            ranges.push(r);
          } catch { /* node gone */ }
        }
        all.push(...ranges);
        if (curHit && focus && row.getAttribute('data-message-id') === curHit.messageId && ranges.length > 0) {
          current = ranges[Math.min(Math.max(0, ordinal), ranges.length - 1)] ?? null;
        }
      }
      setFindHighlights(owner, doc, all, current);
    };

    const schedulePaint = () => {
      for (const t of paintTimers) clearTimeout(t);
      // The jump scrolls on the next frame, a row that opens fetches its
      // output: paint now (the current match moves with the counter, not a
      // tick after it), and again when those have landed.
      paint();
      paintTimers = [100, 300, 700, 1500].map((ms) => setTimeout(paint, ms));
    };

    const watch = () => {
      if (observer || typeof MutationObserver === 'undefined') return;
      const list = listEl();
      if (!list) return;
      observer = new MutationObserver(() => {
        if (throttle) return;
        throttle = setTimeout(() => { throttle = null; paint(); }, 120);
      });
      observer.observe(list, { subtree: true, childList: true, characterData: true });
    };
    const stopWatching = () => {
      observer?.disconnect();
      observer = null;
      if (throttle) clearTimeout(throttle);
      throttle = null;
    };

    /** Order of a message in the conversation; -1 = not loaded (older). */
    const orderOf = () => {
      const m = new Map<string, number>();
      messagesRef.current.forEach((msg, i) => m.set(msg.id, i));
      return m;
    };

    /** The topmost row on screen: where the reader is (CHAT-FIND-01). */
    const readingRowOrder = (order: Map<string, number>): number | null => {
      const list = listEl();
      if (!list) return null;
      const top = list.getBoundingClientRect().top;
      for (const row of Array.from(list.querySelectorAll<HTMLElement>('[data-message-id]'))) {
        if (row.getBoundingClientRect().bottom <= top) continue;
        const o = order.get(row.getAttribute('data-message-id') ?? '');
        if (o !== undefined) return o;
      }
      return null;
    };

    const finder: PaneFinder = {
      placeholderKey: 'find.chat.placeholder',
      debounceMs: 250,
      async search(q, o) {
        st.query = q;
        st.matchCase = o.matchCase;
        await fetchHits();
        combine();
        reportFindResult(paneId, { overLimit: st.truncated ? CHAT_FIND_MAX_HITS : null });
        watch();
        schedulePaint();
        return st.total;
      },
      step(forward) {
        const n = st.hits.length;
        if (n === 0) return { index: 0, total: st.total };
        const cur = getFindState(paneId).index;
        let next: number;
        if (cur >= 1 && cur <= n) {
          next = stepMatchIndex(cur, n, forward);
        } else {
          // From rest: the first result BELOW the reading position going
          // forward, the first ABOVE going back; then the bar's wrap.
          const order = orderOf();
          const at = readingRowOrder(order);
          const pos = (h: ChatFindHit) => order.get(h.messageId) ?? -1;
          if (at === null) next = forward ? 1 : n;
          else if (forward) {
            const i = st.hits.findIndex((h) => pos(h) >= at);
            next = i >= 0 ? i + 1 : 1;
          } else {
            let i = -1;
            for (let k = n - 1; k >= 0; k--) if (pos(st.hits[k]!) < at) { i = k; break; }
            next = i >= 0 ? i + 1 : n;
          }
        }
        const h = st.hits[next - 1]!;
        setChatFindFocus({ topicId, messageId: h.messageId, part: h.part, toolCallId: h.toolCallId, query: st.query, matchCase: st.matchCase });
        requestScrollToMessage(topicId, h.messageId);
        return { index: next, total: st.total };
      },
      clear() {
        st.abort?.abort();
        st.query = '';
        st.hits = []; st.serverHits = []; st.total = 0; st.serverTotal = 0;
        for (const t of paintTimers) clearTimeout(t);
        paintTimers = [];
        stopWatching();
        clearFindHighlights(owner);
        const f = getChatFindFocus();
        if (f && f.topicId === topicId) setChatFindFocus(null);
      },
    };
    const off = registerFinder(paneId, finder);
    // Repaint the current one when the index moves (⌘G, Enter).
    let lastIndex = 0;
    const offSub = subscribeFind(paneId, () => {
      const fs = getFindState(paneId);
      if (fs.open && fs.index !== lastIndex) schedulePaint();
      lastIndex = fs.index;
    });
    return () => {
      offSub();
      off();
      finder.clear();
    };
  }, [paneId, topicId, sessionKey, paneRootRef, owner]);

  // ── The stream (CHAT-FIND-03) ─────────────────────────────────────────────
  // The live message is searched again when its text changes, at most every
  // 120 ms. The total grows; the index and the view stay where they are.
  const lastLiveRun = useRef(0);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const st = stateRef.current;
    if (!args.streaming || !st.query || !getFindState(paneId).open || st.clientOnly) return;
    const run = () => {
      lastLiveRun.current = Date.now();
      liveTimer.current = null;
      const live = (() => {
        const msgs = messagesRef.current;
        for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 3); i--) if (msgs[i]!.role === 'assistant') return msgs[i]!;
        return null;
      })();
      if (!live) return;
      const liveHits = chatFind([live as unknown as FindableMessage], st.query, { matchCase: st.matchCase }).hits;
      const serverForLive = st.serverHits.filter((h) => h.messageId === live.id).length;
      st.hits = mergeLiveHits(st.serverHits, live.id, liveHits);
      st.total = st.serverTotal - serverForLive + liveHits.length;
      reportFindResult(paneId, { total: st.total });
    };
    const wait = 120 - (Date.now() - lastLiveRun.current);
    if (wait <= 0) run();
    else if (!liveTimer.current) liveTimer.current = setTimeout(run, wait);
  }, [args.messages, args.streaming, paneId]);
  useEffect(() => () => { if (liveTimer.current) clearTimeout(liveTimer.current); }, []);

  // End of the turn: ask the server again (the turn is now stored, outputs
  // included), keeping the index.
  const wasStreaming = useRef(args.streaming);
  useEffect(() => {
    const was = wasStreaming.current;
    wasStreaming.current = args.streaming;
    const st = stateRef.current;
    if (!was || args.streaming || !st.query || !getFindState(paneId).open || st.clientOnly) return;
    const ac = new AbortController();
    st.abort?.abort();
    st.abort = ac;
    void searchApi.historyFind(sessionKey, st.query, st.matchCase, ac.signal).then((r) => {
      if (ac.signal.aborted) return;
      st.serverHits = r.hits; st.serverTotal = r.total; st.truncated = r.truncated;
      st.hits = r.hits; st.total = r.total;
      const idx = getFindState(paneId).index;
      reportFindResult(paneId, { total: r.total, index: Math.min(idx, r.hits.length), overLimit: r.truncated ? CHAT_FIND_MAX_HITS : null });
    }, () => { /* the next keystroke or Enter asks again */ });
  }, [args.streaming, paneId, sessionKey]);
}
