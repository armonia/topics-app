/**
 * The question put to the REAL DISCORD: does it honour an external `large_image`?
 *
 * WHY A TEST THAT TALKS TO THE WORLD
 * For a year the code carried a note saying no, Discord ignores external URLs
 * until you upload an asset on the developer portal - and that therefore the
 * last step was not code but manual work done by hand by a human. No fake test
 * could disprove it: a stub `IpcSocket` answers whatever we taught it to
 * answer. It was disproved by the only thing that knew the truth, namely
 * Discord.
 *
 * The fact measured on 24/08, with the application at ZERO assets: the URL goes
 * through and comes back rewritten as `mp:external/...`, the shape Discord uses
 * to say "I have taken charge of it, it goes out from my own CDN".
 *
 * THE NEGATIVE CONTROL IS THE TEST
 * A field coming back means nothing if it always comes back. So we also send a
 * made-up key: that one DISAPPEARS from the reply. It is the difference between
 * the two received that says the URL was genuinely accepted, and without the
 * negative case this file would be a tautology.
 *
 * IT SKIPS ITSELF when Discord is not there (CI, someone else's machine, app
 * closed): a test that depends on the world must not paint a suite red over a
 * fact that has nothing to do with the code.
 *
 * AND IT ALSO SKIPS WHEN IT WAS NOT ASKED FOR. Discord serves one client at a
 * time on that socket: running this while the Topics server is connected tears
 * its wire away, and the presence stays in `error` until the backoff brings it
 * back up - measured, ~70 seconds of a wrong card on the profile of someone who
 * was only running the tests. A test that breaks what it observes runs when you
 * want it to, not by accident: it needs `DISCORD_LIVE_TEST=1`.
 *
 * @covers DISCORD-02
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFrameDecoder, encodeFrame, handshake, IPC_OP } from "./discord-ipc";
import { DEFAULT_CLIENT_ID, DEFAULT_LARGE_IMAGE } from "./discord-presence";

/**
 * Discord's socket, looked for where the system actually puts it.
 *
 * `tmpdir()` is not enough: under a supervisor (or inside this agent) the
 * process TMPDIR is a private directory, while Discord writes into the user's
 * TMPDIR. We look at both.
 */
function socketDiscord(): string | null {
  const roots = [tmpdir(), process.env.TMPDIR ?? "", "/tmp"].filter(Boolean);
  // The user's TMPDIR, the real one, for when ours has been redirected.
  try {
    for (const base of ["/var/folders"]) {
      if (!existsSync(base)) continue;
      for (const a of readdirSync(base).slice(0, 40)) {
        const dir = join(base, a);
        try {
          for (const b of readdirSync(dir).slice(0, 40)) roots.push(join(dir, b, "T"));
        } catch { /* permissions: carry on */ }
      }
    }
  } catch { /* no /var/folders: fall back to the plain roots */ }

  for (const r of roots) {
    for (let i = 0; i < 10; i++) {
      const p = join(r, `discord-ipc-${i}`);
      try {
        if (existsSync(p)) return p;
      } catch { /* not readable: move on */ }
    }
  }
  return null;
}

/**
 * The test talks to the world only if you ask it to AND if the world is there.
 * Both conditions, because either one on its own is enough to produce a red
 * that says nothing about the code.
 */
const ENABLED = process.env.DISCORD_LIVE_TEST === "1";
const SOCK = ENABLED ? socketDiscord() : null;

describe.skipIf(!SOCK)("Discord vero: gli asset che accetta", () => {
  test("onora un large_image esterno anche senza asset caricati sul portale", async () => {
    const r = await handshake({ clientId: DEFAULT_CLIENT_ID, candidates: [SOCK!], timeoutMs: 8000 });
    const sock = r.socket as unknown as {
      on: (e: string, f: (c: Uint8Array) => void) => void;
      write: (b: Uint8Array) => void;
      end?: () => void;
      destroy?: () => void;
    };
    const decode = createFrameDecoder();
    const received: Array<Record<string, any>> = [];
    sock.on("data", (c) => { for (const f of decode(c)) received.push(f.payload as any); });

    async function publish(nonce: string, large: string): Promise<Record<string, any> | undefined> {
      sock.write(encodeFrame(IPC_OP.FRAME, {
        cmd: "SET_ACTIVITY",
        nonce,
        args: { pid: process.pid, activity: { details: "test", state: nonce, assets: { large_image: large, large_text: "Topics" } } },
      }));
      for (let i = 0; i < 30; i++) {
        const found = received.find((x) => x?.nonce === nonce);
        if (found) return found;
        await new Promise((s) => setTimeout(s, 100));
      }
      return undefined;
    }

    try {
      const external = await publish("esterno", DEFAULT_LARGE_IMAGE);
      const madeUp = await publish("inventata", "chiave_che_non_esiste_42");

      // The external URL survives, and Discord rewrites it as a resource of its own.
      expect(external?.data?.assets?.large_image).toBeTruthy();
      expect(String(external?.data?.assets?.large_image)).toStartWith("mp:external/");

      // The negative control: a key that does not exist gets thrown away.
      // Without this line, the one above would prove nothing.
      expect(madeUp?.data?.assets?.large_image).toBeUndefined();
    } finally {
      // We do not leave a test presence lying around on the runner's profile.
      sock.write(encodeFrame(IPC_OP.FRAME, { cmd: "SET_ACTIVITY", nonce: "pulizia", args: { pid: process.pid, activity: null } }));
      await new Promise((s) => setTimeout(s, 300));
      sock.end?.();
      sock.destroy?.();
    }
  }, 30_000);
});
