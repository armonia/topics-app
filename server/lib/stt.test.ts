/**
 * La catena della trascrizione, presa dove si rompe.
 *
 * Il difetto che questi test tengono chiuso non è «il provider risponde male»:
 * è che UN provider caduto portasse giù la dettatura intera. Prima esisteva un
 * solo motore (whisper locale) e un solo esito possibile — 500 muto. Qui sotto
 * si verifica che la cascata scenda davvero il gradino successivo, che dica CHI
 * ha trascritto, e che quando cadono tutti l'errore contenga il perché di
 * ciascuno invece di «STT failed».
  * @covers STT-01 @covers STT-02 @covers STT-03
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  transcribe,
  resolveSttChain,
  sttCapabilities,
  isSilenceArtifact,
  localConfig,
  SttError,
  MAX_STT_BYTES,
  type SttAudio,
} from "./stt";

const AUDIO: SttAudio = { bytes: new Uint8Array([1, 2, 3, 4]), filename: "voice.webm", mimeType: "audio/webm" };

/** Un env senza NIENTE: nessuna chiave, e i tre pezzi del whisper locale fissati su percorsi inesistenti. */
function emptyEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PATH: "",
    HOME: "/nonexistent-home-for-tests",
    WHISPER_CLI_PATH: "/nonexistent/whisper-cli",
    FFMPEG_PATH: "/nonexistent/ffmpeg",
    WHISPER_MODEL_PATH: "/nonexistent/ggml.bin",
    ...extra,
  };
}

interface Chiamata { url: string; headers: Record<string, string>; form?: FormData; raw?: unknown }

/**
 * L'errore di una promessa, tipato. `p.catch(e => e)` restituisce l'unione col
 * valore risolto, e ogni accesso a `.message` diventa un errore di tipo — che è
 * come i test finiscono per NON controllare il messaggio, cioè l'unica parte
 * dell'errore che serve a chi lo legge.
 */
const NO_ERROR = Symbol("nessun-errore");
async function errorOf(p: Promise<unknown>): Promise<Error> {
  const esito = await p.then(() => NO_ERROR, (e: unknown) => e);
  if (esito === NO_ERROR) throw new Error("atteso un errore, la promessa è invece riuscita");
  return esito as Error;
}

