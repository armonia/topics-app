/**
 * The reasoning translation this process uses: Apple's adapter, the app's
 * database for the sentence cache, and the chat language from the settings.
 *
 * Built on first use, never at boot: a machine that never opens a reasoning
 * row pays nothing, and the Swift helper is only compiled when a block in
 * another language actually shows up.
 */
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { getDatabase } from "../db";
import { resolveAppDataDir } from "../lib/data-dir";
import { getAppSettings } from "../services/app-settings";
import { AppleReasoningTranslator } from "./apple-adapter";
import { ReasoningTranslationService, sqliteTranslationStore } from "./service";

/** The two languages the app speaks, as the settings name them. */
const CHAT_LANGUAGES = ["it", "en"] as const;
/** What the interface itself falls back to (`FALLBACK_LOCALE` in the client). */
const DEFAULT_LANGUAGE = "it";
/** The `ui_state` key the client publishes its settings under (`SETTINGS_SERVER_KEY`). */
const UI_SETTINGS_KEY = "settings";

const asChatLanguage = (value: unknown): string | null => {
  const lower = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (CHAT_LANGUAGES as readonly string[]).includes(lower) ? lower : null;
};

/** The interface language the client saved, when the person picked one. */
function interfaceLanguage(db: Database): string | null {
  try {
    const row = db.prepare("SELECT value FROM ui_state WHERE key = ?").get(UI_SETTINGS_KEY) as { value?: string | null } | undefined;
    if (!row?.value) return null;
    return asChatLanguage((JSON.parse(row.value) as { language?: unknown }).language);
  } catch {
    return null;
  }
}

/**
 * The language of the chat: the output language of the settings, and when that
 * is on "auto" the language of the interface, then the app default.
 */
export function resolveReasoningTarget(): string {
  const fromSettings = asChatLanguage(getAppSettings().outputLanguage);
  if (fromSettings) return fromSettings;
  try {
    return interfaceLanguage(getDatabase()) ?? DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

let helperOverride: string | null = null;
let current: ReasoningTranslationService | null = null;

/**
 * Points the Apple adapter at a ready-made helper executable instead of the
 * compiled one (`null` goes back to the real one). Used by the e2e bench to put
 * a fake at the process boundary while everything else stays real.
 */
export function setReasoningHelperOverride(path: string | null): void {
  helperOverride = path;
  current = null;
}

export function getReasoningTranslationService(): ReasoningTranslationService {
  if (!current) {
    const helperPath = helperOverride ?? process.env.TOPICS_REASONING_HELPER ?? undefined;
    current = new ReasoningTranslationService({
      translator: new AppleReasoningTranslator({ cacheDir: join(resolveAppDataDir(), "cache"), ...(helperPath ? { helperPath } : {}) }),
      store: sqliteTranslationStore(getDatabase()),
      resolveTarget: resolveReasoningTarget,
    });
  }
  return current;
}
