/**
 * The server's headless Chromium must not present itself as automated to the
 * sites we sign in to with OUR OWN accounts (Hetzner, supplier consoles).
 *
 * Measured on 09/11 against console.hetzner.com, same IP, same hour, one try
 * every 90 s: with `navigator.webdriver === true` the Heray anti-bot sends the
 * browser back to the "Security Check" page in a loop (40 s without reaching
 * the login); with only that value false, same browser and same
 * "HeadlessChrome" UA, the login arrives in 3.7 s. UA and viewport did not
 * change the outcome on Hetzner.
 */

/** `--disable-blink-features=AutomationControlled` removes `webdriver` from the engine. */
export const HEADLESS_AUTOMATION_ARGS: readonly string[] = [
  "--disable-blink-features=AutomationControlled",
];

/**
 * A real Chrome UA (the "reduced" format: major version plus `.0.0.0`) instead
 * of `HeadlessChrome/...`. This Chromium's `Sec-CH-UA` hints already say
 * "Chromium", so UA and hints stay consistent. The OS part follows the platform
 * the server runs on.
 */
export function reducedChromeUserAgent(
  browserVersion: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const major = /^(\d+)\./.exec(browserVersion)?.[1];
  if (!major) return undefined;
  const os =
    platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
