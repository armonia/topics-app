/**
 * WHICH CLAUDE PLAN THIS MACHINE IS SIGNED IN WITH, and nothing else.
 *
 * The user menu says it in the tail of «AI providers» («Claude Code · Max 20x»)
 * so the question "what am I paying for" is answered without opening anything.
 * The CLI already writes the answer next to its tokens: `subscriptionType`
 * (`pro`, `max`, ...) and `rateLimitTier` (`default_claude_max_20x`). Those two
 * strings are the WHOLE payload that leaves the server.
 *
 * WHY A FUNCTION OF ITS OWN. The document they sit in is the credential: access
 * token, refresh token, scopes. Copying "the credentials minus the secrets"
 * would be a deny list, and a deny list leaks the first field somebody adds.
 * This is an allow list of two names, and each value must also LOOK like a
 * label (short, no punctuation a token is made of): a CLI that one day puts a
 * secret under one of these names still does not get it onto the wire.
 */
import { readCredentials } from "../native/auth";
import type { ProviderSnapshotEntry } from "../../../shared/types";

export type ClaudeSubscription = NonNullable<ProviderSnapshotEntry["subscription"]>;

/** A plan name or a tier id: letters, digits and underscores, short. */
const LABEL = /^[a-z0-9_]{1,48}$/i;

function label(value: unknown): string | null {
  return typeof value === "string" && LABEL.test(value) ? value : null;
}

/** The two strings, from anything shaped like parsed credentials. */
export function subscriptionFrom(credentials: { subscriptionType?: unknown; rateLimitTier?: unknown } | null): ClaudeSubscription | null {
  if (!credentials) return null;
  const type = label(credentials.subscriptionType);
  const tier = label(credentials.rateLimitTier);
  return type || tier ? { type, tier } : null;
}

/** Read now, from the same store the native runtime authenticates with. */
export function readClaudeSubscription(): ClaudeSubscription | null {
  try {
    return subscriptionFrom(readCredentials());
  } catch {
    return null;
  }
}
