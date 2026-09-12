export function installationInviteUrl(relay: {
  enabled?: boolean;
  baseUrl?: string | null;
  relayId?: string | null;
} | null): string | null {
  if (!relay?.enabled || !relay.baseUrl || !relay.relayId) return null;
  return `${relay.baseUrl.replace(/\/$/, '')}/i/${encodeURIComponent(relay.relayId)}`;
}
