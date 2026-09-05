/**
 * Does the domain prompt help the Whisper providers, or does it leak?
 *
 * `server/lib/stt.ts` sends `DEFAULT_PROMPT` (git, rebase, Tauri, bun,
 * WebSocket...) only to the gpt-*-transcribe family. The Whisper providers
 * (Groq `whisper-large-v3-turbo`, local whisper.cpp) were excluded because an
 * `initial_prompt` ends up INSIDE the transcript when the audio is silent. This
 * bench answers the two questions that decision needs, with numbers instead of
 * a memory:
 *
 *   1. with the prompt, how many domain terms come out right?
 *   2. on a silent clip, does the prompt come back as the transcript?
 *
 * Run it (needs `say`, `ffmpeg`, and for the local half whisper-cli + a ggml
 * model; for the Groq half `GROQ_API_KEY`):
 *
 *   bun run scripts/bench/stt-prompt-bench.ts
 *   bun run scripts/bench/stt-prompt-bench.ts --only local --json out.json
 *
 * The corpus is GENERATED, not committed: 5 clean synthesized clips, 5 pushed
 * through a microphone-like chain (band limit, room noise, Opus at 24 kbps, the
 * same shape the browser uploads) and 3 clips with no speech at all. Same texts
 * every run, so two runs are comparable; `--rebuild` forces regeneration.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_PROMPT, isSilenceArtifact, localConfig } from "../../server/lib/stt";

// ─── The corpus ───────────────────────────────────────────────────────────────

interface ClipSpec {
  id: string;
  kind: "clean" | "mic" | "silent";
  /** What is said, verbatim. Empty for the clips with no speech. */
  text: string;
  /** Voice for `say`, and words per minute. */
  voice?: string;
  rate?: number;
  /** The domain terms the transcript has to contain, one score point each. */
  terms: string[];
  /** ffmpeg lavfi source, for the clips that have no speech. */
  source?: string;
}

// Italian, because that is what dictation into this app sounds like, with the
// English technical vocabulary that the prompt is supposed to protect.
const CLIPS: ClipSpec[] = [
  {
    id: "clean-1", kind: "clean", voice: "Alice", rate: 180,
    text: "Fai il rebase del branch sopra main, poi apri la pull request.",
    terms: ["rebase", "branch", "main", "pull request"],
  },
  {
    id: "clean-2", kind: "clean", voice: "Alice", rate: 180,
    text: "La build di Tauri fallisce, ricompila con bun run build.",
    terms: ["Tauri", "bun", "build"],
  },
  {
    id: "clean-3", kind: "clean", voice: "Alice", rate: 180,
    text: "Apri il WebSocket verso l'endpoint e controlla il token.",
    terms: ["WebSocket", "endpoint", "token"],
  },
  {
    id: "clean-4", kind: "clean", voice: "Alice", rate: 170,
    text: "Claude Code e Codex girano dentro Topics come agenti.",
    terms: ["Claude", "Codex"],
  },
  {
    id: "clean-5", kind: "clean", voice: "Alice", rate: 190,
    text: "Fai il commit e poi il merge, il codice e TypeScript e Rust.",
    terms: ["commit", "merge", "TypeScript", "Rust"],
  },
  {
    id: "mic-1", kind: "mic", voice: "Reed", rate: 200,
    text: "Il webhook chiama l'endpoint di Docker e restituisce un token.",
    terms: ["webhook", "endpoint", "Docker", "token"],
  },
  {
    id: "mic-2", kind: "mic", voice: "Sandy", rate: 210,
    text: "Ho fatto il rebase interattivo sul branch della feature.",
    terms: ["rebase", "branch"],
  },
  {
    id: "mic-3", kind: "mic", voice: "Rocko", rate: 190,
    text: "Con bun run dev il client di Tauri parte in locale.",
    terms: ["bun", "Tauri", "client"],
  },
  {
    id: "mic-4", kind: "mic", voice: "Grandpa", rate: 170,
    text: "Il prompt di sistema manda i token a Claude tramite API.",
    terms: ["prompt", "token", "Claude", "API"],
  },
  {
    id: "mic-5", kind: "mic", voice: "Shelley", rate: 200,
    text: "La WebSocket si chiude, rifai il commit e poi il push.",
    terms: ["WebSocket", "commit", "push"],
  },
  // No speech at all: this is where an initial prompt shows up as a transcript.
  { id: "silent-1", kind: "silent", text: "", terms: [], source: "anullsrc=r=16000:cl=mono:d=4" },
  { id: "silent-2", kind: "silent", text: "", terms: [], source: "anoisesrc=color=white:amplitude=0.008:r=16000:d=5" },
  { id: "silent-3", kind: "silent", text: "", terms: [], source: "anoisesrc=color=brown:amplitude=0.05:r=16000:d=3" },
];

