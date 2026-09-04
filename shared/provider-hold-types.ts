// provider-hold-types.ts — the shape of "the provider is not worth calling yet",
// declared ONCE for the two sides that both have to know it.
//
// The server records the hold (`server/lib/provider-hold.ts`) and announces it
// with the `provider:hold` frame; the client keeps it to put the banner on
// screen (`client/src/state/providerHold.ts`). Both used to declare the same
// interface on their own side, and the two copies had already drifted: the
// client's was missing `reason`, which is the only field that says WHY out
// loud. One declaration cannot drift from itself.

/** Which of the plan's usage windows is spent. */
export type UsageWindowKind = "five_hour" | "seven_day";

export interface ProviderHold {
  /** When the provider is expected to accept requests again (ms epoch). */
  untilMs: number;
  /** Which of the plan's windows is spent: the client translates this. */
  window: UsageWindowKind;
  /** One line for logs and the chat, e.g. "finestra di 5 ore esaurita". */
  reason: string;
  /** When the hold was recorded (ms epoch). */
  sinceMs: number;
}
