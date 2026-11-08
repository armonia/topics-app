// Memorable task ids — a stable adjective-noun slug derived from the task UUID
// (like "brave-otter"), so a task is recognisable at a glance and easy to say
// out loud, while the full UUID stays the source of truth (copied on click, in
// the tooltip, used by the API / deep links). Deterministic: the same id always
// maps to the same slug. Collisions are possible across many tasks but harmless
// — the slug is a human label, not a key; actioning always uses the real UUID.

const ADJECTIVES = [
  'amber', 'brave', 'brisk', 'calm', 'chalky', 'clever', 'coral', 'cosy', 'crisp',
  'dapper', 'deft', 'downy', 'eager', 'earthy', 'frugal', 'gentle', 'giant', 'glossy',
  'golden', 'grounded', 'hazel', 'humble', 'icy', 'iron', 'ivory', 'jolly', 'keen',
  'lively', 'lucky', 'lunar', 'mellow', 'merry', 'nimble', 'noble', 'placid', 'plucky',
  'quiet', 'rapid', 'ruby', 'rustic', 'sandy', 'sleek', 'snug', 'solar', 'spry',
  'stark', 'sunny', 'swift', 'tidy', 'vivid', 'warm', 'witty', 'zesty',
];

const NOUNS = [
  'anvil', 'arch', 'asp', 'badger', 'beacon', 'birch', 'brook', 'cabin', 'cedar',
  'cliff', 'comet', 'cove', 'crane', 'delta', 'ember', 'falcon', 'fern', 'finch',
  'fjord', 'glade', 'harbor', 'heron', 'hollow', 'jetty', 'lark', 'locket', 'lynx',
  'maple', 'marsh', 'meadow', 'nimbus', 'otter', 'pecan', 'pier', 'pine', 'quartz',
  'raven', 'reef', 'ridge', 'sable', 'spire', 'stork', 'summit', 'teardrop', 'thicket',
  'vale', 'vault', 'walrus', 'waterfall', 'willow', 'wren',
];

/** FNV-1a 32-bit — small, stable, no deps. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable "adjective-noun" slug for a task id (e.g. "brave-otter"). */
export function memorableId(id: string): string {
  const h = hash32(id);
  return `${ADJECTIVES[h % ADJECTIVES.length]}-${NOUNS[(h >>> 8) % NOUNS.length]}`;
}
