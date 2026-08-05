import { mergeTests } from "@playwright/test";
import { test as chatTest } from "./chat.fixture";
import { test as sidebarTest } from "./sidebar.fixture";
import { test as terminalTest } from "./terminal.fixture";
import { test as dashboardTest } from "./dashboard.fixture";
import { test as fileExplorerTest } from "./file-explorer.fixture";
import { test as contextTest } from "./context.fixture";
import { test as settingsTest } from "./settings.fixture";
import { test as layoutTest } from "./layout.fixture";
import { test as commandPaletteTest } from "./command-palette.fixture";

export const test = mergeTests(
  chatTest,
  sidebarTest,
  terminalTest,
  dashboardTest,
  fileExplorerTest,
  contextTest,
  settingsTest,
  layoutTest,
  commandPaletteTest
);

export { expect, devices } from "@playwright/test";
