/**
 * THE HALF OF A BROWSER THAT IS NOT IN THE TREE, and the path guard that keeps
 * the OWNER'S browser out of it.
 *
 * The fixture is the real `launchctl print pid/2208` captured by the T0 probe on
 * a macOS CI runner (16/09/2026, run 35031447596): a headless Playwright WebKit
 * with its three services and the pid-0 stubs. The second fixture is the same
 * listing shape for an app whose services live under `/System`, which is what
 * Topics.app's own WKWebView looks like - attributing those to an agent's tree
 * and stopping them would freeze the browser of the person at the machine.
 *
 * @covers KANBAN-85
 */
import { describe, expect, test } from "bun:test";
import {
  attributableServicePids,
  createXpcAttribution,
  installRootOf,
  looksLikeAppExecutable,
  parseLaunchctlServices,
} from "./xpc-attribution";

const PLAYWRIGHT_DOMAIN = `pid/2208 = {
	type = pid
	handle = 2208
	active count = 7
	originator = /Users/runner/Library/Caches/ms-playwright/webkit-2272/Playwright.app

	services = {
		    2216      - 	com.apple.WebKit.WebContent.F3AD7F66-9C33-40D3-BDCD-31B7BF96F764
		       0      - 	com.apple.WebKit.WebContent
		    2327      - 	com.apple.WebKit.GPU.9E6FDA2B-6889-4825-820B-E538F09011C6
		       0      - 	com.apple.WebKit.GPU
		    2214      - 	com.apple.WebKit.Networking.6A630B44-8E8B-4176-A716-60E7891F7775
		       0      - 	com.apple.WebKit.Networking
		    9001      - 	com.apple.ThemeWidgetControlViewService
	}

	service stubs = {
		com.apple.automator.xpc.workflowServiceRunner
	}
}`;

const APP = "/Users/runner/Library/Caches/ms-playwright/webkit-2272/Playwright.app/Contents/MacOS/Playwright";
const commands = new Map<number, string>([
  [2216, "/Users/runner/Library/Caches/ms-playwright/webkit-2272/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development"],
  [2327, "/Users/runner/Library/Caches/ms-playwright/webkit-2272/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU.Development"],
  [2214, "/Users/runner/Library/Caches/ms-playwright/webkit-2272/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking.Development"],
  [9001, "/System/Library/ExtensionKit/Extensions/ThemeWidgetControlViewService.appex/Contents/MacOS/ThemeWidgetControlViewService"],
]);

describe("F4: the services of a pid domain, and only the app's own", () => {
  test("the three Playwright services parse; the pid-0 stubs do not", () => {
    const services = parseLaunchctlServices(PLAYWRIGHT_DOMAIN);
    expect(services.map((s) => s.pid).sort()).toEqual([2214, 2216, 2327, 9001]);
    expect(services.every((s) => s.pid !== 0)).toBe(true);
  });

  test("a system service listed in the same domain fails the path guard", () => {
    const pids = attributableServicePids({
      services: parseLaunchctlServices(PLAYWRIGHT_DOMAIN),
      commandOf: (pid) => commands.get(pid),
      installRoot: installRootOf(APP)!,
    });
    expect(pids.sort()).toEqual([2214, 2216, 2327]);
  });

  test("the install root is the directory of the bundle, not the bundle", () => {
    expect(installRootOf(APP)).toBe("/Users/runner/Library/Caches/ms-playwright/webkit-2272/");
    expect(installRootOf("/bin/bash -lc x")).toBeNull();
  });

  test("a system app's own WebKit can never be attributed to an agent tree", () => {
    const systemDomain = PLAYWRIGHT_DOMAIN.replace(/2216/g, "7001");
    const pids = attributableServicePids({
      services: parseLaunchctlServices(systemDomain),
      commandOf: () => "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent",
      installRoot: "/Applications/Topics.app/",
    });
    expect(pids).toEqual([]);
  });

  test("a domain that cannot be printed attributes nothing, and is not asked twice", async () => {
    let calls = 0;
    const xpc = createXpcAttribution({ print: async () => { calls++; return ""; } });
    expect(await xpc.servicePidsOf(2208, APP, (pid) => commands.get(pid))).toEqual([]);
    expect(await xpc.servicePidsOf(2208, APP, (pid) => commands.get(pid))).toEqual([]);
    expect(calls, "the pid domain is cached for a minute: launchctl forks").toBe(1);
  });

  test("the cached listing is the one used for attribution", async () => {
    const xpc = createXpcAttribution({ print: async () => PLAYWRIGHT_DOMAIN });
    expect((await xpc.servicePidsOf(2208, APP, (pid) => commands.get(pid))).sort()).toEqual([2214, 2216, 2327]);
  });

  test("only an app bundle has a pid domain worth asking about", () => {
    expect(looksLikeAppExecutable(APP)).toBe(true);
    expect(looksLikeAppExecutable("bun batteria.ts")).toBe(false);
  });
});
