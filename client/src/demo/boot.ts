/* Topics landing demo: boot script. Compiled by client/vite.landing.config.ts
 * into a CLASSIC inline script that runs BEFORE the app bundle, so the real
 * client boots with no server: it seeds the browser storage, then answers
 * fetch and WebSocket from the scenario named by `?scenario=` (default acme).
 * This file only picks; the scenarios carry the data, demo/runtime the mechanics. */
import { dressDarkWindow } from "./runtime/chrome";
import { installFetchStub } from "./runtime/fetch";
import { installSocketStub } from "./runtime/socket";
import { seedLocalStorage, seedSessionStorage } from "./runtime/storage";
import { createAcmeScenario } from "./scenarios/acme";
import { createOrganizationsScenario } from "./scenarios/organizzazioni";
import type { LandingScenario } from "./scenario";

const SCENARIOS: Record<string, () => LandingScenario> = {
  acme: createAcmeScenario,
  organizzazioni: createOrganizationsScenario,
};

function pickScenario(): LandingScenario {
  let name = "acme";
  try { name = new URLSearchParams(location.search).get("scenario") || "acme"; } catch (_e) { /* no location: acme */ }
  // Own keys only: `?scenario=constructor` would find Object.prototype's.
  const make = Object.prototype.hasOwnProperty.call(SCENARIOS, name) ? SCENARIOS[name] : createAcmeScenario;
  return make();
}

const scenario = pickScenario();
seedLocalStorage(scenario.seed);
dressDarkWindow();
seedSessionStorage(scenario.seed);
installFetchStub(scenario);
installSocketStub(scenario);
