/**
 * Speech-to-text — la scala dei provider.
 *
 * Prima di questo modulo `/api/stt` sapeva fare UNA cosa sola: `ffmpeg` per
 * convertire, poi `whisper-cli` con `ggml-large-v3` letto da `~/whisper-models`,
 * lingua inchiodata a `it`. Tre presupposti che nella app impacchettata non
 * reggono nessuno:
 *
 *   1. `whisper-cli` e `ffmpeg` stanno in `/opt/homebrew/bin`, che NON è nel PATH
 *      di un processo lanciato dal Finder (`/usr/bin:/bin:/usr/sbin:/sbin`) — il
 *      binario c'è ma il server non lo trova, e la dettatura muore con un ENOENT.
 *   2. il modello da 3 GB va scaricato a mano in una cartella indovinata.
 *   3. chi detta in inglese si ritrova trascritto in italiano.
 *
 * Qui la trascrizione diventa una CATENA: i provider allo stato dell'arte per
 * primi (chiave presente = provider disponibile), whisper locale come rete di
 * sicurezza offline. Il primo che risponde vince; chi fallisce passa la mano e
 * lascia il suo motivo nell'errore finale, così «non trascrive» è una frase con
 * dentro il perché di ognuno invece di un 500 muto.
 *
 * L'ordine di default non è un'opinione: ElevenLabs Scribe v2 e `gpt-transcribe`
 * sono i due modelli in cima ai confronti pubblici 2026 sul multilingua, e sono
 * anche le due chiavi che Topics già documenta (`ELEVENLABS_API_KEY` alimenta il
 * TTS, `OPENAI_API_KEY` il provider openai) — chi ha già configurato la app si
 * ritrova la dettatura buona senza aggiungere niente.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Le forme che attraversano il filo stanno in shared/: dichiararle qui e
// ricopiarle nel client è come i due lati smettono di essere lo stesso contratto.
import type { SttProviderId, SttProviderStatus, SttResult, SttCapabilities } from "../../shared/stt";
export type { SttProviderId, SttProviderStatus, SttResult, SttCapabilities } from "../../shared/stt";

/** Ordine della cascata quando `STT_PROVIDER` è assente o vale `auto`. */
export const STT_AUTO_ORDER: readonly SttProviderId[] = ["elevenlabs", "openai", "deepgram", "groq", "local"] as const;

const ALL_PROVIDERS = new Set<string>(STT_AUTO_ORDER);

/**
 * Tetto sul caricato. 25 MB è il limite duro di OpenAI e del piano free di Groq;
 * tenerlo uguale per tutti evita che lo stesso vocale passi da un provider e
 * venga rifiutato dal successivo a metà cascata. A ~24 kbps di Opus sono ore.
 */
export const MAX_STT_BYTES = 25 * 1024 * 1024;

/** Oltre questo un provider è considerato morto e si passa al prossimo. */
const CLOUD_TIMEOUT_MS = 60_000;
const FFMPEG_TIMEOUT_MS = 30_000;
const WHISPER_TIMEOUT_MS = 180_000;

export interface SttAudio {
  bytes: Uint8Array;
  /** Nome con estensione COERENTE col contenuto: i provider la leggono per scegliere il decoder. */
  filename: string;
  mimeType: string;
}

export interface SttDeps {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Iniettabile nei test: la catena locale non deve toccare il disco. */
  runLocal?: (audio: SttAudio, cfg: LocalConfig) => Promise<{ transcript: string; model: string }>;
  now?: () => number;
}

export class SttError extends Error {
  constructor(message: string, readonly attempts: { provider: SttProviderId; error: string }[] = []) {
    super(message);
    this.name = "SttError";
  }
}

// ─── Modelli di default ───────────────────────────────────────────────────────
//
// Ogni provider ha un override dedicato (`STT_MODEL_<PROVIDER>`) più uno globale
// (`STT_MODEL`) che vale solo se il provider scelto è quello attivo — così
// «cambiami il modello» resta una riga di .env anche quando la cascata ne ha
// cinque sotto mano.

