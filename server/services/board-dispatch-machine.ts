/**
 * Writing `board_settings.dispatch_machine_id` is only allowed for a machine the
 * cards can really run on, otherwise every new card of the board would be born
 * pointing at a place that parks it forever.
 *
 * Two kinds of machine are valid: the local one (meaning "here") and a PAIRED node, a `machines` row with a `base_url`.
 * For a node the board's repository must also have a git `origin`: the node
 * finds the project by that URL (`no_such_repo` otherwise), and the coordinator
 * parks a card whose project has none.
 */
import { SPAWN_TIMEOUT, spawnBounded } from "../lib/bounded-spawn";
import type { MachineStore } from "./machine-store";

export type DispatchMachineCheck =
  | { ok: true }
  | { ok: false; code: "unknown_machine" | "not_a_node" | "no_git_origin"; error: string };

/** `git remote get-url origin` of a checkout, or null when there is none. */
async function gitOriginOf(path: string): Promise<string | null> {
  const proc = spawnBounded(["git", "-C", path, "remote", "get-url", "origin"], {
    stdout: "pipe", stderr: "ignore", timeoutMs: SPAWN_TIMEOUT.query,
  });
  const out = (await new Response(proc.stdout).text()).trim();
  return (await proc.exited) === 0 && out ? out : null;
}

export async function checkDispatchMachine(args: {
  machines: Pick<MachineStore, "get" | "upsertLocal">;
  machineId: string;
  /** Checkout of the board's project, or null when the board has none registered. */
  projectPath: string | null;
  /** Injectable for tests that have no repository on disk. */
  originOf?: (path: string) => Promise<string | null>;
}): Promise<DispatchMachineCheck> {
  const { machines, machineId, projectPath } = args;
  const machine = machines.get(machineId);
  if (!machine) {
    return { ok: false, code: "unknown_machine", error: `Il computer "${machineId}" non è tra quelli collegati.` };
  }
  if (machine.id === machines.upsertLocal().id) return { ok: true };
  if (!machine.baseUrl) {
    return {
      ok: false, code: "not_a_node",
      error: `"${machine.name}" non è un computer abbinato: senza un indirizzo a cui rispondere non può eseguire le card.`,
    };
  }
  const origin = projectPath ? await (args.originOf ?? gitOriginOf)(projectPath) : null;
  if (!origin) {
    return {
      ok: false, code: "no_git_origin",
      error: "Il progetto di questa board non ha un remote git \"origin\": il computer abbinato ritrova il progetto da quell'indirizzo, " +
        "e senza le card resterebbero ferme per sempre.",
    };
  }
  return { ok: true };
}
