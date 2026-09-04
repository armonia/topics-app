// The provider hold as it crosses the wire (`provider:hold`): the plan's usage
// window is spent and the server holds dispatch and resumes until `untilMs`.
// Declared once here; server/lib/provider-hold.ts and client/src/state/providerHold.ts
// re-export it (see tests/unit/no-type-mirrors.test.ts).

export type UsageWindowKind = 'five_hour' | 'seven_day';

export interface ProviderHold {
  /** When the provider is expected to accept requests again (ms epoch). */
  untilMs: number;
  /** Which of the plan's windows is spent: the client translates this. */
  window: UsageWindowKind;
  /** One line for logs and the chat, naming the spent window. */
  reason: string;
  /** When the hold was recorded (ms epoch). */
  sinceMs: number;
}
