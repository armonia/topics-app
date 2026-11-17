/**
 * The seam between the reasoning translation and whatever translates.
 *
 * One adapter exists today (Apple's on-device Translation framework, in
 * `apple-adapter.ts`). The interface is what the service talks to, so a second
 * adapter is a new file and a line in `getReasoningTranslator`, not a change
 * to the service.
 */

export interface DetectedLanguage {
  /** BCP 47 language code as the detector names it ("en", "it", "und" when unknown). */
  language: string;
  /** 0..1, how sure the detector is. */
  confidence: number;
}

export interface ReasoningTranslator {
  readonly name: string;
  /** Can this machine translate at all? False is a normal answer, never an error. */
  available(): Promise<boolean>;
  /** The language of a text, or null when the adapter cannot tell. */
  detect(text: string): Promise<DetectedLanguage | null>;
  /** Is the language pair ready to use right now (installed, no download needed)? */
  pairReady(from: string, to: string): Promise<boolean>;
  /** Translate one piece of text. Rejects when the adapter fails. */
  translate(text: string, from: string, to: string): Promise<string>;
}

