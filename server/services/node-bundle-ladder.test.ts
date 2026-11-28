/**
 * A node that lacks the bundle prerequisites gets progressively wider bundles.
 * @covers KANBAN-76
 */
import { describe, expect, it } from "bun:test";
import { NodeError } from "./node-client";
import { createRunWithBundle } from "./node-bundle-ladder";

describe("node bundle ladder", () => {
  it("retries a refusal whose prerequisite line the node cut away", async () => {
    // Two missing commits: the node's last 120 characters of stderr hold only the hashes.
    const sha = "83c5df80b8339d0c0e06a9d4721b856478aeea6f";
    const cut = new NodeError("rejected", `create run answered 400: branchBundle: invalid bundle: ${sha}.\nerror: ${sha}.`, 400);
    let creates = 0;
    const result = await createRunWithBundle(async (reach) => new Uint8Array([reach === 0 ? 1 : 2]), async () => { if (++creates === 1) throw cut; return "started"; }, [0, 200]);
    expect(result).toBe("started");
    expect(creates).toBe(2);
  });

  it("rethrows non-prerequisite errors without making another bundle", async () => {
    const error = new NodeError("rejected", "create run answered 400: bad request", 400);
    let made = 0;
    await expect(createRunWithBundle(async () => { made++; return new Uint8Array([1]); }, async () => { throw error; }, [0, 200])).rejects.toBe(error);
    expect(made).toBe(1);
  });

  it("throws the last prerequisite refusal when every rung is refused", async () => {
    const errors = [0, 1, 2].map((n) => new NodeError("rejected", `prerequisite ${n}`, 400));
    let call = 0;
    await expect(createRunWithBundle(async () => new Uint8Array([++call]), async () => { throw errors[call - 1]; }, [0, 200, "whole"]))
      .rejects.toBe(errors[2]);
  });

  it("returns null when the first bundle cannot be made", async () => {
    let creates = 0;
    expect(await createRunWithBundle(async () => null, async () => { creates++; return true; })).toBeNull();
    expect(creates).toBe(0);
  });

  it("skips a byte-identical next bundle", async () => {
    let creates = 0;
    const result = await createRunWithBundle(async (reach) => reach === 0 ? new Uint8Array([1]) : new Uint8Array([1]), async () => ++creates, [0, 200, "whole"]);
    expect(result).toBe(1);
    expect(creates).toBe(1);
  });
});
