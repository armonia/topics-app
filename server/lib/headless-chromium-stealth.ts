/**
 * Il Chromium headless del server non deve presentarsi come automatizzato ai
 * siti dove entriamo con i NOSTRI account (Hetzner, console di fornitori).
 *
 * Misurato il 09/11 su console.hetzner.com, stesso IP, stessa ora, un tentativo
 * ogni 90 s: con `navigator.webdriver === true` l'anti-bot Heray rimanda in
 * ciclo alla pagina «Security Check» (40 s senza arrivare al login); con quel
 * solo valore a false, stesso browser e stesso UA «HeadlessChrome», il login
 * arriva in 3,7 s. Il resto (UA, viewport) non cambiava l'esito su Hetzner.
 */

/** `--disable-blink-features=AutomationControlled` toglie `webdriver` dal motore. */
export const HEADLESS_AUTOMATION_ARGS: readonly string[] = [
  "--disable-blink-features=AutomationControlled",
];

/**
 * UA di un Chrome vero (formato «ridotto»: versione maggiore e `.0.0.0`) al posto
 * di `HeadlessChrome/...`. Gli hint `Sec-CH-UA` di questo Chromium dicono già
 * «Chromium», quindi UA e hint restano coerenti. Il sistema segue la piattaforma
 * su cui gira il server.
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
