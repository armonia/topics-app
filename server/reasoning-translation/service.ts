/**
 * Reasoning translation: the thinking text, in the language of the chat.
 *
 * The model's reasoning summary often arrives in English even when the chat is
 * in another language. This service turns it into the chat language, sentence by
 * sentence, with whatever `ReasoningTranslator` the machine offers, and keeps
 * every translated sentence so a reload never translates twice.
 *
 * Rules that keep it harmless:
 *  - the original text is never touched: this only produces ADDITIONAL text the
 *    client can show instead;
 *  - nothing is translated unless the block is long enough to name its language
 *    and the detector is confident (a detector is wrong on "ok");
 *  - no translator, language pair not installed, or an adapter error all mean
 *    "show the original", never an error to the person.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { isTranslatableSentence, splitSentences } from "../../shared/reasoning-sentences";
import type { ReasoningTranslator } from "./translator";

/** A block shorter than this is not translated: too little text to name its language. */
export const MIN_DETECT_CHARS = 40;
/** Below this confidence the detected language is not trusted. */
const MIN_DETECT_CONFIDENCE = 0.7;
/** How long "this pair is (not) ready" is remembered before the adapter is asked again. */
const PAIR_MEMO_MS = 60_000;

export interface TranslatedSentence {
  /** The sentence exactly as it appears in the reasoning, trimmed. */
  source: string;
  /** Its translation. */
  text: string;
}

export interface TranslationStore {
  get(sourceHash: string, target: string): string | null;
  put(sourceHash: string, target: string, sourceLanguage: string, text: string): void;
}

/** The sentence cache: one row per (sentence, target language). */
export function sqliteTranslationStore(db: Database): TranslationStore {
  return {
    get(sourceHash, target) {
      const row = db
        .prepare("SELECT translated_text AS text FROM reasoning_translations WHERE source_hash = ? AND target_language = ?")
        .get(sourceHash, target) as { text?: string } | undefined;
      return row?.text ?? null;
    },
    put(sourceHash, target, sourceLanguage, text) {
      db.prepare(
        "INSERT OR REPLACE INTO reasoning_translations (source_hash, target_language, source_language, translated_text, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(sourceHash, target, sourceLanguage, text, new Date().toISOString());
    },
  };
}

export function hashSentence(sentence: string): string {
  return createHash("sha256").update(sentence).digest("hex");
}

interface ReasoningTranslationDeps {
  translator: ReasoningTranslator;
  store: TranslationStore;
  /** The chat language right now: the setting, else the interface language. */
  resolveTarget: () => string;
}

interface TranslateResult {
  /** False when no translation can happen on this machine (the client stops asking for a while). */
  available: boolean;
  target: string;
  sentences: TranslatedSentence[];
}

export class ReasoningTranslationService {
  private readonly pairMemo = new Map<string, { ready: boolean; at: number }>();

  constructor(private readonly deps: ReasoningTranslationDeps) {}

  target(): string {
    return this.deps.resolveTarget();
  }

  /**
   * The language `text` is in, when it should be translated to `target`;
   * null when it should be left alone (same language, too short, unsure, or
   * the pair is not usable).
   */
  async sourceLanguageToTranslate(text: string, target: string): Promise<string | null> {
    if (text.trim().length < MIN_DETECT_CHARS) return null;
    const { translator } = this.deps;
    if (!(await translator.available())) return null;
    let detected;
    try {
      detected = await translator.detect(text);
    } catch {
      return null;
    }
    if (!detected || detected.confidence < MIN_DETECT_CONFIDENCE) return null;
    const language = detected.language.split("-")[0]!.toLowerCase();
    if (language === "und" || language === target) return null;
    return (await this.pairReady(language, target)) ? language : null;
  }

  /** Translate one sentence through the cache. Null when the adapter fails. */
  async translateSentence(source: string, from: string, target: string): Promise<string | null> {
    const hash = hashSentence(source);
    const cached = this.deps.store.get(hash, target);
    if (cached !== null) return cached;
    try {
      const text = (await this.deps.translator.translate(source, from, target)).trim();
      if (!text) return null;
      this.deps.store.put(hash, target, from, text);
      return text;
    } catch {
      return null;
    }
  }

  /** A whole settled block, for a row the person opens. */
  async translateText(text: string): Promise<TranslateResult> {
    const target = this.target();
    const none: TranslateResult = { available: false, target, sentences: [] };
    if (!(await this.deps.translator.available())) return none;
    const from = await this.sourceLanguageToTranslate(text, target);
    if (!from) return { available: true, target, sentences: [] };
    const sentences: TranslatedSentence[] = [];
    for (const raw of splitSentences(text)) {
      const source = raw.trim();
      if (!isTranslatableSentence(source)) continue;
      const translated = await this.translateSentence(source, from, target);
      if (translated !== null) sentences.push({ source, text: translated });
    }
    return { available: true, target, sentences };
  }

  /** The live path: sentences are translated as they close while the model writes. */
  createStream(emit: (sentence: TranslatedSentence & { index: number }) => void): ReasoningTranslationStream {
    return new ReasoningTranslationStream(this, emit);
  }

  private async pairReady(from: string, to: string): Promise<boolean> {
    const key = `${from}>${to}`;
    const memo = this.pairMemo.get(key);
    if (memo && Date.now() - memo.at < PAIR_MEMO_MS) return memo.ready;
    let ready = false;
    try {
      ready = await this.deps.translator.pairReady(from, to);
    } catch {
      ready = false;
    }
    this.pairMemo.set(key, { ready, at: Date.now() });
    return ready;
  }
}

/**
 * One reasoning block while it streams. `push` takes each delta; a sentence is
 * translated once the next one has started (it is closed), and the last one when
 * `end` is called. Work is chained, so sentences leave in order and a slow
 * translation never overlaps the next.
 */
export class ReasoningTranslationStream {
  private text = "";
  private done = 0;
  private from: string | null | undefined;
  private target: string | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly service: ReasoningTranslationService,
    private readonly emit: (sentence: TranslatedSentence & { index: number }) => void,
  ) {}

  push(delta: string): void {
    if (!delta) return;
    this.text += delta;
    this.schedule(false);
  }

  /** The block is over: translate what is left, and resolve when every sentence has been emitted. */
  end(): Promise<void> {
    this.schedule(true);
    return this.chain;
  }

  private schedule(final: boolean): void {
    this.chain = this.chain.then(() => this.work(final)).catch(() => {});
  }

  private async work(final: boolean): Promise<void> {
    this.target ??= this.service.target();
    if (this.from === undefined) {
      // Decide once per block, as soon as there is enough text to name a language.
      if (this.text.trim().length < MIN_DETECT_CHARS && !final) return;
      this.from = await this.service.sourceLanguageToTranslate(this.text, this.target);
    }
    if (!this.from) return;
    const parts = splitSentences(this.text);
    // The last segment may still be growing: only the ones before it are closed.
    const closed = final ? parts.length : parts.length - 1;
    for (; this.done < closed; this.done++) {
      const source = parts[this.done]!.trim();
      if (!isTranslatableSentence(source)) continue;
      const text = await this.service.translateSentence(source, this.from, this.target);
      if (text !== null) this.emit({ index: this.done, source, text });
    }
  }
}
