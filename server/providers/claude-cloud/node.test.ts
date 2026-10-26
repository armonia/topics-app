import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudApi, setCloudApiBase, type CloudEvent, type FetchLike } from "./api";
import { cloudModelFor, createCloudNodeClient, githubSlug, type GitRun } from "./node";
import { createNodeBranchPlanter } from "../../services/node-branch-plant";

const sh = (args: string[], cwd?: string) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

let root: string, origin: string, checkout: string, cloudWork: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cloud-node-"));
  origin = join(root, "origin.git");
  checkout = join(root, "checkout");
  cloudWork = join(root, "cloud");
  sh(["init", "--bare", "-q", "-b", "main", origin]);
  sh(["clone", "-q", origin, checkout]);
  writeFileSync(join(checkout, "a.txt"), "uno\n");
  sh(["add", "."], checkout);
  sh(["commit", "-q", "-m", "base"], checkout);
  sh(["push", "-q", "origin", "main"], checkout);
  setCloudApiBase("http://fake.test");
});
afterAll(() => { setCloudApiBase(null); rmSync(root, { recursive: true, force: true }); });

/** Il finto cloud: crea la sessione, e quando il test lo dice «lavora» spingendo un ramo su origin. */
function fakeCloud() {
  const events: CloudEvent[] = [];
  let created: { session_context: { outcomes: Array<{ git_info: { branches: string[] } }>; model: string } } | null = null;
  const creates: string[] = [];
  const posts: string[] = [];
  const f: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (path === "/v1/environment_providers") return json({ environments: [{ environment_id: "env_x", kind: "anthropic_cloud", state: "active" }] });
    if (path === "/v1/sessions" && init?.method === "POST") { created = JSON.parse(String(init.body)); creates.push("session_n"); return json({ id: "session_n" }); }
    if (init?.method === "POST") posts.push(path);
    if (path === "/v1/sessions/session_n/archive") return json({});
    if (path.startsWith("/v1/sessions/session_n/events")) {
      if (init?.method === "POST") return json({});
      const after = new URL("http://x" + path).searchParams.get("after_id");
      const i = after ? events.findIndex((e) => e.uuid === after) + 1 : 0;
      const data = events.slice(i);
      return json({ data, has_more: false, ...(data.length ? { last_id: data.at(-1)!.uuid } : {}) });
    }
    return new Response("?", { status: 404 });
  };
  return {
    api: new CloudApi(async () => ({ accessToken: "t", orgUuid: "o" }), f),
    events,
    creates,
    posts,
    branch: () => created!.session_context.outcomes[0].git_info.branches[0],
    model: () => created!.session_context.model,
    work() {
      rmSync(cloudWork, { recursive: true, force: true });
      sh(["clone", "-q", origin, cloudWork]);
      sh(["switch", "-q", "-c", this.branch()], cloudWork);
      writeFileSync(join(cloudWork, "b.txt"), "fatto nel cloud\n");
      sh(["add", "."], cloudWork);
      sh(["commit", "-q", "-m", "lavoro cloud"], cloudWork);
      sh(["push", "-q", "origin", this.branch()], cloudWork);
      return sh(["rev-parse", "HEAD"], cloudWork);
    },
  };
}

const body = { originTaskId: "abcdef1234567890", text: "Aggiungi b.txt", description: "", model: "claude-code:sonnet", effort: "low" };