const DEFAULT_MODELS: Record<SttProviderId, string> = {
  // Scribe v2 è il modello corrente; `scribe_v1` resta come ripiego se l'account
  // non lo ha abilitato (vedi il retry in transcribeElevenLabs).
  elevenlabs: "scribe_v2",
  // «This is the recommended model for transcribing recorded speech» — sostituisce
  // gpt-4o-transcribe, che resta valido come override.
  openai: "gpt-transcribe",
  deepgram: "nova-3",
  groq: "whisper-large-v3-turbo",
  local: "auto",
};

const ELEVENLABS_FALLBACK_MODEL = "scribe_v1";
const OPENAI_FALLBACK_MODEL = "gpt-4o-transcribe";

function modelFor(id: SttProviderId, env: SttDeps["env"]): string {
  const perProvider = env[`STT_MODEL_${id.toUpperCase()}`];
  if (perProvider?.trim()) return perProvider.trim();
  return DEFAULT_MODELS[id];
}

/** Lingua attesa. Vuoto = auto-detect, che su Scribe/gpt-transcribe è la scelta giusta. */
function languageHint(env: SttDeps["env"]): string | null {
  const raw = (env.STT_LANGUAGE || "").trim().toLowerCase();
  if (!raw || raw === "auto") return null;
  return raw;
}

/**
 * Contesto di dominio per i modelli che lo sanno usare davvero (la famiglia
 * gpt-*-transcribe). Topics è una app per agenti da terminale: senza questo
 * suggerimento «git rebase» diventa «git ribes» e «Tauri» diventa «Taury».
 *
 * NON viene passato ai provider basati su Whisper: lì l'`initial_prompt` finisce
 * regolarmente NELLA trascrizione quando l'audio è silenzioso, ed è esattamente
 * il difetto che stiamo togliendo di mezzo.
 */
const DEFAULT_PROMPT =
  "Technical dictation inside a developer tool for terminal AI coding agents. " +
  "Expect software vocabulary: git, commit, rebase, branch, merge, pull request, TypeScript, React, Rust, Tauri, " +
  "npm, bun, Docker, API, endpoint, webhook, WebSocket, prompt, token, Claude, Codex.";

function promptFor(id: SttProviderId, env: SttDeps["env"]): string | null {
  const raw = env.STT_PROMPT;
  if (raw !== undefined) return raw.trim() ? raw.trim() : null;
  return id === "openai" ? DEFAULT_PROMPT : null;
}

// ─── Scelta della catena ──────────────────────────────────────────────────────

export interface LocalConfig {
  whisperBin: string | null;
  ffmpegBin: string | null;
  modelPath: string | null;
  language: string | null;
}

/**
 * Dove cercare i binari quando il PATH è quello scarno di un processo lanciato
 * dal Finder. `Bun.which` copre il caso terminale; questi coprono il caso app.
 */
const BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/opt/local/bin"];

