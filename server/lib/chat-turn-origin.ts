/**
 * WHO STARTS a turn that came in through `POST /api/chat` (project quota brake).
 *
 * The route is the one door for the turns of people, agents, channels and
 * scheduled jobs. The project pause (`services/turn-gate.ts`) lets a person's
 * message through and holds everything else, so the route must know which one
 * it is looking at. The rule, in this order:
 *
 *  1. A request the server built for itself (`internalRequest`): the PERSON
 *     default here. Those callers (board turn, wake, resume, the answer relay,
 *     a new chat's first message) ask the gate at their own door, with their
 *     own source; asking twice would hold a person's answer.
 *  2. The body declares `origin: "automation"`: an automation, whoever sends
 *     it. `originSource` names it (`scheduled-job` for a scheduled job,
 *     `channel-turn` otherwise). This is what a channel service or a job
 *     runner calls with. Declaring it can only make the turn WAIT, so it needs
 *     no trust.
 *  3. `fromAgent` or an agent credential: an agent writing to a chat
 *     (`send_chat_message`). An agent is never a person.
 *  4. The body carries a channel `sender` (the trusted `sender` field, owner
 *     only) that is not the owner: somebody writing on WhatsApp or Discord.
 *     The owner's own channel message stays a person's.
 *  5. Anything else is a person: the app's composer sends none of the above,
 *     so it passes untouched.
 */
import { automation, PERSON, type AutomationSource, type TurnOrigin } from "../services/turn-gate";

const DECLARABLE: ReadonlySet<AutomationSource> = new Set<AutomationSource>(["scheduled-job", "channel-turn", "agent-chat"]);

export function chatTurnOrigin(input: {
  internal: boolean;
  sentByAgent: boolean;
  /** A channel `sender` the route accepted (owner-only field) and that is not the owner. */
  channelSender: boolean;
  body: Record<string, unknown>;
}): TurnOrigin {
  if (input.internal) return PERSON;
  if (input.body.origin === "automation") {
    const named = input.body.originSource as AutomationSource;
    return automation(DECLARABLE.has(named) ? named : "channel-turn");
  }
  if (input.sentByAgent) return automation("agent-chat");
  if (input.channelSender) return automation("channel-turn");
  return PERSON;
}