// ─── Building it ──────────────────────────────────────────────────────────────

function run(cmd: string[]): { ok: boolean; err: string } {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, err: new TextDecoder().decode(p.stderr).slice(-400) };
}

function buildCorpus(dir: string, rebuild: boolean): void {
  if (rebuild) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const ffmpeg = Bun.which("ffmpeg") ?? "/opt/homebrew/bin/ffmpeg";
  for (const clip of CLIPS) {
    const wav = join(dir, `${clip.id}.wav`);
    if (existsSync(wav)) continue;
    if (clip.kind === "silent") {
      const r = run([ffmpeg, "-y", "-f", "lavfi", "-i", clip.source!, "-ar", "16000", "-ac", "1", wav]);
      if (!r.ok) throw new Error(`ffmpeg on ${clip.id}: ${r.err}`);
      continue;
    }
    const spokenAudio = join(dir, `${clip.id}.aiff`);
    const said = run(["/usr/bin/say", "-v", clip.voice!, "-r", String(clip.rate ?? 180), "-o", spokenAudio, clip.text]);
    if (!said.ok) throw new Error(`say on ${clip.id}: ${said.err}`);
    if (clip.kind === "clean") {
      const r = run([ffmpeg, "-y", "-i", spokenAudio, "-ar", "16000", "-ac", "1", wav]);
      if (!r.ok) throw new Error(`ffmpeg on ${clip.id}: ${r.err}`);
    } else {
      // What a real note sounds like when it reaches the server: a microphone
      // band, room noise underneath, and one Opus generation at the bitrate the
      // browser records with.
      const noisy = join(dir, `${clip.id}.noisy.wav`);
      const opus = join(dir, `${clip.id}.opus.ogg`);
      const chain = run([
        ffmpeg, "-y", "-i", spokenAudio,
        "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.005:r=16000",
        "-filter_complex", "[0:a]highpass=f=120,lowpass=f=6000[s];[s][1:a]amix=inputs=2:duration=shortest:dropout_transition=0,volume=1.6",
        "-ar", "16000", "-ac", "1", noisy,
      ]);
      if (!chain.ok) throw new Error(`ffmpeg chain on ${clip.id}: ${chain.err}`);
      const encoded = run([ffmpeg, "-y", "-i", noisy, "-c:a", "libopus", "-b:a", "24k", opus]);
      if (!encoded.ok) throw new Error(`opus on ${clip.id}: ${encoded.err}`);
      const decoded = run([ffmpeg, "-y", "-i", opus, "-ar", "16000", "-ac", "1", wav]);
      if (!decoded.ok) throw new Error(`decode on ${clip.id}: ${decoded.err}`);
      rmSync(noisy, { force: true });
      rmSync(opus, { force: true });
    }
    rmSync(spokenAudio, { force: true });
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(CLIPS, null, 2));
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A term counts as heard when it appears as a whole word (or word pair). */
function heard(transcript: string, term: string): boolean {
  const hay = ` ${fold(transcript)} `;
  return hay.includes(` ${fold(term)} `);
}

/** Words the prompt contributes and the speech does not: a leak is one of these. */
const PROMPT_MARKERS = ["dictation", "vocabulary", "developer tool", "terminal", "expect software"];

function promptLeaked(transcript: string): boolean {
  const hay = fold(transcript);
  return PROMPT_MARKERS.some(m => hay.includes(fold(m)));
}

// ─── The two engines, called the way production calls them ────────────────────

async function groqTranscribe(wav: string, prompt: string | null, model: string): Promise<string> {
  const key = process.env.GROQ_API_KEY!;
  const form = new FormData();
  form.append("model", model);
  form.append("file", new File([new Uint8Array(readFileSync(wav))], "clip.wav", { type: "audio/wav" }));
  form.append("response_format", "json");
  if (prompt) form.append("prompt", prompt);
  // The free tier allows 20 requests per minute and this bench sends 26: a 429
  // is expected traffic here, not a failure, so it waits and asks again.
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (resp.status === 429 && attempt < 6) {
      const wait = Math.round(Number(resp.headers.get("retry-after") ?? 0) * 1000) || 20_000;
      process.stderr.write(`  (groq rate limit, waiting ${Math.round(wait / 1000)}s)\n`);
      await Bun.sleep(wait + 1000);
      continue;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return ((await resp.json() as { text?: string }).text ?? "").trim();
  }
}

function localTranscribe(wav: string, prompt: string | null, cfg: { whisperBin: string; modelPath: string }): string {
  const threads = Math.max(2, Math.min(8, cpus().length - 2));
  const args = ["-m", cfg.modelPath, "-l", "auto", "-t", String(threads), "-f", wav, "--no-timestamps", "--no-prints"];
  if (prompt) args.push("--prompt", prompt);
  const p = Bun.spawnSync([cfg.whisperBin, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`whisper-cli: ${new TextDecoder().decode(p.stderr).slice(-300)}`);
  return new TextDecoder().decode(p.stdout)
    .split("\n")
    .filter(line => !/^(whisper|ggml|system|main|encoder|decoder)[_a-z]*\s*:/i.test(line) && line.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── The run ──────────────────────────────────────────────────────────────────

interface Row {
  engine: string;
  withPrompt: boolean;
  termsHit: number;
  termsTotal: number;
  missed: string[];
  silentNonEmpty: number;
  silentLeaks: number;
  transcripts: Record<string, string>;
}

async function measure(
  engine: string,
  withPrompt: boolean,
  dir: string,
  transcribeOne: (wav: string, prompt: string | null) => Promise<string> | string,
): Promise<Row> {
  const prompt = withPrompt ? DEFAULT_PROMPT : null;
  const row: Row = { engine, withPrompt, termsHit: 0, termsTotal: 0, missed: [], silentNonEmpty: 0, silentLeaks: 0, transcripts: {} };
  for (const clip of CLIPS) {
    const wav = join(dir, `${clip.id}.wav`);
    const raw = await transcribeOne(wav, prompt);
    // Production never returns the raw text: the silence filter runs first.
    const text = isSilenceArtifact(raw) ? "" : raw;
    row.transcripts[clip.id] = raw;
    if (clip.kind === "silent") {
      if (text) row.silentNonEmpty++;
      if (promptLeaked(raw)) row.silentLeaks++;
      continue;
    }
    for (const term of clip.terms) {
      row.termsTotal++;
      if (heard(text, term)) row.termsHit++;
      else row.missed.push(`${clip.id}:${term}`);
    }
    process.stderr.write(`  ${clip.id} ${withPrompt ? "prompt" : "plain "} -> ${text.slice(0, 90)}\n`);
  }
  return row;
}

function table(rows: Row[]): string {
  const lines = [
    "| engine | prompt | technical terms | silent clips not empty | prompt in the transcript |",
    "|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const pct = r.termsTotal ? Math.round((r.termsHit / r.termsTotal) * 100) : 0;
    lines.push(`| ${r.engine} | ${r.withPrompt ? "yes" : "no"} | ${r.termsHit}/${r.termsTotal} (${pct}%) | ${r.silentNonEmpty}/3 | ${r.silentLeaks}/3 |`);
  }
  return lines.join("\n");
}

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const dir = args.includes("--dir") ? args[args.indexOf("--dir") + 1]! : join(homedir(), ".topics", "media", "stt-prompt-corpus");

buildCorpus(dir, args.includes("--rebuild"));
console.error(`corpus: ${dir} (${CLIPS.length} clips)`);

const rows: Row[] = [];

if (only !== "local") {
  if (!process.env.GROQ_API_KEY) console.error("skipping groq: no GROQ_API_KEY");
  else {
    const model = process.env.STT_MODEL_GROQ || "whisper-large-v3-turbo";
    for (const withPrompt of [false, true]) {
      rows.push(await measure(`groq ${model}`, withPrompt, dir, (wav, p) => groqTranscribe(wav, p, model)));
    }
  }
}

if (only !== "groq") {
  const cfg = localConfig(process.env);
  if (!cfg.whisperBin || !cfg.modelPath) console.error("skipping local: whisper-cli or model missing");
  else {
    const name = cfg.modelPath.split("/").pop();
    for (const withPrompt of [false, true]) {
      rows.push(await measure(`whisper.cpp ${name}`, withPrompt, dir, (wav, p) => localTranscribe(wav, p, { whisperBin: cfg.whisperBin!, modelPath: cfg.modelPath! })));
    }
  }
}

console.log(`\n${table(rows)}\n`);
for (const r of rows) if (r.missed.length) console.log(`missed by ${r.engine} (${r.withPrompt ? "prompt" : "plain"}): ${r.missed.join(", ")}`);
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), corpus: dir, rows }, null, 2));
  console.log(`\njson: ${jsonOut}`);
}
