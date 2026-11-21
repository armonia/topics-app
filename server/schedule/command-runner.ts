/**
 * The production `CommandRunner`: scheduled commands run in the registry of
 * processes (`routes/processes-commands.ts`, origin `job`), and what the engine
 * reads back comes from the files and the process groups the wrapper leaves,
 * never from the registry's memory. That is why a run still closes when
 * `scripts.json` was lost or the server restarted (R12).
 */
import { existsSync } from "node:fs";
import { readExitCode } from "../lib/command-process";
import { listCommandProcessGroups, commandProcessGroup } from "../lib/command-process-groups";
import { readFileEnd } from "../lib/file-tail";
import { exitPathOf, logPathOf, stderrPathOf, timeoutMarkPathOf } from "../routes/processes-persist";
import { setJobCommandEndListener, startJobCommandProcess, stopJobCommand } from "../routes/processes-commands";
import type { CommandRunner } from "./command-action";
import { commandLife, kernelProbes, type LifeProbes } from "./command-life";
import { OUTPUT_TAIL_BYTES } from "./command-action";

const JOB_OWNER = /^job:(.+)$/;

const tailOf = (path: string) => readFileEnd(path, OUTPUT_TAIL_BYTES)?.text ?? "";

export function createRegistryRunner(probes: LifeProbes = kernelProbes): CommandRunner & { onEnd: typeof setJobCommandEndListener } {
  return {
    start(spec) {
      const { processId } = startJobCommandProcess(spec);
      return { processId };
    },
    life: (processId) => commandLife(commandProcessGroup(processId), probes),
    report(processId) {
      const exitCode = readExitCode(exitPathOf(processId));
      return exitCode === null ? null : { exitCode, timedOut: existsSync(timeoutMarkPathOf(processId)) };
    },
    stop: stopJobCommand,
    tails: (processId) => ({ stdout: tailOf(logPathOf(processId)), stderr: tailOf(stderrPathOf(processId)) }),
    jobGroups: () => listCommandProcessGroups().flatMap((group) => {
      const owner = JOB_OWNER.exec(group.ownerKey);
      return owner && commandLife(group, probes) !== "dead" ? [{ processId: group.processId, jobId: owner[1] }] : [];
    }),
    onEnd: setJobCommandEndListener,
  };
}
