/**
 * Helper script for the subprocess survival test (serial-queue.test.ts).
 *
 * Spawned by the test runner as a CHILD PROCESS via Bun.spawn. Demonstrates
 * that a rejecting fn does NOT kill the process when the caller handles the
 * error — even with a live setInterval keeping the event loop warm.
 *
 * Expected output (on stdout, one line):
 *   caller handled
 * Expected exit code: 0
 *
 * With the OLD `.finally()` form the setInterval fires before the unhandled
 * rejection is GC-d and Bun terminates with exit code 1.
 */

import { makeSerialQueue } from "./serial-queue";

const q = makeSerialQueue();

// Keep the event loop alive — exactly the condition that triggers the crash.
const timer = setInterval(() => {}, 100_000);

// Enqueue a fn that rejects; the caller catches the error.
q.enqueue("k", () => Promise.reject(new Error("git fallita")))
  .catch(() => {
    process.stdout.write("caller handled\n");
    clearInterval(timer);
    // Give the map-tail microtask a tick to flush, then exit cleanly.
    setTimeout(() => process.exit(0), 0);
  });
