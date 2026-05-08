import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import {
  saveStorageState,
  loadStorageState,
  deleteStorageState,
  debouncedSaver,
  type BrowserStorageState,
} from "./browser-state-store";

const TEST_TOPIC = "test-topic-30-01";
// Resolve BASE_DIR the same way browser-state-store does — honors DATA_DIR
// env var so unit tests pass whether or not DATA_DIR is set by the harness.
const BASE_DIR = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, "browser-state")
  : join(process.cwd(), "data", "browser-state");
const TEST_DIR = join(BASE_DIR, TEST_TOPIC);

const FIXTURE_STATE: BrowserStorageState = {
  cookies: [
    { name: "session", value: "abc123", domain: ".example.com", path: "/",
      expires: Date.now() / 1000 + 3600, httpOnly: true, secure: true, sameSite: "Lax" },
  ],
  origins: [
    { origin: "https://example.com", localStorage: [{ name: "key", value: "val" }] },
  ],
};

beforeEach(() => {
  // Clean any leftover test data.
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

test("saveStorageState writes JSON atomically", async () => {
  await saveStorageState(TEST_TOPIC, FIXTURE_STATE);
  const file = join(TEST_DIR, "storage.json");
  expect(existsSync(file)).toBe(true);
  const parsed = JSON.parse(readFileSync(file, "utf-8"));
  expect(parsed.cookies[0].name).toBe("session");
  expect(parsed.origins[0].origin).toBe("https://example.com");
});

test("loadStorageState returns null when topic has no saved state", async () => {
  const result = await loadStorageState(TEST_TOPIC);
  expect(result).toBeNull();
});

test("loadStorageState round-trips saved state", async () => {
  await saveStorageState(TEST_TOPIC, FIXTURE_STATE);
  const loaded = await loadStorageState(TEST_TOPIC);
  expect(loaded).not.toBeNull();
  expect(loaded!.cookies[0].value).toBe("abc123");
  expect(loaded!.origins[0].localStorage[0].name).toBe("key");
});

test("round-trips session cookie with expires=-1", async () => {
  // Playwright represents session cookies (no Max-Age, no Expires) with
  // expires === -1. Round-trip must preserve the sentinel value verbatim.
  const sessionState: BrowserStorageState = {
    cookies: [
      { name: "PHPSESSID", value: "xyz", domain: ".example.com", path: "/",
        expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
    ],
    origins: [],
  };
  await saveStorageState(TEST_TOPIC, sessionState);
  const loaded = await loadStorageState(TEST_TOPIC);
  expect(loaded).not.toBeNull();
  expect(loaded!.cookies[0].expires).toBe(-1);
  expect(loaded!.cookies[0].name).toBe("PHPSESSID");
});

test("deleteStorageState removes file and empty parent dir", async () => {
  await saveStorageState(TEST_TOPIC, FIXTURE_STATE);
  expect(existsSync(TEST_DIR)).toBe(true);
  await deleteStorageState(TEST_TOPIC);
  expect(existsSync(TEST_DIR)).toBe(false);
});

test("deleteStorageState is idempotent on missing topic", async () => {
  await deleteStorageState(TEST_TOPIC);
  await deleteStorageState(TEST_TOPIC);  // second call must not throw
  expect(existsSync(TEST_DIR)).toBe(false);
});

test("topicId with unsafe chars is sanitized", async () => {
  const unsafe = "../../etc/passwd";
  await saveStorageState(unsafe, FIXTURE_STATE);
  // Sanitized to "______etc_passwd" — file lands inside <BASE_DIR>/, NOT /etc/.
  const sanitizedDir = join(BASE_DIR, "______etc_passwd");
  expect(existsSync(join(sanitizedDir, "storage.json"))).toBe(true);
  if (existsSync(sanitizedDir)) rmSync(sanitizedDir, { recursive: true, force: true });
});

test("debouncedSaver coalesces rapid triggers into single save", async () => {
  let saveCount = 0;
  const saver = debouncedSaver(TEST_TOPIC, async () => {
    saveCount++;
    return FIXTURE_STATE;
  }, 50);
  saver.trigger();
  saver.trigger();
  saver.trigger();
  expect(saveCount).toBe(0);  // not yet flushed
  await new Promise(r => setTimeout(r, 100));
  expect(saveCount).toBe(1);  // coalesced to a single save
});

test("debouncedSaver.flush() saves immediately", async () => {
  let saveCount = 0;
  const saver = debouncedSaver(TEST_TOPIC, async () => {
    saveCount++;
    return FIXTURE_STATE;
  }, 5000);
  saver.trigger();
  expect(saveCount).toBe(0);
  await saver.flush();
  expect(saveCount).toBe(1);
});

test("debouncedSaver.cancel() prevents save", async () => {
  let saveCount = 0;
  const saver = debouncedSaver(TEST_TOPIC, async () => {
    saveCount++;
    return FIXTURE_STATE;
  }, 50);
  saver.trigger();
  saver.cancel();
  await new Promise(r => setTimeout(r, 100));
  expect(saveCount).toBe(0);
});
