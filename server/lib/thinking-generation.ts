/**
 * Which `thinking` parameter a Claude model id accepts on the Messages API.
 *
 * - "adaptive": `{type: "adaptive"}` (+ `output_config.effort`). The only form
 *   the 4.7+ / 5 family accepts: `budget_tokens` there is a 400.
 * - "adaptive-4-6": Opus/Sonnet 4.6, adaptive must be explicit and `xhigh`
 *   does not exist yet.
 * - "legacy": `{type: "enabled", budget_tokens}`. Claude 3.x and every 4.0-4.5
 *   model (Haiku 4.5 included), plus non-Claude ids.
 *
 * The LEGACY generations are the closed list, not the adaptive ones: a list of
 * "models that want adaptive" goes stale the day a model ships (Opus 4.8 and
 * the whole 5 family fell through it and got `budget_tokens`). Old models do
 * not get new ids, so anything Claude that is not provably old is adaptive.
 *
 * Pure: shared by the API-key provider and the native runtime.
 */
export type ThinkingGeneration = "adaptive" | "adaptive-4-6" | "legacy";

const LEGACY_FAMILY_NAMES = new Set(["opus", "sonnet", "haiku"]);

export function thinkingGenerationOf(model: string): ThinkingGeneration {
  // `[1m]` is our own suffix and never reaches the API.
  const bare = model.trim().toLowerCase().replace(/\[1m\]$/, "");
  if (!bare.startsWith("claude-")) return "legacy";
  // Pre-4 naming (`claude-3-7-sonnet-…`, `claude-3-5-haiku-…`).
  if (/^claude-\d/.test(bare)) return "legacy";
  // `claude-<family>-<major>[-<minor>]`; a date suffix (`-20250514`) is not a
  // minor, hence the lookahead.
  const m = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2})(?!\d))?/.exec(bare);
  if (!m) return "adaptive";
  const family = m[1]!;
  const major = Number(m[2]);
  const minor = m[3] === undefined ? 0 : Number(m[3]);
  // Only the three historic families ever shipped a pre-4.6 model; a new
  // family (Fable, Mythos, …) starts adaptive whatever its version number.
  if (!LEGACY_FAMILY_NAMES.has(family)) return "adaptive";
  if (major < 4) return "legacy";
  if (major === 4) {
    if (minor <= 5) return "legacy";
    if (minor === 6 && (family === "opus" || family === "sonnet")) return "adaptive-4-6";
  }
  return "adaptive";
}
