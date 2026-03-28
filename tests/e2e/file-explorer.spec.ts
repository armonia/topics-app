import { expect } from "@playwright/test";
import { test } from "./fixtures/file-explorer.fixture";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync } from "fs";

test.describe("File Explorer & Git", () => {
  let topicId: string;
  const tmpDir = `/tmp/e2e-files-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    // Create temp directory with subdirectory
    mkdirSync(`${tmpDir}/src`, { recursive: true });

    // Create initial files
    writeFileSync(
      `${tmpDir}/package.json`,
      JSON.stringify(
        {
          name: "e2e-test-project",
          scripts: { dev: "echo dev", build: "echo build", test: "echo test" },
        },
        null,
        2
      )
    );
    writeFileSync(`${tmpDir}/README.md`, "# E2E Test Project\n");
    writeFileSync(
      `${tmpDir}/src/index.ts`,
      'export const hello = "world";\n'
    );

    // Initialize git repo and make initial commit
    execSync("git init", { cwd: tmpDir });
    execSync("git add -A", { cwd: tmpDir });
    execSync('git commit -m "initial"', { cwd: tmpDir });

    // Modify src/index.ts to create M (modified) status for FILE-03
    writeFileSync(
      `${tmpDir}/src/index.ts`,
      'export const hello = "modified";\n'
    );

    // Create new untracked file for ?? status for FILE-03
    writeFileSync(`${tmpDir}/newfile.txt`, "new content\n");

    // Create topic with projectPath pointing to temp dir
    const topic = await createTopic(request, "e2e-file-explorer-test", {
      projectPath: tmpDir,
    });
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    // Cleanup topic
    if (topicId) {
      await deleteTopic(request, topicId);
    }
    // Cleanup temp directory
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("FILE-01: file tree renders hierarchy", async ({ fileExplorerPage }) => {
    // Implemented in plan 06-02 / 06-03
  });

  test("FILE-02: clicking file opens editor", async ({ fileExplorerPage }) => {
    // Implemented in plan 06-02 / 06-03
  });

  test("FILE-03: git status indicators on files", async ({
    fileExplorerPage,
  }) => {
    // Implemented in plan 06-02 / 06-03
  });

  test("FILE-04: breadcrumb navigation works", async ({
    fileExplorerPage,
  }) => {
    // Implemented in plan 06-02 / 06-03
  });

  test("FILE-05: file search finds results", async ({ fileExplorerPage }) => {
    // Implemented in plan 06-02 / 06-03
  });

  test("FILE-06: diff viewer shows changes", async ({ fileExplorerPage }) => {
    // Implemented in plan 06-02 / 06-03
  });

  test("FILE-07: script runner lists and runs scripts", async ({
    fileExplorerPage,
  }) => {
    // Implemented in plan 06-02 / 06-03
  });

  test("FILE-08: process list shows running agents", async ({
    fileExplorerPage,
  }) => {
    // Implemented in plan 06-02 / 06-03
  });

  test("FILE-09: git commit workflow", async ({ fileExplorerPage }) => {
    // Implemented in plan 06-02 / 06-03
  });
});
