/**
 * A server-shaped process for `sqlite-busy.test.ts`: a write reached by a timer
 * or by a promise nobody awaits meets a database another connection holds
 * locked, with a real SQLITE_BUSY from bun:sqlite.
 *
 * The verdict is the exit code, because that is what a busy database cost the
 * server: thrown out of a timer, the error reaches the `uncaughtException` net
 * of `server.ts`, which rethrows it, and Bun exits 7; rejected in a promise
 * nobody awaits, Bun exits 1 and the net never sees it. Exit 0 with one JSON
 * line on stdout means the process stayed up and the write landed on a later
 * try; exit 2 means it stayed up and the write never arrived.
 *
 * Usage: bun sqlite-busy.paths.fixture.ts <timer|promise> <cured|bare> <db path>
 *  - timer: the write runs in a `setTimeout`, as the stale-stream sweep, the
 *    two watchdogs of the chat route and the ask-user TTL do;
 *  - promise: the write runs in an async function called with `void`, as the
 *    provider callbacks call `finalizeStream` and the dispatcher `resume`;
 *  - cured: through `writeWhenFree` (timer) or `.catch(warnIfBusy(...))`
 *    (promise); bare: the call as it was before the cure.
 *
 * The wait loop is not a top-level await: while the module is still
 * evaluating, a timer's exception is printed and the process goes on, so the
 * bare code would pass for alive (measured on Bun 1.3.8).
 */
import { Database } from "bun:sqlite";
import { warnIfBusy, writeWhenFree } from "./sqlite-busy";

// The net of server.ts, for an error whose code is not a socket hang-up.
process.on("uncaughtException", (err) => { throw err; });

const [mode, cure, path] = process.argv.slice(2);
if (!path || (mode !== "timer" && mode !== "promise") || (cure !== "cured" && cure !== "bare")) {
  throw new Error("usage: sqlite-busy.paths.fixture.ts <timer|promise> <cured|bare> <db path>");
}

const holder = new Database(path);
holder.run("PRAGMA journal_mode = WAL");
holder.run("CREATE TABLE row (id INTEGER PRIMARY KEY, closed INTEGER NOT NULL)");
holder.run("INSERT INTO row (id, closed) VALUES (1, 0)");

// The server's connection, with a short busy_timeout: 50 ms instead of 10 s.
const server = new Database(path);
server.run("PRAGMA busy_timeout = 50");
const close = server.prepare("UPDATE row SET closed = 1 WHERE id = 1");
let tries = 0;
const write = () => { tries++; close.run(); };
const silent = () => {};

// Another connection holds the write lock (a replicator checkpointing, a backup).
holder.run("BEGIN IMMEDIATE");

if (mode === "timer") {
  setTimeout(() => {
    if (cure === "cured") writeWhenFree("fixture close", write, { delaysMs: [100, 100, 100], warn: silent });
    else write();
  }, 10);
} else {
  const finalize = async () => { await Promise.resolve(); write(); };
  setTimeout(() => {
    if (cure === "cured") {
      // A promise pass skips with a warning; the write itself is retried by
      // `writeWhenFree` inside it, as `finalizeStream` does.
      void (async () => { await Promise.resolve(); writeWhenFree("fixture final write", write, { delaysMs: [100, 100, 100], warn: silent }); })().catch(warnIfBusy("fixture finalize", silent));
    } else {
      void finalize();
    }
  }, 10);
}

const read = () => (holder.query("SELECT closed FROM row WHERE id = 1").get() as { closed: number }).closed;
const deadline = performance.now() + 5_000;
let released = false;
// A ref'd poll: the retry timer is unref'd and would let the process end first.
const poll = setInterval(() => {
  // The lock goes away only after one refusal, so what lands is the retry.
  if (!released && tries >= 1) {
    holder.run("COMMIT");
    released = true;
  }
  const landed = released && read() === 1;
  if (!landed && performance.now() < deadline) return;
  clearInterval(poll);
  console.log(JSON.stringify({ closed: read(), tries, released }));
  server.close();
  holder.close();
  process.exit(landed ? 0 : 2);
}, 20);
