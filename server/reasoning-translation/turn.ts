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
import type { StreamHandler } from "../providers";
import type { ChatTurnScope } from "../routes/chat-turn-scope";
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

/**
 * Wraps a turn's stream handler so every reasoning block is also translated:
 * the original callbacks run first and untouched, and each translated sentence
 * leaves on a `stream:reasoning_translation` frame to whoever watches the topic.
 */
export function withReasoningTranslation(
  handler: StreamHandler,
  turn: Pick<ChatTurnScope, "sessionKey" | "matchedTopic" | "broadcastToAll" | "broadcastToTopicSubscribers">,
  getService: typeof getReasoningTranslationService = getReasoningTranslationService,
): StreamHandler {
  const translator = createTurnReasoningTranslator((sentence) => {
    const frame = { type: "stream:reasoning_translation" as const, sessionKey: turn.sessionKey, topicId: turn.matchedTopic?.id, ...sentence };
    if (turn.matchedTopic?.id) turn.broadcastToTopicSubscribers(turn.matchedTopic.id, frame);
    else turn.broadcastToAll(frame);
  }, getService);
  return {
    ...handler,
    onThinkingDelta: (text: string) => {
      handler.onThinkingDelta?.(text);
      translator.delta(text);
    },
    onThinkingEnd: () => {
      handler.onThinkingEnd?.();
      translator.end();
    },
  };
}
