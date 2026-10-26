// Probe on a real session: do interrupt + archive really stop it?
import { CloudApi } from "../../../server/providers/claude-cloud/api";
import { credentialsFor } from "../../../server/providers/claude-cloud/creds";

const api = new CloudApi(credentialsFor());
const sid = await api.createSession({
  title: "prova stop (Topics)",
  prompt: "Esegui il comando `sleep 240` con Bash e poi rispondi solo «finito». Non fare altro.",
  source: { repo: "armonia/topics-app", revision: "main" },
  deliveryBranch: "claude/stop-probe",
  model: "claude-haiku-5-5",
  environmentId: await api.defaultEnvironmentId(),
});
console.log("sessione", sid);
let cursor: string | undefined;
const seen: string[] = [];
async function drain() {
  for (;;) {
    const p = await api.events(sid, cursor);
    if (p.last_id) cursor = p.last_id;
    for (const e of p.data) seen.push(`${e.type}${e.subtype ? "/" + e.subtype : ""}`);
    if (!p.has_more) return;
  }
}
const t0 = Date.now();
while (Date.now() - t0 < 180_000) {
  await drain();
  if (seen.includes("assistant")) break;
  await Bun.sleep(3000);
}
console.log("prima dello stop:", seen.join(" "));
const before = seen.length;
await api.stopSession(sid);
console.log("stop inviato a", Math.round((Date.now() - t0) / 1000), "s");
for (let i = 0; i < 20; i++) { await Bun.sleep(3000); await drain(); }
console.log("dopo lo stop:", seen.slice(before).join(" ") || "(niente)");
const s = await api.getSession(sid);
console.log("stato:", JSON.stringify(s).slice(0, 300));
