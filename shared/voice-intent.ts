/**
 * shared/voice-intent.ts - what the voice loop decides a spoken reply MEANS.
 *
 * It lives here because both sides need the same three words: the server
 * classifier (`server/lib/intent-classifier.ts`) produces one, the client
 * (`client/src/lib/voice/classifyIntent.ts`) switches on it. Declared twice it
 * was a mirror, and `tests/unit/no-type-mirrors.test.ts` refuses those: two
 * copies drift, and the day one gains a fourth case the other keeps answering
 * with three.
 */
export type VoiceIntent = "approve" | "feedback" | "close";
