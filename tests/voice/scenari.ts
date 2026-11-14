#!/usr/bin/env bun
/**
 * The bench of the phone calls, played against Topics through the bridge: a
 * fake channel per call that speaks the real phrases of past calls (WAV clips)
 * in real time (60 ms frames), plays the agent's side (results, steps of the job), and checks
 * what the call did. Ported from the scenario test of jarvis-channels
 * `tests/voce.rs`, with the same checks, named as the keys of scenari.json:
 * affida, chiude, riferisce, breve, racconta, passi_non_dicono, non_ripete, rilancia.  allow-italian: the keys of scenari.json
 *
 *   TOPICS_VOICE_SCENARIOS=<dir with scenari.json and the clips> \
 *   bun run tests/voice/scenari.ts --giri 2 [--solo <id>] [--insieme 3] [--url ws://127.0.0.1:13334/ws/voice/bridge]
 *
 * The clips are voices of real people: they stay in their folder, outside any
 * repository. The results go to `<dir>/esiti/topics-<stamp>.json` (or `--out`).
 * Exit 0 when at least `--soglia` scenario rounds (default 16) pass every check.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Json = Record<string, any>;
type Ev = { t: number; event: string; data: Json };

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const base = process.env.TOPICS_VOICE_SCENARIOS ?? "";
if (!base) {
  console.error("TOPICS_VOICE_SCENARIOS is not set: the folder with scenari.json and the clips");
  process.exit(2);
}
const url = arg("--url") ?? process.env.TOPICS_VOICE_BRIDGE_URL ?? "ws://127.0.0.1:13334/ws/voice/bridge";
const rounds = Number(arg("--giri") ?? 3);
const parallel = Number(arg("--insieme") ?? 3);
const only = arg("--solo");
const threshold = Number(arg("--soglia") ?? 16);
const owner = process.env.TOPICS_VOICE_BENCH_NAME || "Ada";

/** The "data" chunk of a WAV: afconvert puts others (FLLR) before it. */
function pcmOfWav(b: Buffer): Int16Array {
  let i = 12;
  while (i + 8 <= b.length) {
    const len = b.readUInt32LE(i + 4);
    if (b.toString("latin1", i, i + 4) === "data") {
      const data = b.subarray(i + 8, Math.min(i + 8 + len, b.length));
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~1)));
    }
    i += 8 + len + (len & 1);
  }
  throw new Error("wav without data");
}

