/**
 * The complete delegated-start handoff, across the two real application doors.
 *
 * Setup uses only owner APIs and the existing asymmetric guest-pairing fixture.
 * The useful scene is the product: the guest starts with an empty request, the
 * owner sees the immutable initiator and local computer on the board, and
 * revocation returns the guest card to a cancelled state. Auto-dispatch is off,
 * so no provider or language model can be reached.
 *
 * @covers GUEST-20
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { projectIdForPath } from "../../shared/board";
import { SESSION_COOKIE } from "../../server/lib/device-auth";
import { hermetic } from "./fixtures/hermetic";
import {
  createTopic,
  deleteTask,
  deleteTopic,
  resetPaneStore,
  resetProjectPanes,
  seedProjectPane,
} from "./helpers/api-fixtures";
import { clipDiConsegna } from "./helpers/clip";
import { beat, didascalia } from "./helpers/evidence";
import { removeTmpDir } from "./helpers/file-project";
import { ospite } from "./helpers/ospite";
import { projectRow } from "./helpers/project-row";
import { E2E_BASE, E2E_TUNNEL_BASE } from "./helpers/test-server";

hermetic(test);

const ROOT = realpathSync("/tmp");

async function openProjectBoard(page: Page, projectName: RegExp): Promise<void> {
  const projects = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projects.count()) > 0 && (await projects.getAttribute("aria-expanded")) === "false") {
    await projects.click();
  }
  await projectRow(page, projectName).click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 15_000 });

  if (!(await page.getByTestId("kanban-board").isVisible().catch(() => false))) {
    const existing = page.getByTestId("project-window")
      .locator('[data-testid="pane-tab-label"]', { hasText: /^Board$/ });
    if ((await existing.count()) > 0) {
      await existing.first().click();
    } else {
      const triggers = page.getByTestId("pane-add-menu-trigger");
      for (let index = (await triggers.count()) - 1; index >= 0; index--) {
        const trigger = triggers.nth(index);
        if (!(await trigger.isVisible().catch(() => false))) continue;
        await trigger.click();
        const item = page.getByTestId("pane-add-menu-kanban");
        if (await item.isVisible().catch(() => false)) {
          await item.click();
          break;
        }
        await page.keyboard.press("Escape");
      }
    }
  }
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
}

async function openDevicesSettings(page: Page): Promise<void> {
  await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible({ timeout: 20_000 });
  const panel = page.getByTestId('settings-panel');
  await expect(async () => {
    await page.keyboard.press('Meta+Comma');
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await panel.getByRole('button', { name: 'Dispositivi', exact: true }).click();
  await expect(panel.getByTestId('remote-node-requests')).toBeVisible();
}

test("GUEST-20: owner grant, guest Start, local identity, and revoke stay hermetic", async ({ request }) => {
  test.info().annotations.push({ type: "spec", description: "GUEST-20" });
  test.setTimeout(120_000);

  const stamp = Date.now();
  const projectName = `e2e-delegated-start-${stamp}`;
  const projectPath = join(ROOT, projectName);
  const projectId = projectIdForPath(projectPath);
  let catalogueProjectId: string | null = null;
  let topicId: string | null = null;
  let taskId: string | null = null;

  try {
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, "package.json"), JSON.stringify({ name: projectName }));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectPath });
    execFileSync("git", ["remote", "add", "origin", "https://example.test/team/delegated-start.git"], {
      cwd: projectPath,
    });

    const registered = await request.post(`${E2E_BASE}/api/projects`, {
      data: { name: projectName, path: projectPath },
    });
    expect(registered.ok(), await registered.text()).toBeTruthy();
    catalogueProjectId = ((await registered.json()) as { id: string }).id;

    topicId = (await createTopic(request, `Delegated start ${stamp}`, { projectPath })).id;
    await resetPaneStore(request, []);
    await resetProjectPanes(request, projectPath);
    await seedProjectPane(request, projectPath);

    const created = await request.post(`${E2E_BASE}/api/boards/${projectId}/tasks`, {
      data: { text: `Prepare the authorized release ${stamp}`, status: "backlog" },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    taskId = ((await created.json()) as { id: string }).id;

    const guestName = `delegated-guest-${stamp}`;
    const { cookie } = await ospite(request, guestName);
    const subjectsResponse = await request.get(`${E2E_BASE}/api/auth/subjects`);
    const subjects = (await subjectsResponse.json()) as {
      subjects: Array<{ subjectType: string; subjectId: string; name: string }>;
    };
    const person = subjects.subjects.find((subject) =>
      subject.subjectType === "person" && subject.name === `Persona ${guestName}`,
    );
    expect(person, "the paired guest must resolve to one person").toBeTruthy();

    const shared = await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: {
        subjectType: "person",
        subjectId: person!.subjectId,
        resourceType: "project",
        resourceId: projectId,
        level: "comment",
      },
    });
    expect(shared.ok(), await shared.text()).toBeTruthy();

    const machineResponse = await request.get(`${E2E_BASE}/api/machines`);
    const machineBody = (await machineResponse.json()) as {
      machines: Array<{ id: string; name: string; baseUrl: string | null }>;
    };
    const localMachine = machineBody.machines.find((machine) => machine.baseUrl === null);
    expect(localMachine, "the installation must expose its canonical local machine").toBeTruthy();

    const capabilityResponse = await request.post(`${E2E_BASE}/api/auth/agent-start-capabilities`, {
      data: {
        projectId,
        subjectType: "person",
        subjectId: person!.subjectId,
        machineId: localMachine!.id,
        model: "gpt-5.6-luna",
        effort: "medium",
        maxDurationMinutes: 15,
      },
    });
    expect(capabilityResponse.status(), await capabilityResponse.text()).toBe(201);
    const capability = (await capabilityResponse.json()) as { capability: { id: string } };

    // This is the fake dispatch seam for the acceptance: the production queue
    // and audit writes still happen, while the global switch prevents a turn.
    const stopped = await request.patch(`${E2E_BASE}/api/all-boards/settings`, {
      data: { autoDispatch: false },
    });
    expect(stopped.ok(), await stopped.text()).toBeTruthy();

    const separator = cookie.indexOf("=");
    await clipDiConsegna({
      nome: "delegated-start-acceptance",
      context: {
        baseURL: E2E_TUNNEL_BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 720 },
      },
      prologo: async (page) => {
        await page.context().addCookies([{
          name: cookie.slice(0, separator),
          value: cookie.slice(separator + 1),
          url: E2E_TUNNEL_BASE,
        }]);
        await page.goto(E2E_TUNNEL_BASE, { waitUntil: "domcontentloaded" });
        await expect(page.getByTestId("guest-start")).toBeVisible({ timeout: 15_000 });
      },
      scena: async (page) => {
        await page.goto(E2E_TUNNEL_BASE, { waitUntil: "domcontentloaded" });
        const start = page.getByTestId("guest-start");
        await expect(start).toBeVisible({ timeout: 15_000 });
        await didascalia(page, "L'ospite può avviare solo sul computer autorizzato");
        await beat(page, 700);

        await start.click();
        await expect(page.getByRole("status")).toContainText(/coda/i);
        await didascalia(page, "Richiesta vuota: modello e computer arrivano dalla policy");
        await beat(page, 700);

        // Keep the guest page mounted: revocation feedback is a live transition,
        // while the owner's loopback page independently verifies the board.
        const ownerPage = await page.context().newPage();
        await ownerPage.goto(E2E_BASE, { waitUntil: "domcontentloaded" });
        await openProjectBoard(ownerPage, new RegExp(projectName));
        const card = ownerPage.locator(`[data-task-card="${taskId}"]`);
        await expect(card).toBeVisible({ timeout: 15_000 });
        await expect(card.getByTestId("card-run-initiator")).toContainText(`Persona ${guestName}`);
        await expect(card.getByTestId("card-run-computer")).toContainText(localMachine!.name);
        await ownerPage.close();

        await didascalia(page, "Il proprietario vede iniziatore e computer distinti");
        await beat(page, 900);

        const revoked = await page.request.delete(
          `${E2E_BASE}/api/auth/agent-start-capabilities?projectId=${encodeURIComponent(projectId)}` +
          `&capabilityId=${encodeURIComponent(capability.capability.id)}`,
        );
        expect(revoked.ok(), await revoked.text()).toBeTruthy();

        await expect(page.getByRole("status")).toContainText(/annull|cancel/i, { timeout: 15_000 });
        await expect(page.getByTestId("guest-start")).toHaveCount(0);
        await didascalia(page, "La revoca annulla la coda e rimuove Avvia");
        await beat(page, 900);
      },
    });

    const ownerTask = await request.get(`${E2E_BASE}/api/boards/${projectId}/tasks/${taskId}`);
    const ownerBody = (await ownerTask.json()) as {
      task: { status: string; machineId: string | null; runInitiatorPersonId?: string | null };
    };
    expect(ownerBody.task).toMatchObject({
      status: "todo",
      machineId: localMachine!.id,
      runInitiatorPersonId: person!.subjectId,
    });
  } finally {
    if (taskId) await deleteTask(request, projectId, taskId).catch(() => {});
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    if (catalogueProjectId) {
      await request.delete(`${E2E_BASE}/api/projects/${catalogueProjectId}`).catch(() => {});
    }
    removeTmpDir(projectPath);
  }
});

test("GUEST-21: an already-open empty node page receives, approves, and revokes a delegated request live", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "GUEST-21" });
  test.setTimeout(90_000);

  const stamp = Date.now();
  const projectName = `e2e-live-node-${stamp}`;
  const projectPath = join(ROOT, projectName);
  let catalogueProjectId: string | null = null;
  let nodeRequestId: string | null = null;
  let claim = '';

  try {
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, "package.json"), JSON.stringify({ name: projectName }));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectPath });
    execFileSync("git", ["remote", "add", "origin", "https://example.test/team/live-node.git"], { cwd: projectPath });
    const registered = await request.post(`${E2E_BASE}/api/projects`, { data: { name: projectName, path: projectPath } });
    expect(registered.ok(), await registered.text()).toBeTruthy();
    catalogueProjectId = ((await registered.json()) as { id: string }).id;

    const devicesResponse = await request.get(`${E2E_BASE}/api/auth/devices`);
    const devices = (await devicesResponse.json()) as { people: Array<{ id: string; name: string; owner: boolean }> };
    const owner = devices.people.find((person) => person.owner);
    expect(owner).toBeTruthy();

    const pairing = await request.post(`${E2E_TUNNEL_BASE}/api/auth/pair/request`, {
      data: { name: `node-owner-${stamp}` },
    });
    expect(pairing.ok(), await pairing.text()).toBeTruthy();
    const pairingBody = await pairing.json() as { requestId: string; claim: string };
    const ownerApproval = await request.post(`${E2E_BASE}/api/auth/pair/approve`, {
      data: { requestId: pairingBody.requestId },
    });
    expect(ownerApproval.ok(), await ownerApproval.text()).toBeTruthy();
    const ownerStatus = await request.get(`${E2E_TUNNEL_BASE}/api/auth/pair/status?requestId=${pairingBody.requestId}&claim=${pairingBody.claim}`);
    const ownerCookie = ownerStatus.headers()['set-cookie']?.split(';', 1)[0] ?? '';
    const ownerCookieSeparator = ownerCookie.indexOf('=');
    expect(ownerCookieSeparator).toBeGreaterThan(0);
    await page.context().addCookies([{
      name: ownerCookie.slice(0, ownerCookieSeparator), value: ownerCookie.slice(ownerCookieSeparator + 1),
      url: E2E_TUNNEL_BASE,
    }]);
    await page.goto(E2E_TUNNEL_BASE, { waitUntil: 'domcontentloaded' });
    await openDevicesSettings(page);
    const surface = page.getByTestId('remote-node-requests');
    await expect(surface.getByTestId('remote-node-request')).toHaveCount(0);

    const opened = await request.post(`${E2E_BASE}/api/nodes/delegated-requests`, {
      data: {
        purpose: 'authorization', capabilityId: `cap-live-${stamp}`,
        repositoryKey: 'example.test/team/live-node', originPersonId: `origin-person-${stamp}`,
        originDeviceId: `origin-device-${stamp}`, originMachineId: `origin-machine-${stamp}`,
        model: 'e2e-coding-model', effort: 'medium', maxDurationMinutes: 15,
      },
    });
    expect(opened.status(), await opened.text()).toBe(201);
    const openedBody = (await opened.json()) as { requestId: string; claim: string };
    nodeRequestId = openedBody.requestId;
    claim = openedBody.claim;

    // This is the regression boundary: no navigation or reload follows the
    // POST. The open page learns about it only through the real WS broadcast.
    const pending = surface.getByTestId('remote-node-request');
    await expect(pending).toBeVisible({ timeout: 10_000 });
    await pending.getByRole('combobox', { name: 'Checkout locale' }).click();
    await page.getByRole('option', { name: new RegExp(projectName) }).click();
    await pending.getByRole('combobox', { name: 'Identità locale' }).click();
    await page.getByRole('option', { name: new RegExp(owner!.name) }).click();
    await pending.getByRole('button', { name: 'Approva sul computer' }).click();

    const authorization = surface.getByTestId('remote-node-authorization');
    await expect(authorization).toContainText('example.test/team/live-node');
    await expect(authorization).toContainText('15 min');
    await expect(authorization.locator('p').first()).toHaveAttribute('title', /Un altro computer.*example\.test\/team\/live-node/);
    await expect(authorization.locator('p').nth(1)).toHaveAttribute('title', /15 min.*attivazione/i);
    await expect(surface.getByTestId('remote-node-request')).toHaveCount(0);

    const claimed = await request.get(`${E2E_BASE}/api/nodes/delegated-requests/${nodeRequestId}/claim?claim=${encodeURIComponent(claim)}`);
    expect(claimed.ok(), await claimed.text()).toBeTruthy();
    const delegatedCookie = claimed.headers()['set-cookie']?.split(';', 1)[0] ?? '';
    expect(delegatedCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    const activated = await request.post(`${E2E_BASE}/api/nodes/delegated-requests/${nodeRequestId}/ack?claim=${encodeURIComponent(claim)}`);
    expect(activated.ok(), await activated.text()).toBeTruthy();
    await expect(authorization).toBeVisible();
    await expect(authorization.locator('p').nth(1)).toHaveAttribute('title', /15 min.*scade/);

    const delegatedHeaders = {
      cookie: delegatedCookie,
      'x-topics-delegated-capability': `cap-live-${stamp}`,
    };
    const created = await request.post(`${E2E_TUNNEL_BASE}/api/nodes/delegated-runs`, {
      headers: delegatedHeaders,
      data: {
        originTaskId: `origin-live-${stamp}`,
        originUrl: 'https://example.test/team/live-node.git',
        text: 'confined remote run',
        description: '',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { runId } = await created.json() as { runId: string };

    for (const [method, path, data] of [
      ['GET', '/api/auth/devices', undefined],
      ['GET', '/api/projects', undefined],
      ['POST', '/api/nodes/runs', { originTaskId: 'legacy', originUrl: 'https://example.test/team/live-node.git', text: 'legacy' }],
      ['POST', `/api/tasks/${runId}/run`, undefined],
    ] as const) {
      const denied = await request.fetch(`${E2E_TUNNEL_BASE}${path}`, {
        method,
        headers: delegatedHeaders,
        ...(data ? { data } : {}),
      });
      expect(denied.status(), `${method} ${path}`).toBe(403);
      expect((await denied.json()).code, `${method} ${path} uses the global delegated scope`).toBe('delegated_scope');
    }

    await authorization.getByRole('button', { name: 'Revoca' }).click();
    await expect(surface.getByTestId('remote-node-authorization')).toHaveCount(0);
    const finalState = await request.get(`${E2E_BASE}/api/nodes/delegated-requests`);
    const body = (await finalState.json()) as { requests: Array<{ id: string; state: string }> };
    expect(body.requests.find((row) => row.id === nodeRequestId)?.state).toBe('revoked');
  } finally {
    if (nodeRequestId) {
      await request.delete(`${E2E_BASE}/api/nodes/delegated-requests/${nodeRequestId}?claim=${encodeURIComponent(claim)}`).catch(() => {});
    }
    if (catalogueProjectId) await request.delete(`${E2E_BASE}/api/projects/${catalogueProjectId}`).catch(() => {});
    removeTmpDir(projectPath);
  }
});
