// The kinds of «waiting for you» item, shared by Topics' store and the client view.
export const WAITING_KINDS = ["decisione", "spesa", "pubblico", "vista"] as const; // allow-italian: the hub's wire values
export type WaitingKind = (typeof WAITING_KINDS)[number];
