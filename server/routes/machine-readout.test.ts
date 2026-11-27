/** @covers HUBBR-21 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createMachineReadoutRoute, machineReadoutDir } from "./machine-readout";
import type { AppContext } from "../types";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("machine readout of a node", () => {
  test("two readings at the same moment make ONE call to the node and see the same picture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "readout-"));
    try {
      mkdirSync(join(dir, "nodes"));
      writeFileSync(join(dir, "nodes", "pc-1.token"), "t".repeat(32));
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return Response.json({ readout: { at: calls } });
      }) as unknown as typeof fetch;
      const ctx = {
        STATE_DIR: dir,
        machineStore: {
          upsertLocal: () => ({ id: "mac-1", name: "Mac" }),
          get: (id: string) => (id === "pc-1" ? { id: "pc-1", name: "PC", baseUrl: "http://pc.local:3333" } : null),
        },
      } as unknown as AppContext;
      const route = createMachineReadoutRoute(ctx);
      const url = new URL("http://x/api/system/machine-readout?machine=pc-1");
      const [a, b] = await Promise.all([route(url), route(url)]);
      expect(calls).toBe(1);
      expect(await a.json()).toEqual(await b.json());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("machine readout folder", () => {
  const saved = process.env.TOPICS_MACHINE_READOUT_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.TOPICS_MACHINE_READOUT_DIR;
    else process.env.TOPICS_MACHINE_READOUT_DIR = saved;
  });

  test("without the variable no folder is read, on any platform", () => {
    delete process.env.TOPICS_MACHINE_READOUT_DIR;
    expect(machineReadoutDir()).toBeNull();
    process.env.TOPICS_MACHINE_READOUT_DIR = "   ";
    expect(machineReadoutDir()).toBeNull();
  });

  test("with TOPICS_MACHINE_READOUT_DIR set it reads from there", () => {
    process.env.TOPICS_MACHINE_READOUT_DIR = " /srv/readout ";
    expect(machineReadoutDir()).toBe("/srv/readout");
  });
});
