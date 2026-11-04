// Le voci dell'hub che Topics porta ai client in un frame `hub:live`: un solo posto per server e client.
export const HUB_LIVE_TOPICS = ["pace", "mac", "services", "attesa", "alerts", "gates", "automations"] as const;
export type HubLiveTopic = (typeof HUB_LIVE_TOPICS)[number];

export interface HubLiveEntry {
  data?: unknown;
  error?: string;
  at: number;
}
