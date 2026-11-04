// Hub topics that Topics delivers to clients in a `hub:live` frame: one place for both server and client.
export const HUB_LIVE_TOPICS = ["pace", "mac", "services", "attesa", "alerts", "gates", "automations"] as const;
export type HubLiveTopic = (typeof HUB_LIVE_TOPICS)[number];

export interface HubLiveEntry {
  data?: unknown;
  error?: string;
  at: number;
}
