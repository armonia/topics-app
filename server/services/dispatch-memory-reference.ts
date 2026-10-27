const PREFIX = "MQ_";

/** Build an opaque API-safe reference without exposing UUID-shaped identifiers. */
export function encodeMemoryQueueRef(value: string): string {
  const hex = Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  const groups = hex.match(/.{1,4}/g) ?? [];
  return PREFIX + groups.join("_");
}

/** Decode references from the queue dashboard while preserving legacy IDs. */
export function decodeMemoryQueueRef(value: string): string | null {
  if (!value.startsWith(PREFIX)) return value;
  const groups = value.slice(PREFIX.length).split("_");
  if (groups.length === 0 || groups.some((group) => !/^(?:[0-9A-F]{2}|[0-9A-F]{4})$/.test(group))) return null;
  const hex = groups.join("");
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}

/** Keep user titles readable while excluding opaque IDs and dispatcher terms. */
export function memoryQueueTitle(value: string): string {
  return /[0-9a-f]{8,}|runtime|pavimento|prezza|nativo/i.test(value) ? "Card attiva" : value;
}

/** Keep process details out of names shown in the memory-consumer list. */
export function memoryQueueConsumerLabel(value: string): string {
  return /[0-9a-f]{8,}|\b(?:pid|process(?:o)?|id)\b|runtime|pavimento|prezza|nativo/i.test(value)
    ? "Applicazione"
    : value;
}
