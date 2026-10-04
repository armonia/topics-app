import { recordedBackgroundSession } from "./server/providers/claude/background-work.fixture";
import { newBackgroundWork, noteBackgroundLine, hasLiveTasks, hasArmedCron, isWakeQueued, describeBackgroundWork } from "./server/providers/claude/background-work";
const events = recordedBackgroundSession();
const w = newBackgroundWork();
let t = Date.now(); let turnOpen = false; let n = 0;
for (const e of events as any[]) {
  t += 10;
  if (e.type === "system" && e.subtype === "init") turnOpen = true;
  noteBackgroundLine(w, e, t, { unattended: !turnOpen });
  if (e.type === "result") {
    n++;
    const state = hasLiveTasks(w, t) || hasArmedCron(w, t) ? "running" : isWakeQueued(w, t) ? "wake-queued" : "none";
    const tasks = describeBackgroundWork(w, t).tasks.map((x: any) => x.type + ":" + x.description).join(" | ");
    console.log(`turn end #${n} result=${JSON.stringify(String(e.result).slice(0, 50))} background=${state} tasks=[${tasks}]`);
    turnOpen = false;
  }
}
