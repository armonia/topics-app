/**
 * Client-side call to `POST /api/voice/intent` (see
 * `server/lib/intent-classifier.ts`). The intent itself is NOT redeclared
 * here: it lives in `shared/voice-intent.ts` and is re-exported, so the client
 * bundle still pulls in no server code and the two sides cannot drift apart.
 */

export type { VoiceIntent } from '../../../../shared/voice-intent';
import type { VoiceIntent } from '../../../../shared/voice-intent';

export interface VoiceIntentResult {
  intent: VoiceIntent;
  /** Only for `feedback`: the text to post back to the task as a comment. */
  text?: string;
  source: 'groq' | 'keyword';
}

/**
 * Never throws. A network failure or a non-OK response falls back to
 * `feedback` with the raw text — the safe default, same one the server uses
 * when Groq is unreachable: an extra feedback round costs a re-read, a wrong
 * `approve` closes a task by mistake.
 */
export async function classifyVoiceIntent(text: string): Promise<VoiceIntentResult> {
  try {
    const resp = await fetch('/api/voice/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) throw new Error(`voice intent classify failed: ${resp.status}`);
    return (await resp.json()) as VoiceIntentResult;
  } catch {
    return { intent: 'feedback', text, source: 'keyword' };
  }
}
