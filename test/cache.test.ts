import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../src/cache";
import { tokenCacheKey } from "../src/opensubtitles/client";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a failure can be kept for less time than a success", async () => {
  const cache = new TtlCache<string | null>(60_000);
  const lifetime = (value: string | null) => (value === null ? 5 : 60_000);
  let calls = 0;

  const miss = async () => {
    calls++;
    return null;
  };
  assert.equal(await cache.wrap("missing", miss, lifetime), null);
  await sleep(20);
  // The failure has expired, so the lookup runs again.
  assert.equal(await cache.wrap("missing", miss, lifetime), null);
  assert.equal(calls, 2);

  const find = async () => {
    calls++;
    return "found";
  };
  assert.equal(await cache.wrap("present", find, lifetime), "found");
  await sleep(20);
  assert.equal(await cache.wrap("present", find, lifetime), "found");
  assert.equal(calls, 3);
});

test("a cached login is only reused with the same password", () => {
  const right = tokenCacheKey("api", "someone", "right-password");
  assert.equal(tokenCacheKey("api", "someone", "right-password"), right);
  assert.notEqual(tokenCacheKey("api", "someone", "wrong-password"), right);
  assert.notEqual(tokenCacheKey("other-api", "someone", "right-password"), right);
  // The password itself never ends up in the key.
  assert.ok(!right.includes("right-password"));
});
