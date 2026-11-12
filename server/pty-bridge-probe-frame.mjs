// Pure parse/validate for a single JSON-line frame read off the probe socket
// in pty-bridge.mjs. Split out of probeBridge() so it is importable without
// triggering the bridge daemon's top-level start() — see
// pty-bridge-probe-frame.test.ts.
export function parseProbeFrame(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  // A bare `null`/number/string line parses fine but is not a frame — reject
  // it here so callers never touch .id/.type on a non-object.
  if (!msg || typeof msg !== 'object') return null;
  return msg;
}
