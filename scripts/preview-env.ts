/**
 * The environment of a card preview's isolated server.
 *
 * The preview is started BY the production server, so it inherited that
 * server's whole environment: the tunnel port the live server holds (3434 on
 * the Mac, so every preview died on «Is port 3434 in use?» and 14 cards in
 * review read «preview not started» on 19/11), but also its relay, secrets,
 * workspace, mail and Google accounts, licence, CDP port and sockets.
 *
 * Every `TOPICS_*` variable configures a Topics server, and none of the live
 * server's belongs to a preview. So all of them are dropped and the isolated
 * server starts from the environment CI runs its e2e servers with, plus its
 * own values. `start-test-server.sh` fills in the isolated defaults (sockets,
 * HOME, DATA_DIR) only where a value is missing, so an inherited one would
 * win: dropping is what lets those defaults apply.
 */
const TOPICS_SERVER_SETTING = /^TOPICS_/;

export function previewServerEnv(
  inherited: Record<string, string | undefined>,
  own: Record<string, string>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (!TOPICS_SERVER_SETTING.test(name)) env[name] = value;
  }
  return { ...env, ...own };
}
