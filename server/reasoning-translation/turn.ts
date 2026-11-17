/**
 * The reasoning translation of ONE chat turn, as the chat handler uses it.
 *
 * The handler feeds it every reasoning delta and tells it when a block ends; it
 * hands back each translated sentence through `emit`. A turn can hold several
 * reasoning blocks (one before each round of tools), and each is translated on
 * its own: the language is decided per block and sentence numbers restart.
 *
 * Nothing here can fail a turn: the service swallows adapter errors, and the
 * promises are detached on purpose, so a slow helper never delays a chunk.
 */
import { getReasoningTranslationService } from "./default";
import type { ReasoningTranslationStream, TranslatedSentence } from "./service";

export interface TurnReasoningTranslator {
  /** A piece of reasoning text arrived. Opens a block when none is open. */
  delta(text: string): void;
  /** The current reasoning block is over. */
  end(): void;
}

export function createTurnReasoningTranslator(
  emit: (sentence: TranslatedSentence & { index: number }) => void,
  getService: typeof getReasoningTranslationService = getReasoningTranslationService,
): TurnReasoningTranslator {
  let block: ReasoningTranslationStream | null = null;
  return {
    delta(text) {
      if (!text) return;
      try {
        block ??= getService().createStream(emit);
        block.push(text);
      } catch {
        // No database yet, or a service that failed to build: the original text stays.
        block = null;
      }
    },
    end() {
      const finished = block;
      block = null;
      void finished?.end().catch(() => {});
    },
  };
}