/** The assistant's voice, not the background filling the silences (room at -58 dBFS): the level says it. */
function voiced(f: Int16Array): boolean {
  let s = 0;
  for (const x of f) s += x * x;
  const level = Math.sqrt(s / Math.max(1, f.length)) / 32768;
  return level > 1e-5 && 20 * Math.log10(level) > -40;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const now = () => performance.now();

/** The fake phone with the assistant on the other side, through the bridge. */
class Rig {
  ws: WebSocket;
  events: Ev[] = [];
  handed: string[] = [];
  lastVoice: number | null = null;
  speakingSince: number | null = null;
  finished = false;
  outcome: Json | null = null;
  private toSay: number[] = [];
  private pump: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        const f = new Int16Array(ev.data as ArrayBuffer);
        const t = now();
        if (voiced(f)) {
          this.lastVoice = t;
          this.speakingSince ??= t;
        } else if (this.lastVoice === null || t - this.lastVoice > 300) this.speakingSince = null;
        return;
      }
      const m = JSON.parse(ev.data) as Json;
      if (m.type === "log") this.events.push({ t: now(), event: m.event, data: m.data ?? {} });
      else if (m.type === "handoff") {
        this.handed.push(m.text);
        this.send({ type: "handoff_ok", id: m.id });
      } else if (m.type === "outcome") this.outcome = m;
    };
    this.ws.onclose = () => {
      this.finished = true;
      clearInterval(this.pump);
    };
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`no bridge at ${url}`));
    });
    this.send({ type: "start", id: `bench-${crypto.randomUUID().slice(0, 8)}`, name: owner, direction: { kind: "incoming" }, group: false, record: false });
    this.send({ type: "answered" });
    // like a phone: 60 ms of the caller every 60 ms, the phrase in progress or digital silence
    let next = now();
    const tick = () => {
      if (this.ws.readyState !== 1) return;
      while (next <= now()) {
        const f = new Int16Array(960);
        f.set(this.toSay.splice(0, 960));
        this.ws.send(f);
        next += 60;
      }
    };
    this.pump = setInterval(tick, 5);
  }

  send(m: Json): boolean {
    if (this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  /** Puts the phrase in its mouth; returns how long it lasts. */
  say(audio: Int16Array): number {
    for (const s of audio) this.toSay.push(s);
    return audio.length / 16;
  }

  turnsSince(since: number): string[] {
    return this.events.filter((e) => e.t > since && e.event === "turno").map((e) => String(e.data.detto ?? ""));
  }

  /**
   * The brain has an open question, or has answered and Gemini has not said it
   * yet: the "Ok, give me a moment" is not the answer, and whoever is on the
   * phone waits. Without it, the bench moved to the next phrase over the answer (13/11)
   */
  thinkingSince(since: number): boolean {
    const after = this.events.filter((e) => e.t > since);
    let lastAsk = -1;
    after.forEach((e, i) => {
      if (e.event === "chiesto" || e.event === "richiesto") lastAsk = i;
    });
    if (lastAsk < 0) return false;
    const rest = after.slice(lastAsk);
    const answered = rest.findIndex((e) => e.event.startsWith("pensat") || e.event.startsWith("pensiero_"));
    if (answered < 0) return true;
    return rest[answered]!.event === "pensato" && !rest.slice(answered).some((e) => e.event === "turno" && String(e.data.detto ?? "").trim() !== "");
  }

  /** Waits until the assistant has talked after `since` and then been quiet for `quiet`. */
  async waitAnswer(since: number, quiet: number, max: number): Promise<boolean> {
    const end = now() + max;
    while (now() < end) {
      await sleep(100);
      if (this.thinkingSince(since)) continue;
      // the answer is read from the turn, which Gemini closes only when by its
      // count the audio has finished playing: on a 20 s result it arrives after
      // the silence, and the bench counted it as not given (13/11)
      const turned = this.turnsSince(since).some((t) => t.trim() !== "");
      const lv = this.lastVoice;
      if (lv !== null && lv > since && now() - lv > quiet && (turned || now() - lv > quiet + 10_000)) return true;
    }
    return false;
  }

  close(): void {
    clearInterval(this.pump);
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

async function playScenario(sc: Json, round: number): Promise<Json> {
  const r = new Rig();
  await r.open();
  const id = String(sc.id);
  const played: Json[] = [];
  const s0 = now();
  if (!(await r.waitAnswer(s0, 800, 20_000))) {
    r.close();
    // why it did not greet (Gemini quota, a refused setup) is in the log: kept for whoever reads the results
    return { id, giro: round, passi: [{ falliti: ["non saluta"], eventi: r.events.map((e) => ({ s: Math.round(e.t - s0) / 1000, evento: e.event, dati: e.data })) }] };
  }
  let closed = false;
  for (const p of sc.passi as Json[]) {
    if (closed) {
      played.push({ passo: p, falliti: ["chiamata già chiusa"] });
      continue;
    }
    const handedBefore = r.handed.length;
    const s = now();
    if (typeof p.risultato === "string") {
      // the call closed on its own before the result is a failure to look at, not a panic of the bench
      if (r.finished || !r.send({ type: "reply", text: p.risultato })) {
        const why = [...r.events].reverse().find((e) => e.event === "fine")?.data.motivo ?? "";
        played.push({ passo: p, falliti: [`chiamata chiusa prima del risultato: ${JSON.stringify(why)}`] });
        closed = true;
        continue;
      }
      await r.waitAnswer(s, 1500, 40_000);
    } else if (Array.isArray(p.lavora)) {
      // the agent works: the steps arrive as from the engine's loop (every 3 s, the list grows).
      // The engine's list grows only inside a turn: "da" = from how many steps it starts
      // again (after a correction the old turn goes on)
      const steps = (p.lavora as unknown[]).filter((v): v is string => typeof v === "string");
      const from = typeof p.da === "number" ? p.da : 1;
      for (let i = from; i <= steps.length; i++) {
        r.send({ type: "progress", steps: steps.slice(0, i) });
        await sleep(3000);
      }
      await sleep(4000);
    } else {
      const pcm = pcmOfWav(readFileSync(join(base, String(p.di))));
      const d = r.say(pcm);
      // the steps of the job arrive while they talk (13/11 evening: the line on
      // the mail steps ready while they said "it is not in the mail", and said
      // right after the new job started)
      if (Array.isArray(p.passi_durante)) {
        // at two thirds: clip D1 has 1.8 s of silence at its head, at one third the steps arrived before they talked
        await sleep((d * 2) / 3);
        r.send({ type: "progress", steps: (p.passi_durante as unknown[]).filter((v): v is string => typeof v === "string") });
        await sleep(d - (d * 2) / 3);
      } else if (typeof p.risultato_durante === "string") {
        await sleep(d / 3);
        r.send({ type: "reply", text: p.risultato_durante });
        await sleep(d - d / 3);
      } else {
        await sleep(d);
      }
      await r.waitAnswer(s, 1500, 30_000);
      // corrected by whisper, or a queued result: the real answer comes after
      if (r.events.some((e) => e.t > s && ["capito_male", "azione_fermata", "risultato_a_gemini"].includes(e.event))) {
        const c = now();
        await r.waitAnswer(c, 1500, 15_000);
      }
    }
    // the turn closes a moment after the last audio
    await sleep(700);
    const ev = r.events.filter((e) => e.t > s);
    const handed = r.handed.slice(handedBefore);
    const turns = ev.filter((e) => e.event === "turno");
    const said = turns.map((e) => String(e.data.detto ?? "")).join(" ");
    const heard = turns.map((e) => String(e.data.sentito ?? "")).join(" ");
    const whisper = ev.filter((e) => e.event === "whisper").map((e) => String(e.data.testo ?? ""));
    const closes = ev.some((e) => e.event === "chiude_jarvis" || e.event === "esce_su_richiesta");
    const failed: string[] = [];
    if (p.affida === true && handed.length === 0) failed.push("non ha affidato");
    if (p.affida === false && handed.length > 0) failed.push(`ha affidato senza motivo: ${handed.join(" | ")}`);
    if (p.racconta === true && !ev.some((e) => e.event === "passo_detto")) failed.push("non ha detto a che punto è");
    const stepsSaid = ev.filter((e) => e.event === "passo_detto").map((e) => String(e.data.frase ?? "").toLowerCase());
    for (const w of Array.isArray(p.passi_non_dicono) ? (p.passi_non_dicono as string[]) : []) {
      const hit = stepsSaid.find((x) => x.includes(w));
      if (hit) failed.push(`passo vecchio detto: ${hit}`);
    }
    if (p.non_ripete === true) {
      // the same phrase thought twice = two "let me think" and the answer said twice (13/11 evening)
      const asked = new Set(ev.filter((e) => e.event === "chiesto").map((e) => String(e.data.frase ?? "").trim()));
      const thoughts = ev.filter((e) => e.event === "pensato").length;
      if (thoughts > asked.size) failed.push(`ha pensato ${thoughts} volte ${asked.size} frasi`);
      const sentences = said
        .split(/[.?!]/)
        .map((x) => x.trim().toLowerCase())
        .filter((x) => x.split(/\s+/).filter(Boolean).length >= 4);
      const rep = sentences.find((x, i) => sentences.slice(0, i).includes(x));
      if (rep) failed.push(`ha ripetuto: ${rep}`);
    }
    if (p.chiude === true && !closes) failed.push("non ha chiuso");
    if (p.chiude === false && closes) failed.push("ha chiuso la chiamata");
    if (p.rilancia === false) {
      // it is the order to relaunch that counts, not the word: "check whether they
      // were already relaunched, do not restart them" is exactly the right answer
      // to "is it already handling it?" (13/11, read as a relaunch 3 times in 3)
      const relaunches = (h: string) =>
        h
          .toLowerCase()
          .split(/[.;:]/)
          .some((f) => ["rilanc", "riavvi", "ripart", "rimett", "sul pc"].some((w) => f.includes(w)) && !["non ", "verifica se", "controlla se", "chiede se", "se sono", "se qualcuno", "senza "].some((n) => f.includes(n)));
      const h = handed.find(relaunches);
      if (h) failed.push(`ha rilanciato lavori non chiesti: ${h}`);
    }
    if (Array.isArray(p.riferisce)) {
      const low = said.toLowerCase();
      if (!(p.riferisce as string[]).some((w) => low.includes(w.toLowerCase()))) failed.push(`non ha riferito (${[...said].slice(0, 80).join("")})`);
    }
    // a long result is summed up: read whole, the mail one of 13/11 lasted 18 s of list
    if (p.breve === true && [...said].length > 350) failed.push(`troppo lungo: ${[...said].length} caratteri detti`);
    // while the agent works only the mouth talks, which makes no turns: there the step said is enough
    if (said.trim() === "" && !closes && p.lavora === undefined) failed.push("non ha risposto");
    closed = closes;
    played.push({
      passo: p,
      gemini_ha_sentito: heard,
      whisper,
      detto: said,
      affidati: handed,
      chiude: closes,
      latenze_ms: ev.filter((e) => e.event === "latenza").map((e) => e.data.ms),
      eventi: ev.filter((e) => !["latenza", "turno"].includes(e.event)).map((e) => ({ s: Math.round(e.t - s) / 1000, evento: e.event, dati: e.data })),
      falliti: failed,
    });
    await sleep(600);
  }
  r.close();
  return { id, descrizione: sc.descrizione, giro: round, passi: played };
}

const spec = JSON.parse(readFileSync(join(base, "scenari.json"), "utf8")) as { scenari: Json[] };
const jobs: (() => Promise<Json>)[] = [];
for (const sc of spec.scenari.filter((s) => !only || String(s.id).includes(only))) {
  for (let round = 0; round < rounds; round++) jobs.push(() => playScenario(sc, round));
}
const all: Json[] = [];
let at = 0;
await Promise.all(
  Array.from({ length: Math.max(1, parallel) }, async () => {
    while (at < jobs.length) {
      const job = jobs[at++]!;
      try {
        all.push(await job());
      } catch (e) {
        all.push({ id: "?", giro: -1, passi: [{ falliti: [`banco: ${e instanceof Error ? e.message : String(e)}`] }] });
      }
    }
  }),
);
all.sort((a, b) => String(a.id).localeCompare(String(b.id)) || a.giro - b.giro);
const stampNow = new Date().toISOString().replace(/[:.]/g, "-");
const out = arg("--out") ?? join(base, "esiti", `topics-${stampNow}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(all, null, 2));
console.log("\n===== esito per scenario (passi falliti / giri)");
let failed = 0;
let clean = 0;
for (const r of all) {
  const bad: string[] = (r.passi as Json[]).flatMap((p) => p.falliti as string[]);
  failed += bad.length;
  if (bad.length === 0) clean++;
  console.log(`${r.id} #${r.giro}: ${bad.length === 0 ? "ok" : bad.join(" · ")}`);
}
console.log(`controlli falliti: ${failed} · scenari puliti ${clean}/${all.length} · dettagli in ${out}`);
process.exit(clean >= Math.min(threshold, all.length) ? 0 : 1);
