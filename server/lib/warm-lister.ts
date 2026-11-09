/**
 * A WARM LISTER: one child process kept alive between readings, asked for a
 * listing by a line on its stdin and answering until an end marker.
 *
 * WHY. On the Windows PC a fresh `powershell.exe` per reading costs 0.4-1.4 s
 * of CPU (measured: 531, 531, 438, 1438, 594 ms over five launches) because
 * most of it is PowerShell starting up. The same `Get-Process` in a shell
 * already running costs about 16 ms (measured: 78 ms for five). The load
 * screen reads every 20 s, so a cold shell was a steady 2-7% of a core on the
 * machine whose sleep keeper must not see the screen as work.
 *
 * LIFETIME. The child starts on the first request and stops after `idleMs`
 * without one, so a screen that is switched off leaves nothing running. It
 * also stops by itself when this server dies: its stdin closes, its read
 * returns end of file, its loop ends. A request that does not answer within
 * `timeoutMs` kills the child; the next one starts a fresh child.
 */

export interface WarmListerOptions {
  /** The child: a loop that prints a listing and then `endMarker` for every line it reads. */
  argv: string[];
  endMarker: string;
  idleMs?: number;
  timeoutMs?: number;
}

interface Child {
  proc: ReturnType<typeof Bun.spawn>;
  stdin: { write(chunk: string): unknown; flush(): unknown; end(): unknown };
  buffer: string;
  waiting: { resolve: (text: string) => void; reject: (e: Error) => void } | null;
}

export interface WarmLister {
  /** One listing: the child's output between the request and the end marker. */
  read(): Promise<string>;
  /** Stops the child now (tests, shutdown). */
  stop(): void;
  /** Whether a child is alive right now. */
  running(): boolean;
}

export function createWarmLister(opts: WarmListerOptions): WarmLister {
  const idleMs = opts.idleMs ?? 120_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const marker = `${opts.endMarker}\n`;
  let child: Child | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const kill = (c: Child, why: string) => {
    if (child === c) child = null;
    try { c.stdin.end(); } catch { /* already closed */ }
    try { c.proc.kill(); } catch { /* already gone */ }
    c.waiting?.reject(new Error(why));
    c.waiting = null;
  };

  const start = (): Child => {
    const proc = Bun.spawn(opts.argv, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const c: Child = { proc, stdin: proc.stdin as Child["stdin"], buffer: "", waiting: null };
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          c.buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
          const at = c.buffer.indexOf(marker);
          if (at >= 0 && c.waiting) {
            const text = c.buffer.slice(0, at);
            c.buffer = c.buffer.slice(at + marker.length);
            const w = c.waiting;
            c.waiting = null;
            w.resolve(text);
          }
        }
      } catch { /* the stream broke: handled as an exit below */ }
      kill(c, "lister exited");
    })();
    return c;
  };

  const once = (): Promise<string> => new Promise<string>((resolve, reject) => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const c = child ?? (child = start());
    c.buffer = "";
    const timer = setTimeout(() => kill(c, "lister timed out"), timeoutMs);
    c.waiting = {
      resolve: (text) => { clearTimeout(timer); resolve(text); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    };
    try {
      c.stdin.write("\n");
      c.stdin.flush();
    } catch (e) {
      kill(c, e instanceof Error ? e.message : String(e));
    }
  }).finally(() => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (child) kill(child, "idle"); }, idleMs);
  });

  return {
    // One request at a time: the child answers in order and the marker splits the answers.
    read: () => {
      const next = queue.then(once, once);
      queue = next.catch(() => undefined);
      return next;
    },
    stop: () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (child) kill(child, "stopped");
    },
    running: () => child !== null,
  };
}
