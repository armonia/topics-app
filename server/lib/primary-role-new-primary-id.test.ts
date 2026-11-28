/**
 * @covers MACHINE-07
 *
 * After a switch the new primary talks to the nodes with the tokens its predecessor
 * paired, so a node's channel still names the OLD machine. The id of the new
 * primary has to travel with the epoch: deduced from the channel, every node
 * adopted the new epoch under the old primary (`{"primaryMachineId":"m-old","epoch":2}`).
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrimaryRole } from "./primary-role";

const migration = readFileSync(join(import.meta.dir, "../db/migrations/20261118110000-primary-state.sql"), "utf-8");

function server(machineId: string) {
  const dir = mkdtempSync(join(tmpdir(), "primary-role-new-"));
  const db = new Database(":memory:");
  db.exec(migration);
  const role = createPrimaryRole({ db, stateFile: join(dir, "primary-state.json"), localMachineId: () => machineId, log: () => {} });
  return { role, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a node adopts the epoch under the machine the new primary declares, not the machine of the channel", () => {
  const oldPrimary = server("m-old");
  const newPrimary = server("m-new");
  const node = server("m-node");
  // The node was paired by the OLD primary: its channel is the old machine's device.
  node.role.adopt({ primaryMachineId: "m-old", epoch: 1 });
  node.role.recordChannel({ deviceId: "dev-old", machineId: "m-old" });
  // The switch: the new primary is chosen at epoch 2 and keeps using the old primary's token (same device).
  oldPrimary.role.adopt({ primaryMachineId: "m-new", epoch: 2 });
  newPrimary.role.adopt({ primaryMachineId: "m-new", epoch: 2 });
  const call = new Request("http://node/api/nodes/runs", { headers: newPrimary.role.outgoingHeaders() });

  expect(node.role.adoptFrom(call, { deviceId: "dev-old" })).toBe(true);
  expect(node.role.state()).toMatchObject({ primaryMachineId: "m-new", epoch: 2 });
  expect(node.role.isPrimary()).toBe(false);
  // The old primary no longer declares anything.
  expect(oldPrimary.role.outgoingHeaders()).toEqual({});
  // Only the channel's device moves the epoch, whatever id a request declares.
  const stranger = server("m-node-2");
  stranger.role.adopt({ primaryMachineId: "m-old", epoch: 1 });
  stranger.role.recordChannel({ deviceId: "dev-old", machineId: "m-old" });
  expect(stranger.role.adoptFrom(call, { deviceId: "dev-other" })).toBe(false);
  expect(stranger.role.state()).toMatchObject({ primaryMachineId: "m-old", epoch: 1 });
  for (const s of [oldPrimary, newPrimary, node, stranger]) s.done();
});
