// The hub entries Topics carries to clients in a `hub:live` frame: one place for server and client.
export const HUB_LIVE_TOPICS = ["pace", "mac", "services", "attesa", "alerts", "gates", "automations", "projects"] as const; // allow-italian: "attesa" is the hub API key, compared by value
export type HubLiveTopic = (typeof HUB_LIVE_TOPICS)[number];

export interface HubLiveEntry {
  data?: unknown;
  error?: string;
  at: number;
}