describe("nodo cloud", () => {
  test("card → sessione → ramo su origin → bundle piantato nel checkout", async () => {
    const cloud = fakeCloud();
    const node = createCloudNodeClient({ api: cloud.api, repoPathOfTask: () => checkout });
    const { runId } = await node.createRun({ body: { ...body, originUrl: origin } });
    expect(runId).toBe("session_n");
    expect(cloud.branch()).toMatch(/^claude\/card-abcdef12-/);
    expect(cloud.model()).toBe("claude-sonnet-5-5");

    // Il primo rapporto resta vuoto: la corsia lo usa per adescare i commenti.
    const r0 = await node.readRun({ runId });
    expect(r0.status).toBe("in_progress");
    expect(r0.comments).toEqual([]);

    const tip = cloud.work();
    cloud.events.push({ type: "result", subtype: "success", uuid: "r1", result: "Aggiunto b.txt, verificato con cat." });
    const r1 = await node.readRun({ runId });
    expect(r1.status).toBe("review");
    expect(r1.deliveryBranch).toBe(cloud.branch());
    expect(r1.deliveryCommit).toBe(tip);
    expect(r1.comments[0]).toMatchObject({ id: "r1", author: "agent", kind: "delivery" });
    expect(r1.comments[0].content).toContain("https://claude.ai/code/session_n");

    const bundle = await node.fetchBundle({ runId });
    expect(bundle.empty).toBe(false);
    const planter = createNodeBranchPlanter({ repoPathOf: () => checkout });
    const planted = await planter.plantBranch({
      projectId: "p", branch: r1.deliveryBranch!, baseSha: r1.baseSha, bundle: bundle.empty ? null : bundle.bytes,
    });
    expect(planted).toMatchObject({ planted: true, commit: tip });
    expect(sh(["show", `${r1.deliveryBranch}:b.txt`], checkout)).toBe("fatto nel cloud");
  });

  test("sessione in errore anche dopo aver spinto: review senza ramo, col motivo", async () => {
    const cloud = fakeCloud();
    const node = createCloudNodeClient({ api: cloud.api, repoPathOfTask: () => checkout });
    const { runId } = await node.createRun({ body: { ...body, originUrl: origin } });
    await node.readRun({ runId });
    cloud.work();
    cloud.events.push({ type: "result", subtype: "error_during_execution", uuid: "r9" });
    const r = await node.readRun({ runId });
    expect(r.status).toBe("review");
    expect(r.deliveryBranch).toBeNull();
    expect(r.dispatchState).toBe("needs_input");
    expect(r.dispatchError).toBe("cloud_session_failed");
    expect(r.reason).toContain("errore");
  });

  test("checkout indietro rispetto a origin: il ramo si pianta lo stesso", async () => {
    // Qualcuno spinge su main dopo il nostro ultimo fetch: il checkout non ha quel commit.
    const other = join(root, "other");
    sh(["clone", "-q", origin, other]);
    writeFileSync(join(other, "c.txt"), "altrove\n");
    sh(["add", "."], other);
    sh(["commit", "-q", "-m", "avanti"], other);
    sh(["push", "-q", "origin", "main"], other);
    const cloud = fakeCloud();
    const node = createCloudNodeClient({ api: cloud.api, repoPathOfTask: () => checkout });
    const { runId } = await node.createRun({ body: { ...body, originUrl: origin } });
    await node.readRun({ runId });
    const tip = cloud.work();
    cloud.events.push({ type: "result", subtype: "success", uuid: "r2", result: "ok" });
    const r = await node.readRun({ runId });
    expect(r.deliveryBranch).toBe(cloud.branch());
    const bundle = await node.fetchBundle({ runId });
    const planted = await createNodeBranchPlanter({ repoPathOf: () => checkout }).plantBranch({
      projectId: "p", branch: r.deliveryBranch!, baseSha: r.baseSha, bundle: bundle.empty ? null : bundle.bytes,
    });
    expect(planted).toMatchObject({ planted: true, commit: tip });
    expect(sh(["show", `${r.deliveryBranch}:c.txt`], checkout)).toBe("altrove");
  });

  test("dopo un riavvio la stessa card riprende la sessione viva, non ne apre un'altra", async () => {
    const statePath = join(root, "state", "runs.json");
    const cloud = fakeCloud();
    const a = createCloudNodeClient({ api: cloud.api, repoPathOfTask: () => checkout, statePath });
    const first = await a.createRun({ body: { ...body, originUrl: origin } });
    // Il processo riparte: client nuovo, stessa cartella di stato.
    const b = createCloudNodeClient({ api: cloud.api, repoPathOfTask: () => checkout, statePath });
    const again = await b.createRun({ body: { ...body, originUrl: origin } });
    expect(again.runId).toBe(first.runId);
    expect(cloud.creates).toEqual(["session_n"]);
    // Annullata sul serio: la sessione riceve l'interruzione e l'archivio, e non si riprende più.
    await b.cancelRun({ runId: again.runId });
    expect(cloud.posts).toEqual(["/v1/sessions/session_n/events", "/v1/sessions/session_n/archive"]);
    await b.createRun({ body: { ...body, originUrl: origin } });
    expect(cloud.creates).toEqual(["session_n", "session_n"]);
  });

  // Mutazione della barra: la sessione smette di mandare eventi. La card è ferma, mai consegnata.
  test("sessione muta oltre la soglia: review come ferma, senza ramo", async () => {
    const cloud = fakeCloud();
    let t = 1_000;
    const node = createCloudNodeClient({ api: cloud.api, repoPathOfTask: () => checkout, stallMs: 60_000, now: () => t });
    const { runId } = await node.createRun({ body: { ...body, originUrl: origin } });
    await node.readRun({ runId });
    t += 30_000;
    expect((await node.readRun({ runId })).status).toBe("in_progress");
    t += 31_000;
    const r = await node.readRun({ runId });
    expect(r.status).toBe("review");
    expect(r.dispatchState).toBe("needs_input");
    expect(r.dispatchError).toBe("cloud_session_stalled");
    expect(r.deliveryBranch).toBeNull();
  });

  test("permesso in sospeso: la card lo dice, una volta per richiesta", async () => {
    const cloud = fakeCloud();
    const node = createCloudNodeClient({ api: cloud.api, repoPathOfTask: () => checkout });
    const { runId } = await node.createRun({ body: { ...body, originUrl: origin } });
    await node.readRun({ runId });
    cloud.events.push({ type: "control_request", uuid: "c1", request_id: "req_1", request: { tool_name: "Bash" } });
    const r = await node.readRun({ runId });
    expect(r.status).toBe("in_progress");
    expect(r.comments.map((c) => c.id)).toEqual(["ask-req_1"]);
    cloud.events.push({ type: "control_response", uuid: "c2", response: { request_id: "req_1" } });
    expect((await node.readRun({ runId })).comments).toEqual([]);
  });

  test("con l'API vera, un origin non GitHub va in review col motivo, senza sessione", async () => {
    setCloudApiBase(null);
    try {
      const cloud = fakeCloud();
      const node = createCloudNodeClient({ api: cloud.api, repoPathOfTask: () => checkout });
      const { runId } = await node.createRun({ body: { ...body, originUrl: origin } });
      expect(cloud.creates).toEqual([]);
      expect((await node.readRun({ runId })).status).toBe("in_progress");
      const r = await node.readRun({ runId });
      expect(r).toMatchObject({ status: "review", dispatchError: "cloud_refused", deliveryBranch: null });
      expect(r.reason).toContain("solo da GitHub");
    } finally { setCloudApiBase("http://fake.test"); }
  });

  test("su un'API finta il token vero non si chiede nemmeno", async () => {
    let asked = 0;
    const seen: string[] = [];
    const api = new CloudApi(async () => { asked++; return { accessToken: "VERO", orgUuid: "o" }; }, async (url, init) => {
      seen.push(`${url} ${(init?.headers as Record<string, string>).Authorization}`);
      return new Response(JSON.stringify({ environments: [{ environment_id: "e", kind: "anthropic_cloud", state: "active" }] }));
    });
    await api.defaultEnvironmentId();
    expect(asked).toBe(0);
    expect(seen).toEqual(["http://fake.test/v1/environment_providers Bearer e2e-fake"]);
  });

  test("origin muto alla fine: si riprova, non diventa «ramo non spinto»", async () => {
    const cloud = fakeCloud();
    let originDown = false;
    const git: GitRun = async (args, cwd) => {
      if (originDown && args[0] === "ls-remote" && !args.includes("--symref")) return { code: 128, stdout: "", stderr: "unable to access" };
      const r = Bun.spawnSync(["git", ...args], { cwd });
      return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    };
    const node = createCloudNodeClient({ api: cloud.api, repoPathOfTask: () => checkout, git });
    const { runId } = await node.createRun({ body: { ...body, originUrl: origin } });
    await node.readRun({ runId });
    cloud.work();
    cloud.events.push({ type: "result", subtype: "success", uuid: "r5", result: "ok" });
    originDown = true;
    expect((await node.readRun({ runId })).status).toBe("in_progress");
    originDown = false;
    const r = await node.readRun({ runId });
    expect(r.status).toBe("review");
    expect(r.deliveryBranch).toBe(cloud.branch());
  });

  test("interrupt e fine sessione nel flusso non sono domande", async () => {
    const cloud = fakeCloud();
    const node = createCloudNodeClient({ api: cloud.api, repoPathOfTask: () => checkout });
    const { runId } = await node.createRun({ body: { ...body, originUrl: origin } });
    await node.readRun({ runId });
    // Forme copiate da una sessione vera del 26/10.
    cloud.events.push({ type: "control_request", uuid: "x1", request_id: "r-int", request: { subtype: "interrupt", cancel_queued: true } });
    cloud.events.push({ type: "control_request", uuid: "x2", request_id: "r-end", request: { subtype: "end_session", reason: "archived" } });
    cloud.events.push({ type: "control_request", uuid: "x3", request_id: "r-ask", request: { subtype: "can_use_tool", tool_name: "Bash" } });
    expect((await node.readRun({ runId })).comments.map((c) => c.id)).toEqual(["ask-r-ask"]);
  });

  test("una domanda aperta non è uno stallo", async () => {
    const cloud = fakeCloud();
    let t = 1_000;
    const node = createCloudNodeClient({ api: cloud.api, repoPathOfTask: () => checkout, stallMs: 60_000, now: () => t });
    const { runId } = await node.createRun({ body: { ...body, originUrl: origin } });
    await node.readRun({ runId });
    cloud.events.push({ type: "control_request", uuid: "c9", request_id: "req_9", request: { tool_name: "Bash" } });
    await node.readRun({ runId });
    t += 16 * 60_000;
    expect((await node.readRun({ runId })).status).toBe("in_progress");
    expect(cloud.posts).toEqual([]);
  });

  test("una domanda ritirata dalla sessione non tiene la card appesa", async () => {
    const cloud = fakeCloud();
    let t = 1_000;
    const node = createCloudNodeClient({ api: cloud.api, repoPathOfTask: () => checkout, stallMs: 60_000, now: () => t });
    const { runId } = await node.createRun({ body: { ...body, originUrl: origin } });
    await node.readRun({ runId });
    cloud.events.push({ type: "control_request", uuid: "q1", request_id: "req_q", request: { subtype: "can_use_tool", tool_name: "Bash" } });
    cloud.events.push({ type: "control_cancel_request", uuid: "q2", request_id: "req_q" });
    expect((await node.readRun({ runId })).comments).toEqual([]);
    t += 61_000;
    expect((await node.readRun({ runId })).dispatchError).toBe("cloud_session_stalled");
  });

  test("rimandare indietro una card consegnata non archivia la sessione finita", async () => {
    const statePath = join(root, "state2", "runs.json");
    const cloud = fakeCloud();
    const node = createCloudNodeClient({ api: cloud.api, repoPathOfTask: () => checkout, statePath });
    const { runId } = await node.createRun({ body: { ...body, originUrl: origin } });
    await node.readRun({ runId });
    cloud.events.push({ type: "result", subtype: "error_during_execution", uuid: "r7" });
    expect((await node.readRun({ runId })).status).toBe("review");
    await node.cancelRun({ runId });
    expect(cloud.posts).toEqual([]);
  });

  test("nomi", () => {
    expect(githubSlug("git@github.com:armonia/topics-app.git")).toBe("armonia/topics-app");
    expect(githubSlug("https://github.com/armonia/topics-app")).toBe("armonia/topics-app");
    expect(githubSlug("/tmp/x.git")).toBeNull();
    expect(githubSlug("ssh://git@ssh.github.com:443/o/r.git")).toBe("o/r");
    expect(githubSlug("https://notgithub.com/o/r.git")).toBeNull();
    expect(githubSlug("https://github.com.evil.example/o/r.git")).toBeNull();
    expect(githubSlug("/srv/mirrors/github.com/o/r.git")).toBeNull();
    expect(githubSlug("https://github.com-lavoro/o/r")).toBeNull();
    // Un alias è GitHub solo se ssh lo risolve lì: senza config, questi sono domini veri.
    expect(githubSlug("git@github.com-evil.com:o/r.git")).toBeNull();
    expect(githubSlug("ssh://git@github.com-attacker.example/o/r.git")).toBeNull();
    expect(githubSlug("GIT@GITHUB.COM:O/R.GIT")).toBe("O/R");
    expect(githubSlug("github.com:o/r.git")).toBe("o/r");
    expect(githubSlug("git+ssh://git@github.com/o/r.git")).toBe("o/r");
    expect(cloudModelFor("claude-code:opus")).toBe("claude-opus-5-5");
    expect(cloudModelFor("codex:gpt-6")).toBe("claude-opus-5-5");
    expect(cloudModelFor(null)).toBe("claude-opus-5-5");
  });
});