/** Fetch finto: registra ogni chiamata e risponde secondo una mappa host → esito. */
function fakeFetch(rotte: { match: string; status?: number; body?: unknown; throws?: string }[]) {
  const chiamate: Chiamata[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body;
    chiamate.push({
      url,
      headers,
      form: body instanceof FormData ? body : undefined,
      raw: body instanceof FormData ? undefined : body,
    });
    const rotta = rotte.find(r => url.includes(r.match));
    if (!rotta) return new Response("no route", { status: 404 });
    if (rotta.throws) throw new Error(rotta.throws);
    return new Response(JSON.stringify(rotta.body ?? {}), {
      status: rotta.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, chiamate };
}

describe("resolveSttChain", () => {
  it("senza chiavi e senza whisper locale la catena è vuota, e ogni assenza ha il suo motivo", () => {
    const { chain, all } = resolveSttChain(emptyEnv());
    expect(chain).toHaveLength(0);
    expect(all.map(p => p.id)).toEqual(["elevenlabs", "openai", "deepgram", "groq", "local"]);
    expect(all.find(p => p.id === "openai")?.reason).toContain("OPENAI_API_KEY");
    expect(all.find(p => p.id === "local")?.reason).toContain("whisper-cli");
  });

  it("una chiave presente accende il suo provider e lo mette in cima nell'ordine di default", () => {
    const { chain } = resolveSttChain(emptyEnv({ GROQ_API_KEY: "k", OPENAI_API_KEY: "k" }));
    expect(chain.map(p => p.id)).toEqual(["openai", "groq"]);
  });

  it("STT_PROVIDER fissa UN provider solo: chi lo scrive non vuole scoprire in bolletta di averne usato un altro", () => {
    const { chain, pinned } = resolveSttChain(emptyEnv({ STT_PROVIDER: "groq", GROQ_API_KEY: "k", OPENAI_API_KEY: "k" }));
    expect(pinned).toBe(true);
    expect(chain.map(p => p.id)).toEqual(["groq"]);
  });

  it("STT_PROVIDER accetta una lista e ne rispetta l'ordine scritto", () => {
    const { chain } = resolveSttChain(emptyEnv({ STT_PROVIDER: "groq,openai", GROQ_API_KEY: "k", OPENAI_API_KEY: "k" }));
    expect(chain.map(p => p.id)).toEqual(["groq", "openai"]);
  });

  it("un nome inventato viene scartato invece di far esplodere la risoluzione", () => {
    const { chain } = resolveSttChain(emptyEnv({ STT_PROVIDER: "vaporware,openai", OPENAI_API_KEY: "k" }));
    expect(chain.map(p => p.id)).toEqual(["openai"]);
  });

  it("il modello si sovrascrive per provider senza toccare gli altri", () => {
    const { chain } = resolveSttChain(emptyEnv({ OPENAI_API_KEY: "k", STT_MODEL_OPENAI: "whisper-1" }));
    expect(chain[0].model).toBe("whisper-1");
  });
});

describe("whisper locale: i binari si trovano anche col PATH scarno del Finder", () => {
  it("modello e binari espliciti che ESISTONO rendono il provider disponibile", () => {
    const dir = mkdtempSync(join(tmpdir(), "stt-cfg-"));
    try {
      const whisper = join(dir, "whisper-cli");
      const ffmpeg = join(dir, "ffmpeg");
      const model = join(dir, "ggml-large-v3.bin");
      for (const f of [whisper, ffmpeg, model]) writeFileSync(f, "x");
      const env = emptyEnv({ WHISPER_CLI_PATH: whisper, FFMPEG_PATH: ffmpeg, WHISPER_MODEL_PATH: model });
      const cfg = localConfig(env);
      expect(cfg.whisperBin).toBe(whisper);
      expect(cfg.modelPath).toBe(model);
      const { chain } = resolveSttChain(env);
      expect(chain.map(p => p.id)).toEqual(["local"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("un WHISPER_MODEL_PATH che punta al vuoto NON viene creduto sulla parola", () => {
    expect(localConfig(emptyEnv({ WHISPER_MODEL_PATH: "/nope/ggml-large-v3.bin" })).modelPath).toBeNull();
  });

  it("in una cartella con due modelli vince il più accurato, non il primo trovato", () => {
    const home = mkdtempSync(join(tmpdir(), "stt-home-"));
    try {
      const dir = join(home, "whisper-models");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "ggml-small.bin"), "x");
      writeFileSync(join(dir, "ggml-large-v3.bin"), "x");
      const cfg = localConfig({ PATH: "", HOME: home, WHISPER_CLI_PATH: "/nope", FFMPEG_PATH: "/nope" });
      expect(cfg.modelPath).toBe(join(dir, "ggml-large-v3.bin"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("cascata", () => {
  it("il primo provider che cade passa la mano, e il risultato dice CHI ha trascritto", async () => {
    const { impl, chiamate } = fakeFetch([
      { match: "elevenlabs.io", status: 500, body: { detail: "server on fire" } },
      { match: "api.openai.com", body: { text: "ciao mondo", languages: ["it"] } },
    ]);
    const out = await transcribe(AUDIO, {
      env: emptyEnv({ ELEVENLABS_API_KEY: "k1", OPENAI_API_KEY: "k2" }),
      fetchImpl: impl,
    });
    expect(out.transcript).toBe("ciao mondo");
    expect(out.provider).toBe("openai");
    expect(out.model).toBe("gpt-transcribe");
    expect(out.language).toBe("it");
    // Un tentativo su ElevenLabs (nessun retry: il 500 non è un problema di modello)
    // e uno su OpenAI.
    expect(chiamate.map(c => new URL(c.url).host)).toEqual(["api.elevenlabs.io", "api.openai.com"]);
  });

  it("una fetch che ESPLODE (rete giù) non è diversa da un 500: si scende comunque", async () => {
    const { impl } = fakeFetch([
      { match: "elevenlabs.io", throws: "ECONNREFUSED" },
      { match: "groq.com", body: { text: "fallback vivo" } },
    ]);
    const out = await transcribe(AUDIO, { env: emptyEnv({ ELEVENLABS_API_KEY: "k", GROQ_API_KEY: "k" }), fetchImpl: impl });
    expect(out.provider).toBe("groq");
    expect(out.transcript).toBe("fallback vivo");
  });

  it("il whisper locale è l'ultimo gradino e regge quando il cloud è tutto giù", async () => {
    const { impl } = fakeFetch([{ match: "elevenlabs.io", status: 401, body: { detail: "bad key" } }]);
    const dir = mkdtempSync(join(tmpdir(), "stt-cfg-"));
    try {
      for (const n of ["whisper-cli", "ffmpeg", "ggml-large-v3.bin"]) writeFileSync(join(dir, n), "x");
      const out = await transcribe(AUDIO, {
        env: emptyEnv({
          ELEVENLABS_API_KEY: "k",
          WHISPER_CLI_PATH: join(dir, "whisper-cli"),
          FFMPEG_PATH: join(dir, "ffmpeg"),
          WHISPER_MODEL_PATH: join(dir, "ggml-large-v3.bin"),
        }),
        fetchImpl: impl,
        runLocal: async () => ({ transcript: "trascritto in casa", model: "whisper.cpp ggml-large-v3.bin" }),
      });
      expect(out.provider).toBe("local");
      expect(out.transcript).toBe("trascritto in casa");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caduti tutti, l'errore porta il motivo di OGNUNO — è l'unico modo perché «non trascrive» sia diagnosticabile", async () => {
    const { impl } = fakeFetch([
      { match: "elevenlabs.io", status: 401, body: { detail: "invalid_api_key" } },
      { match: "api.openai.com", status: 429, body: { error: "rate limited" } },
    ]);
    const err = await errorOf(transcribe(AUDIO, { env: emptyEnv({ ELEVENLABS_API_KEY: "k", OPENAI_API_KEY: "k" }), fetchImpl: impl }));
    expect(err).toBeInstanceOf(SttError);
    expect(err.message).toContain("elevenlabs");
    expect(err.message).toContain("invalid_api_key");
    expect(err.message).toContain("openai");
    expect(err.message).toContain("429");
    expect((err as SttError).attempts).toHaveLength(2);
  });

  it("catena vuota: l'errore elenca cosa manca, non un «STT failed»", async () => {
    const err = await errorOf(transcribe(AUDIO, { env: emptyEnv() }));
    expect(err.message).toMatch(/nessun provider/);
    expect(err.message).toContain("ELEVENLABS_API_KEY");
    expect(err.message).toContain("whisper-cli");
  });

  it("l'audio oltre il tetto viene rifiutato PRIMA di spendere una chiamata a pagamento", async () => {
    const { impl, chiamate } = fakeFetch([{ match: "elevenlabs.io", body: { text: "mai arrivato" } }]);
    const grosso: SttAudio = { ...AUDIO, bytes: new Uint8Array(MAX_STT_BYTES + 1) };
    const err = await errorOf(transcribe(grosso, { env: emptyEnv({ ELEVENLABS_API_KEY: "k" }), fetchImpl: impl }));
    expect(err.message).toMatch(/troppo grande/);
    expect(chiamate).toHaveLength(0);
  });
});

describe("dettagli dei provider", () => {
  it("ElevenLabs: un 4xx sul modello nuovo fa ritentare scribe_v1, e il risultato dichiara quale ha risposto", async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ detail: "model_not_found" }), { status: 422 });
      return new Response(JSON.stringify({ text: "va bene lo stesso", language_code: "it" }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await transcribe(AUDIO, { env: emptyEnv({ ELEVENLABS_API_KEY: "k" }), fetchImpl: impl });
    expect(n).toBe(2);
    expect(out.model).toBe("scribe_v1");
    expect(out.transcript).toBe("va bene lo stesso");
  });

  it("ElevenLabs: niente diarizzazione né tag di eventi — chi detta non vuole «(laughter)» nel prompt", async () => {
    const { impl, chiamate } = fakeFetch([{ match: "elevenlabs.io", body: { text: "x" } }]);
    await transcribe(AUDIO, { env: emptyEnv({ ELEVENLABS_API_KEY: "k" }), fetchImpl: impl });
    const form = chiamate[0].form!;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("diarize")).toBe("false");
    expect(form.get("tag_audio_events")).toBe("false");
    // Nessun language_code: l'auto-detect è il default voluto.
    expect(form.get("language_code")).toBeNull();
  });

  it("OpenAI: gpt-transcribe vuole `languages[]`, i modelli vecchi il singolare — mandarli entrambi è un 400", async () => {
    const { impl, chiamate } = fakeFetch([{ match: "api.openai.com", body: { text: "x" } }]);
    const base = emptyEnv({ OPENAI_API_KEY: "k", STT_LANGUAGE: "it" });
    await transcribe(AUDIO, { env: base, fetchImpl: impl });
    expect(chiamate[0].form!.get("languages[]")).toBe("it");
    expect(chiamate[0].form!.get("language")).toBeNull();

    await transcribe(AUDIO, { env: { ...base, STT_MODEL_OPENAI: "whisper-1" }, fetchImpl: impl });
    expect(chiamate[1].form!.get("language")).toBe("it");
    expect(chiamate[1].form!.get("languages[]")).toBeNull();
  });

  it("il prompt di dominio va a gpt-transcribe e NON ai modelli Whisper, dove finirebbe dentro la trascrizione", async () => {
    const { impl, chiamate } = fakeFetch([
      { match: "api.openai.com", body: { text: "x" } },
      { match: "groq.com", body: { text: "x" } },
    ]);
    await transcribe(AUDIO, { env: emptyEnv({ OPENAI_API_KEY: "k" }), fetchImpl: impl });
    expect(String(chiamate[0].form!.get("prompt"))).toContain("rebase");

    await transcribe(AUDIO, { env: emptyEnv({ GROQ_API_KEY: "k" }), fetchImpl: impl });
    expect(chiamate[1].form!.get("prompt")).toBeNull();
  });

  it("STT_PROMPT vuota spegne il suggerimento anche su OpenAI", async () => {
    const { impl, chiamate } = fakeFetch([{ match: "api.openai.com", body: { text: "x" } }]);
    await transcribe(AUDIO, { env: emptyEnv({ OPENAI_API_KEY: "k", STT_PROMPT: "" }), fetchImpl: impl });
    expect(chiamate[0].form!.get("prompt")).toBeNull();
  });

  it("Deepgram: senza lingua fissata si chiede `multi`, altrimenti Nova trascrive l'italiano in fonetica inglese", async () => {
    const { impl, chiamate } = fakeFetch([
      { match: "deepgram.com", body: { results: { channels: [{ alternatives: [{ transcript: "buongiorno" }], detected_language: "it" }] } } },
    ]);
    const out = await transcribe(AUDIO, { env: emptyEnv({ DEEPGRAM_API_KEY: "k" }), fetchImpl: impl });
    expect(new URL(chiamate[0].url).searchParams.get("language")).toBe("multi");
    expect(new URL(chiamate[0].url).searchParams.get("model")).toBe("nova-3");
    expect(out.transcript).toBe("buongiorno");
    expect(out.language).toBe("it");
  });
});

describe("il rumore che Whisper produce sul silenzio", () => {
  it("riconosce gli artefatti da titoli di coda, a trascrizione INTERA", () => {
    expect(isSilenceArtifact("Sottotitoli e revisione a cura di QTSS")).toBe(true);
    expect(isSilenceArtifact("Thanks for watching!")).toBe(true);
    expect(isSilenceArtifact("you")).toBe(true);
    expect(isSilenceArtifact("   ")).toBe(true);
    expect(isSilenceArtifact("you you you")).toBe(true);
  });

  it("NON tocca la stessa frase dentro un discorso vero: il filtro è per uguaglianza, mai per sottostringa", () => {
    expect(isSilenceArtifact("thanks for watching the demo, now open the terminal")).toBe(false);
    expect(isSilenceArtifact("grazie per aver guardato il video di ieri, rifallo con il branch nuovo")).toBe(false);
    expect(isSilenceArtifact("you should rebase")).toBe(false);
  });

  it("un artefatto in risposta esce come stringa vuota, non come messaggio da incollare", async () => {
    const { impl } = fakeFetch([{ match: "groq.com", body: { text: "Sottotitoli e revisione a cura di QTSS" } }]);
    const out = await transcribe(AUDIO, { env: emptyEnv({ GROQ_API_KEY: "k" }), fetchImpl: impl });
    expect(out.transcript).toBe("");
    expect(out.provider).toBe("groq");
  });
});

describe("sttCapabilities", () => {
  it("dice cosa risponderà e cosa manca, così il client non deve indovinarlo", () => {
    const caps = sttCapabilities(emptyEnv({ OPENAI_API_KEY: "k" }));
    expect(caps.available).toBe(true);
    expect(caps.provider).toBe("openai");
    expect(caps.model).toBe("gpt-transcribe");
    expect(caps.providers.find(p => p.id === "deepgram")?.available).toBe(false);
  });

  it("senza niente configurato è `available: false` — il tasto di dettatura ha un motivo per sparire", () => {
    const caps = sttCapabilities(emptyEnv());
    expect(caps.available).toBe(false);
    expect(caps.provider).toBeNull();
  });
});
