/** @covers WIRE-03 */
import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { sendWsFrame } from "./ws-send";
import type { WSData } from "../types";

describe("initial recovery frame compression", () => {
  test("a remote ui-state snapshot requests compression while local, tiny and image frames do not", () => {
    const payload = JSON.stringify({ type: "ui-state:init", data: Object.fromEntries(
      Array.from({ length: 413 }, (_, i) => [`project-pane:${i}`, {
        tabs: [{ id: `browser:${i}`, title: `Fixture project ${i}`, url: `http://localhost:${4000 + i}` }],
        layout: { direction: "horizontal", sizes: [50, 50], active: `browser:${i}` },
      }]),
    ) });
    const flags: Array<boolean | undefined> = [];
    const ws = {
      data: { id: "fixture", remote: true, focusedTopicId: null, lastPong: 0 } as WSData,
      send: (data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer, compressed?: boolean) => {
        flags.push(compressed);
        return typeof data === "string" ? data.length : 0;
      },
    };
    sendWsFrame(ws, payload, "ui-state:init");
    sendWsFrame(ws, "small", "unread:init");
    sendWsFrame(ws, payload, "frame");
    ws.data.remote = false;
    sendWsFrame(ws, payload, "ui-state:init");
    // A bounded synthetic cost sample, not an assertion on machine speed or
    // Bun's actual wire encoding. The first five iterations warm up zlib.
    const samples: number[] = [];
    let deflateBytes = 0;
    for (let i = 0; i < 25; i++) {
      const started = performance.now();
      deflateBytes = deflateRawSync(payload).byteLength;
      if (i >= 5) samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    console.log("RUNTIME-COST bootstrap", JSON.stringify({ rawBytes: Buffer.byteLength(payload), deflateBytes,
      medianDeflateMs: samples[Math.floor(samples.length / 2)], compressionRequested: flags[0] ?? false }));
    expect(flags).toEqual([true, false, false, false]);
  });
});
