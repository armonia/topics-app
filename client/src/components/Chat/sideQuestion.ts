import { serverTurnOf, subscribeServerTurn, type ServerTurn } from '../../state/serverTurn';
import { subscribeSession } from '../../state/messageStore';

type SideMessage = { role: string; content?: string; partial?: boolean };

/** Why a side question gave no answer; the panel turns the code into the reader's language. */
export class SideQuestionError extends Error {
  constructor(readonly code: "not-started" | "no-answer") { super(code); }
}

/** Own the fork lifecycle so every accepted or aborted request cleans it exactly once. */
export async function runSideQuestionFork<T extends { id: string; sessionKey: string }>(options: {
  createFork: () => Promise<T>;
  ask: (fork: T) => Promise<string>;
  closeFork: (fork: T) => Promise<void>;
  onClosed: (sessionKey: string) => void;
}): Promise<string> {
  const fork = await options.createFork();
  try {
    return await options.ask(fork);
  } finally {
    try { await options.closeFork(fork); }
    finally { options.onClosed(fork.sessionKey); }
  }
}

const TURN_TIMEOUT_MS = 120_000;

function sameTurn(a: ServerTurn | undefined, b: ServerTurn): boolean {
  return a?.boot === b.boot && a.turnId === b.turnId;
}

/** A turn the session had not started when the wait began (a new boot counts its turns again). */
function laterTurn(before: ServerTurn | undefined, current: ServerTurn): boolean {
  if (!before || before.boot !== current.boot) return current.turnId > 0;
  return current.turnId > before.turnId;
}

/** Wait for the turn opened by this send, and always release both store listeners. */
function createSideTurnWaiter(sessionKey: string, signal: AbortSignal, dependencies: {
  getTurn: typeof serverTurnOf;
  subscribeTurn: typeof subscribeServerTurn;
  subscribeMessages: typeof subscribeSession;
}) {
  const before = dependencies.getTurn(sessionKey);
  let target: ServerTurn | undefined;
  let dispose = () => {};
  let resolveWait: (() => void) | undefined;
  let rejectWait: ((error: Error) => void) | undefined;
  let complete = false;
  const onTurn = () => {
    const current = dependencies.getTurn(sessionKey);
    if (!current) return;
    if (current.open) {
      if (!before?.open || !sameTurn(before, current)) target = current;
    } else if (target ? sameTurn(target, current) : laterTurn(before, current)) {
      // The close of a turn whose open this window never heard (a snapshot after a reconnect)
      // still ends the wait: it is a turn that started after the question was sent.
      complete = true;
      dispose();
      resolveWait?.();
    }
  };
  const onMessage = () => {};
  const offTurn = dependencies.subscribeTurn(sessionKey, onTurn);
  const offMessages = dependencies.subscribeMessages(sessionKey, onMessage);
  const cleanup = () => {
    offTurn();
    offMessages();
    signal.removeEventListener('abort', onAbort);
  };
  const onAbort = () => {
    cleanup();
    rejectWait?.(new DOMException('Side question was closed', 'AbortError'));
  };
  dispose = cleanup;
  signal.addEventListener('abort', onAbort, { once: true });
  onTurn();
  return {
    wait: () => new Promise<void>((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
      if (complete) { cleanup(); resolve(); return; }
      if (signal.aborted) { onAbort(); return; }
    }),
    cancel: cleanup,
  };
}

export async function askSideQuestion(options: {
  mainSessionKey: string;
  sideSessionKey: string;
  question: string;
  loadHistory: (sessionKey: string) => Promise<unknown>;
  sendMessage: (sessionKey: string, content: string) => Promise<boolean>;
  getSessionMessages: (sessionKey: string) => SideMessage[];
  signal?: AbortSignal;
  subscribeTurn?: typeof subscribeServerTurn;
  getTurn?: typeof serverTurnOf;
  subscribeMessages?: typeof subscribeSession;
}): Promise<string> {
  if (options.mainSessionKey === options.sideSessionKey) throw new Error("side question must use its forked session");
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new SideQuestionError('no-answer')), TURN_TIMEOUT_MS);
  });
  let waiter: ReturnType<typeof createSideTurnWaiter> | undefined;
  try {
    await Promise.race([options.loadHistory(options.sideSessionKey), deadline]);
    if (options.signal?.aborted) throw new DOMException('Side question was closed', 'AbortError');
    const messagesBeforeSend = options.getSessionMessages(options.sideSessionKey).length;
    const signal = options.signal ?? new AbortController().signal;
    waiter = createSideTurnWaiter(options.sideSessionKey, signal, {
      getTurn: options.getTurn ?? serverTurnOf,
      subscribeTurn: options.subscribeTurn ?? subscribeServerTurn,
      subscribeMessages: options.subscribeMessages ?? subscribeSession,
    });
    const accepted = await Promise.race([options.sendMessage(options.sideSessionKey, options.question), deadline]);
    if (!accepted) throw new SideQuestionError("not-started");
    await Promise.race([waiter.wait(), deadline]);
    const answer = [...options.getSessionMessages(options.sideSessionKey).slice(messagesBeforeSend)].reverse()
      .find((message) => message.role === "assistant" && !message.partial)?.content?.trim();
    if (!answer) throw new SideQuestionError("no-answer");
    return answer;
  } finally {
    waiter?.cancel();
    if (timeoutId) clearTimeout(timeoutId);
  }
}
