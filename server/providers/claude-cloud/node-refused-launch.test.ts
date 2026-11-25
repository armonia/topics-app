/**
 * @covers KANBAN-76
 * A cloud launch the account cannot run is an answer about that account and repository, not a silent node.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CloudApi, setCloudApiBase, type FetchLike } from "./api";
import { createCloudNodeClient } from "./node";

beforeAll(() => setCloudApiBase("http://fake.test"));
afterAll(() => setCloudApiBase(null));

const ORIGIN = "https://github.com/o/r";
const OTHER = "https://github.com/o/other";
const body = (originUrl: string) => ({ originTaskId: "abcdef1234567890", text: "t", description: "", model: "claude-code:sonnet", effort: "low", originUrl, baseBranch: "main" });

/** A cloud whose session launch answers `launch` and whose environments answer `env`. */
function setup(opts: { launch?: () => Response; env?: (accountId: string) => Response; account?: { id: string } } = {}) {
  const account = opts.account ?? { id: "acc-1" };
  const f: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (path === "/v1/environment_providers") return (opts.env?.(account.id) || undefined) ?? new Response(JSON.stringify({ environments: [{ environment_id: "e", kind: "anthropic_cloud", state: "active" }] }));
    if (path === "/v1/sessions" && init?.method === "POST") return opts.launch?.() ?? new Response(JSON.stringify({ id: "s1" }));
    return new Response("?", { status: 404 });
  };
  const api = new CloudApi(async () => ({ accessToken: "t", orgUuid: "o", accountId: account.id }), f);
  const notices: Array<{ key: string; title: string; body: string }> = [];
  let clock = 1_000_000;
  const node = createCloudNodeClient({ api, repoPathOfTask: () => null, notify: (n) => notices.push(n), now: () => clock });
  return { node, notices, account, tick: (ms: number) => { clock += ms; } };
}
const repoRefusal = () => new Response("GitHub repository access check failed for o/r", { status: 400 });

describe("cloud refuses a launch", () => {
  test("repository access 400: reason cloud_repo with words for a person, that repository excluded and another not", async () => {
    const t = setup({ launch: repoRefusal });
    const err = await t.node.createRun({ body: body(ORIGIN) }).catch((e) => e);
    expect(err.reason).toBe("cloud_repo");
    expect(err.message).toContain("L'app GitHub di Claude non ha accesso al repository o/r");
    expect(err.message).not.toContain("non risponde");
    console.log("TESTO CARD:", err.message);
    expect(t.node.repoRefused("o/r")).toBe(true);
    expect(t.node.repoRefused("o/other")).toBe(false);
    // The account itself is fine: the cloud stays chosen for other repositories.
    expect(t.node.environmentReady()?.ok ?? true).toBe(true);
  });

  test("the refusal is per account: another account makes the old answer void", async () => {
    const t = setup({ launch: repoRefusal });
    await t.node.createRun({ body: body(ORIGIN) }).catch(() => {});
    expect(t.node.repoRefused("o/r")).toBe(true);
    t.account.id = "acc-2";
    t.tick(120_000);
    await t.node.probeEnvironment(0);
    expect(t.node.repoRefused("o/r")).toBe(false);
  });

  test("the refusal expires", async () => {
    const t = setup({ launch: repoRefusal });
    await t.node.createRun({ body: body(ORIGIN) }).catch(() => {});
    t.tick(7 * 3_600_000);
    expect(t.node.repoRefused("o/r")).toBe(false);
  });

  test("403 on the account: cloud out of the choice, reason cloud_account, until the same account proves otherwise", async () => {
    const t = setup({ env: (id) => (id === "acc-1" ? new Response("no", { status: 403 }) : undefined as never) });
    const err = await t.node.createRun({ body: body(OTHER) }).catch((e) => e);
    expect(err.reason).toBe("cloud_account");
    expect(t.node.environmentReady()?.ok).toBe(false);
    // Same account, asked again: still refused.
    await t.node.probeEnvironment(0);
    expect(t.node.environmentReady()?.ok).toBe(false);
    // A different account voids the answer.
    t.account.id = "acc-2";
    t.tick(120_000);
    await t.node.probeEnvironment(60_000 * 1000);
    // The account changed: the old answer is void and the new account's own proof is read.
    expect(t.node.environmentReady()?.ok).toBe(true);
  });

  test("one notice per cause across two rounds", async () => {
    const t = setup({ launch: repoRefusal });
    await t.node.createRun({ body: body(ORIGIN) }).catch(() => {});
    await t.node.createRun({ body: body(ORIGIN) }).catch(() => {});
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]!.body).toContain("o/r");
    const u = setup({ env: () => new Response("no", { status: 401 }) });
    await u.node.createRun({ body: body(ORIGIN) }).catch(() => {});
    await u.node.createRun({ body: body(ORIGIN) }).catch(() => {});
    await u.node.probeEnvironment(0);
    expect(u.notices).toHaveLength(1);
  });
});
