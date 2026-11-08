import type { WSMessage } from '../types';

// Presence ping shape this module emits. `focus`/`blur` aren't members of the
// typed `WSMessage` union (they're presence-only — no handler narrows on them),
// so the wire shape is documented locally here.
interface FocusMessage {
  type: 'focus';
  topicId: string | null;
}

// Callers thread in their `(msg: WSMessage) => void` sender, so the parameter
// must stay `WSMessage` to remain assignable under `strictFunctionTypes`. The
// `FocusMessage` we emit isn't in that union, so it's widened to `WSMessage`
// via `unknown` at the single send site below — the server's broadcast accepts
// any `{type, ...}` object, this just satisfies the local sender contract.
type SendWS = (msg: WSMessage) => void;

export function sendFocusTopic(sendWS: SendWS | undefined, topicId: string | null): void {
  if (!sendWS) return;
  const msg: FocusMessage = { type: 'focus', topicId };
  sendWS(msg as unknown as WSMessage);
}

export function sendBlur(sendWS: SendWS | undefined): void {
  sendFocusTopic(sendWS, null);
}
