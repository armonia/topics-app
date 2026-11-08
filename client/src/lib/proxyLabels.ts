/**
 * The Claude proxy's file name of each account (`auto-2`) mapped to its label
 * (the e-mail), from its `/api/profiles`. A leaf of its own: the bell's button
 * reads it on every screen, the event sentences (`proxyEvents.ts`) only in the
 * panel's chunk.
 */
export function proxyLabels(profiles: unknown): Map<string, string> {
  const labels = new Map<string, string>();
  const list = typeof profiles === 'object' && profiles !== null && Array.isArray((profiles as { profiles?: unknown }).profiles)
    ? (profiles as { profiles: unknown[] }).profiles
    : [];
  for (const p of list) {
    if (typeof p !== 'object' || p === null) continue;
    const { name, label } = p as { name?: unknown; label?: unknown };
    if (typeof name !== 'string' || name.trim() === '') continue;
    labels.set(name, typeof label === 'string' && label.trim() !== '' ? label : name);
  }
  return labels;
}