function findBinary(names: string[], explicit: string | undefined, env: SttDeps["env"]): string | null {
  if (explicit?.trim()) return existsSync(explicit.trim()) ? explicit.trim() : null;
  for (const name of names) {
    const onPath = typeof Bun !== "undefined" ? Bun.which(name) : null;
    if (onPath) return onPath;
    for (const dir of BIN_DIRS) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  // Ultimo tentativo: un PATH esplicitato in ambiente (launchd lo passa spesso
  // diverso da quello della shell interattiva).
  for (const dir of (env.PATH || "").split(":").filter(Boolean)) {
    for (const name of names) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/** Dal migliore al peggiore: se in cartella ce ne sono due, vince il più accurato. */
const WHISPER_MODEL_NAMES = [
  "ggml-large-v3-turbo.bin",
  "ggml-large-v3.bin",
  "ggml-large-v2.bin",
  "ggml-large.bin",
  "ggml-medium.bin",
  "ggml-small.bin",
  "ggml-base.bin",
];

function findWhisperModel(env: SttDeps["env"]): string | null {
  const explicit = env.WHISPER_MODEL_PATH?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const home = env.HOME || "";
  const dirs = [
    env.WHISPER_MODEL_DIR?.trim(),
    home ? join(home, "whisper-models") : "",
    home ? join(home, ".cache", "whisper") : "",
    home ? join(home, ".cache", "whisper.cpp") : "",
    "/opt/homebrew/share/whisper-cpp",
    "/usr/local/share/whisper-cpp",
  ].filter((d): d is string => !!d);
  for (const name of WHISPER_MODEL_NAMES) {
    for (const dir of dirs) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

export function localConfig(env: SttDeps["env"]): LocalConfig {
  return {
    whisperBin: findBinary(["whisper-cli", "whisper-cpp", "main"], env.WHISPER_CLI_PATH, env),
    ffmpegBin: findBinary(["ffmpeg"], env.FFMPEG_PATH, env),
    modelPath: findWhisperModel(env),
    language: languageHint(env),
  };
}

const KEY_ENV: Record<Exclude<SttProviderId, "local">, string> = {
  elevenlabs: "ELEVENLABS_API_KEY",
  openai: "OPENAI_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  groq: "GROQ_API_KEY",
};

function providerStatus(id: SttProviderId, env: SttDeps["env"]): SttProviderStatus {
  if (id === "local") {
    const cfg = localConfig(env);
    const missing: string[] = [];
    if (!cfg.whisperBin) missing.push("whisper-cli");
    if (!cfg.ffmpegBin) missing.push("ffmpeg");
    if (!cfg.modelPath) missing.push("un modello ggml-*.bin");
    return missing.length
      ? { id, available: false, model: "whisper.cpp", reason: `manca ${missing.join(" + ")}` }
      : { id, available: true, model: `whisper.cpp ${cfg.modelPath!.split("/").pop()}` };
  }
  const keyName = KEY_ENV[id];
  const model = modelFor(id, env);
  return env[keyName]?.trim()
    ? { id, available: true, model }
    : { id, available: false, model, reason: `${keyName} non configurata` };
}

/**
 * La catena che verrà PROVATA, in ordine. `STT_PROVIDER` accetta `auto` (default),
 * un nome solo (esclusivo: chi lo fissa non vuole sorprese di fatturazione) o una
 * lista separata da virgole per dettare il proprio ordine — es. `openai,local`.
 */
export function resolveSttChain(env: SttDeps["env"]): { chain: SttProviderStatus[]; all: SttProviderStatus[]; pinned: boolean } {
  const all = STT_AUTO_ORDER.map(id => providerStatus(id, env));
  const byId = new Map(all.map(p => [p.id, p]));
  const raw = (env.STT_PROVIDER || "").trim().toLowerCase();

  if (!raw || raw === "auto") {
    return { chain: all.filter(p => p.available), all, pinned: false };
  }
  const wanted = raw.split(",").map(s => s.trim()).filter(Boolean).filter(s => ALL_PROVIDERS.has(s)) as SttProviderId[];
  const chain = wanted.map(id => byId.get(id)!).filter(p => p?.available);
  return { chain, all, pinned: true };
}

// ─── Il rumore che Whisper produce sul silenzio ───────────────────────────────
//
// Un modello Whisper su un pezzo muto non restituisce vuoto: restituisce la frase
// più frequente nei suoi dati di training, cioè i titoli di coda dei sottotitoli.
// Sono SEMPRE queste, sempre da sole, sempre a trascrizione intera — quindi si
// filtrano per uguaglianza sul testo completo normalizzato, mai per sottostringa
// (dentro un discorso vero «grazie per aver guardato» è una frase legittima).
const SILENCE_ARTIFACTS = new Set([
  "sottotitoli e revisione a cura di qtss",
  "sottotitoli creati dalla comunita amara org",
  "sottotitoli e revisione a cura di sottotitoli e revisione a cura di qtss",
  "sottotitoli di amara org",
  "grazie per aver guardato il video",
  "grazie per lattenzione",
  "thanks for watching",
  "thank you for watching",
  "thank you",
  "you",
  "bye",
  "subtitles by the amara org community",
  "subtitles by amara org",
  "untertitel der amara org community",
  "untertitelung aufgrund der amara org community",
  "sous titres realises par la communaute damara org",
  "subtitulos realizados por la comunidad de amara org",
  "amara org",
]);

function normalizeForArtifactCheck(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Vero quando la trascrizione INTERA è uno degli artefatti da silenzio. */
export function isSilenceArtifact(text: string): boolean {
  const norm = normalizeForArtifactCheck(text);
  if (!norm) return true;
  if (SILENCE_ARTIFACTS.has(norm)) return true;
  // Ripetizione secca dello stesso artefatto ("you you you", "grazie grazie").
  const words = norm.split(" ");
  const unique = new Set(words);
  if (words.length >= 3 && unique.size === 1 && SILENCE_ARTIFACTS.has(words[0])) return true;
  return false;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * L'estensione con cui l'audio va scritto su disco.
 *
 * Conta piu' di quanto sembri: `ffmpeg` sceglie il demuxer dal nome del file, e
 * un `.webm` che dentro e' un MP4 (quello che registra WebKit) si apre male o
 * non si apre. Il nome arriva dal client, quindi e' la sua parola sul formato.
 */
function estensioneDi(audio: SttAudio): string {
  return audio.filename.includes(".") ? audio.filename.split(".").pop()! : "webm";
}

function fileOf(audio: SttAudio): File {
  // `Buffer.from(...)` produce una copia con byteOffset 0: passare la view nuda
  // rischia di caricare l'intero ArrayBuffer sottostante quando l'audio è una
  // fetta di un buffer più grande.
  return new File([new Uint8Array(audio.bytes)], audio.filename, { type: audio.mimeType });
}

async function readError(resp: Response): Promise<string> {
  const body = (await resp.text().catch(() => "")).slice(0, 400);
  return `HTTP ${resp.status}${body ? `: ${body}` : ""}`;
}

async function transcribeElevenLabs(audio: SttAudio, deps: SttDeps, model: string): Promise<{ transcript: string; language: string | null; model: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const key = deps.env.ELEVENLABS_API_KEY!;
  const lang = languageHint(deps.env);

  const attempt = async (modelId: string) => {
    const form = new FormData();
    form.append("model_id", modelId);
    form.append("file", fileOf(audio));
    if (lang) form.append("language_code", lang);
    // Niente diarizzazione e niente tag di eventi audio: qui si detta, e un
    // «(laughter)» in mezzo a un prompt è testo spurio da cancellare a mano.
    form.append("diarize", "false");
    form.append("tag_audio_events", "false");
    return doFetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });
  };

  let used = model;
  let resp = await attempt(model);
  // Un account senza Scribe v2 abilitato risponde 4xx sul model_id, non 5xx:
  // ritentare una volta col v1 è la differenza fra «dettatura rotta» e «dettatura
  // un filo meno precisa».
  if (!resp.ok && resp.status >= 400 && resp.status < 500 && model !== ELEVENLABS_FALLBACK_MODEL) {
    used = ELEVENLABS_FALLBACK_MODEL;
    resp = await attempt(ELEVENLABS_FALLBACK_MODEL);
  }
  if (!resp.ok) throw new Error(await readError(resp));

  const data = await resp.json() as { text?: string; language_code?: string; transcripts?: { text?: string; language_code?: string }[] };
  const first = data.transcripts?.[0];
  const text = (data.text ?? first?.text ?? "").trim();
  return { transcript: text, language: data.language_code ?? first?.language_code ?? null, model: used };
}

async function transcribeOpenAI(audio: SttAudio, deps: SttDeps, model: string): Promise<{ transcript: string; language: string | null; model: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const key = deps.env.OPENAI_API_KEY!;
  const lang = languageHint(deps.env);
  const prompt = promptFor("openai", deps.env);
  const base = (deps.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");

  const attempt = async (modelId: string) => {
    const form = new FormData();
    form.append("model", modelId);
    form.append("file", fileOf(audio));
    if (prompt) form.append("prompt", prompt);
    if (lang) {
      // `gpt-transcribe` ha sostituito il campo singolare con `languages[]`; i
      // modelli precedenti conoscono solo `language`. Mandarli entrambi è un 400.
      if (modelId.startsWith("gpt-transcribe") || modelId.startsWith("gpt-live-transcribe")) form.append("languages[]", lang);
      else form.append("language", lang);
    }
    return doFetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });
  };

  let used = model;
  let resp = await attempt(model);
  if (!resp.ok && resp.status === 400 && model !== OPENAI_FALLBACK_MODEL) {
    // Chiave su un'organizzazione che non vede ancora il modello nuovo.
    used = OPENAI_FALLBACK_MODEL;
    resp = await attempt(OPENAI_FALLBACK_MODEL);
  }
  if (!resp.ok) throw new Error(await readError(resp));

  const data = await resp.json() as { text?: string; language?: string; languages?: (string | { code?: string })[] };
  const detected = data.languages?.[0];
  const language = typeof detected === "string" ? detected : detected?.code ?? data.language ?? null;
  return { transcript: (data.text ?? "").trim(), language, model: used };
}

async function transcribeDeepgram(audio: SttAudio, deps: SttDeps, model: string): Promise<{ transcript: string; language: string | null; model: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const key = deps.env.DEEPGRAM_API_KEY!;
  const lang = languageHint(deps.env);
  const params = new URLSearchParams({ model, smart_format: "true", punctuate: "true" });
  // `multi` è il codice che accende il riconoscimento multilingua di Nova; senza,
  // Deepgram assume inglese e trascrive l'italiano in fonetica inglese.
  params.set("language", lang || "multi");

  const resp = await doFetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": audio.mimeType || "application/octet-stream" },
    body: new Uint8Array(audio.bytes),
    signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(await readError(resp));

  const data = await resp.json() as {
    results?: { channels?: { alternatives?: { transcript?: string }[]; detected_language?: string }[] };
  };
  const channel = data.results?.channels?.[0];
  return {
    transcript: (channel?.alternatives?.[0]?.transcript ?? "").trim(),
    language: channel?.detected_language ?? lang,
    model,
  };
}

async function transcribeGroq(audio: SttAudio, deps: SttDeps, model: string): Promise<{ transcript: string; language: string | null; model: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const key = deps.env.GROQ_API_KEY!;
  const lang = languageHint(deps.env);
  const prompt = promptFor("groq", deps.env);

  const form = new FormData();
  form.append("model", model);
  form.append("file", fileOf(audio));
  form.append("response_format", "json");
  if (lang) form.append("language", lang);
  if (prompt) form.append("prompt", prompt);

  const resp = await doFetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(await readError(resp));

  const data = await resp.json() as { text?: string; language?: string };
  return { transcript: (data.text ?? "").trim(), language: data.language ?? lang, model };
}

/**
 * whisper.cpp in locale. Resta l'unico che ha bisogno di ffmpeg (il modello
 * vuole PCM 16 kHz mono), quindi resta l'unico che può fallire per un binario
 * mancante — motivo per cui sta in fondo alla catena e non davanti.
 */
async function transcribeLocal(audio: SttAudio, cfg: LocalConfig): Promise<{ transcript: string; model: string }> {
  if (!cfg.whisperBin || !cfg.ffmpegBin || !cfg.modelPath) {
    throw new Error("whisper locale non installato (servono whisper-cli, ffmpeg e un modello ggml-*.bin)");
  }
  // Cartella con nome imprevedibile (mkdtemp) invece di /tmp/stt-<Date.now()>:
  // chiude la finestra symlink/TOCTOU su una macchina multiutente.
  const tmpDir = mkdtempSync(join(tmpdir(), "stt-"));
  try {
    const src = join(tmpDir, `in.${estensioneDi(audio)}`);
    const wav = join(tmpDir, "out.wav");
    writeFileSync(src, audio.bytes);

    // Sottoprocessi ASINCRONI (non spawnSync): ffmpeg e whisper-cli su large-v3
    // durano secondi-decine di secondi, e spawnSync congelava l'unico event loop
    // di Bun per TUTTA la durata — ogni altra richiesta HTTP, messaggio WS e
    // relay PTY restava fermo fino a fine trascrizione. Gli stream si drenano
    // PRIMA di attendere l'uscita, così una pipe piena non può bloccare il figlio.
    const ffmpeg = Bun.spawn([cfg.ffmpegBin, "-i", src, "-ar", "16000", "-ac", "1", wav, "-y"], {
      timeout: FFMPEG_TIMEOUT_MS, stdout: "pipe", stderr: "pipe",
    });
    const [, ffErr] = await Promise.all([new Response(ffmpeg.stdout).text(), new Response(ffmpeg.stderr).text()]);
    if ((await ffmpeg.exited) !== 0) throw new Error(`ffmpeg: ${ffErr.slice(-300)}`);

    // `-l auto` invece di `-l it`: il rilevamento è dentro il modello e costa
    // un secondo di audio, mentre la lingua fissa trascriveva l'inglese in
    // italiano fonetico.
    const args = [
      "-m", cfg.modelPath,
      "-l", cfg.language || "auto",
      "-f", wav,
      "--no-timestamps",
      "--no-prints",
    ];
    const whisper = Bun.spawn([cfg.whisperBin, ...args], { timeout: WHISPER_TIMEOUT_MS, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(whisper.stdout).text(), new Response(whisper.stderr).text()]);
    if ((await whisper.exited) !== 0) throw new Error(`whisper-cli: ${err.slice(-300)}`);

    const transcript = out
      .split("\n")
      .filter(line => !/^(whisper|ggml|system|main|encoder|decoder)[_a-z]*\s*:/i.test(line) && line.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return { transcript, model: `whisper.cpp ${cfg.modelPath.split("/").pop()}` };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── Il punto d'ingresso ──────────────────────────────────────────────────────

/**
 * Prova i provider disponibili in ordine e restituisce la prima trascrizione
 * utile. Un provider che va in errore NON interrompe la catena: il suo motivo
 * viene raccolto e, se cadono tutti, finisce nell'`SttError` — è l'unico modo
 * perché «la dettatura non funziona» arrivi all'umano già diagnosticata.
 */
export async function transcribe(audio: SttAudio, deps: SttDeps): Promise<SttResult> {
  const now = deps.now ?? Date.now;
  if (audio.bytes.byteLength > MAX_STT_BYTES) {
    throw new SttError(`audio troppo grande (${Math.round(audio.bytes.byteLength / 1024 / 1024)} MB, max ${MAX_STT_BYTES / 1024 / 1024} MB)`);
  }
  const { chain, all } = resolveSttChain(deps.env);
  if (chain.length === 0) {
    const why = all.map(p => `${p.id}: ${p.reason ?? "?"}`).join(" · ");
    throw new SttError(`nessun provider di trascrizione disponibile: ${why}`);
  }

  const attempts: { provider: SttProviderId; error: string }[] = [];
  for (const provider of chain) {
    const started = now();
    try {
      const model = modelFor(provider.id, deps.env);
      let out: { transcript: string; language?: string | null; model: string };
      switch (provider.id) {
        case "elevenlabs": out = await transcribeElevenLabs(audio, deps, model); break;
        case "openai": out = await transcribeOpenAI(audio, deps, model); break;
        case "deepgram": out = await transcribeDeepgram(audio, deps, model); break;
        case "groq": out = await transcribeGroq(audio, deps, model); break;
        case "local": {
          const run = deps.runLocal ?? ((a: SttAudio, cfg: LocalConfig) => transcribeLocal(a, cfg));
          out = await run(audio, localConfig(deps.env));
          break;
        }
      }
      // Il silenzio non è un messaggio: un artefatto da titoli di coda vale
      // come vuoto, non come testo da incollare nel composer.
      const transcript = isSilenceArtifact(out.transcript) ? "" : out.transcript;
      // UN VUOTO HA DUE CAUSE OPPOSTE, e da fuori si vedono uguali.
      //
      // O il motore non ha restituito niente — l'audio non è arrivato al
      // modello, il contenitore non si è decodificato, la traccia è muta — o ha
      // restituito una delle sue allucinazioni da silenzio («Sottotitoli e
      // revisione a cura di QTSS»), che questo filtro azzera. La prima è un
      // guasto della catena, la seconda è la prova che il microfono ha
      // registrato ZERO ma il giro funziona.
      //
      // Senza questa riga le due erano lo stesso schermo bianco, e la caccia
      // ripartiva da capo ogni volta. Il testo grezzo si tronca a 80 caratteri:
      // serve a riconoscere l'artefatto, non a conservare quello che uno dice.
      if (!transcript) {
        // L'audio si conserva SOLO se qualcuno ha acceso l'interruttore.
        //
        // Il pannello del permesso promette che l'audio non viene conservato, e
        // quella promessa vale. `STT_DUMP_DIR` è la deroga esplicita di chi sta
        // riparando sulla propria macchina: senza il file non c'è modo di
        // distinguere «traccia muta» da «contenitore che non si decodifica»,
        // perché entrambe arrivano qui come zero parole.
        const dump = deps.env.STT_DUMP_DIR;
        if (dump) {
          try {
            const nome = join(dump, `stt-vuoto-${now()}.${estensioneDi(audio)}`);
            writeFileSync(nome, audio.bytes);
            console.warn(`[stt] audio del vuoto conservato in ${nome}`);
          } catch (e) {
            console.warn(`[stt] STT_DUMP_DIR non scrivibile: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const grezzo = out.transcript.trim();
        console.warn(
          `[stt] trascrizione VUOTA da ${provider.id} (${out.model}) su ${audio.bytes.byteLength} byte ` +
            `di ${audio.mimeType}: ${grezzo ? `il motore ha risposto ${JSON.stringify(grezzo.slice(0, 80))}, filtrato come silenzio` : "il motore non ha risposto NIENTE"}`,
        );
      }
      return {
        transcript,
        provider: provider.id,
        model: out.model,
        language: out.language ?? null,
        durationMs: now() - started,
      };
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      attempts.push({ provider: provider.id, error: motivo });
      // UN PROVIDER CHE CADE SI DICE, anche quando il successivo salva il giro.
      //
      // Questo `catch` teneva l'errore dentro `attempts`, che viene mostrato
      // SOLO se falliscono tutti. Con una cascata che funziona, il primo
      // provider poteva essere rotto per giorni senza che nessuno lo sapesse:
      // misurato il 14/08, `capabilities` annunciava `elevenlabs/scribe_v2` e
      // ogni trascrizione veniva servita da whisper locale, cioe' 4,6 secondi
      // al posto di uno. Il fallback aveva nascosto il guasto invece di
      // segnalarlo, ed e' il modo in cui una app diventa lenta senza una causa.
      console.warn(`[stt] provider ${provider.id} caduto, passo al successivo: ${motivo.slice(0, 200)}`);
    }
  }
  throw new SttError(
    `trascrizione fallita su ${attempts.length} provider: ${attempts.map(a => `${a.provider}: ${a.error}`).join(" · ")}`,
    attempts,
  );
}

/** Fotografia per il client: chi c'è, chi manca e perché. */
export function sttCapabilities(env: SttDeps["env"]): SttCapabilities {
  const { chain, all } = resolveSttChain(env);
  const head = chain[0] ?? null;
  return {
    available: !!head,
    provider: head?.id ?? null,
    model: head?.model ?? null,
    providers: all,
    language: languageHint(env),
  };
}
