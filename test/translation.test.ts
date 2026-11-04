import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { translationSettings, normalizeBaseUrl, TranslationError, type TranslationSettings } from "../src/translation/config";
import { translateBatch } from "../src/translation/client";
import { translatedCues } from "../src/translation/service";
import { parseSourceJob, translationUrl } from "../src/translation/source";
import type { Cue } from "../src/subtitles/types";

const cues: Cue[] = [
  { start: 1000, end: 2000, text: "Owned line one." },
  { start: 3000, end: 4500, text: "Owned line two.\nSecond line." },
];
function settings(extra: Partial<TranslationSettings> = {}): TranslationSettings {
  return { ...translationSettings({ aiEnabled: "true", aiBaseUrl: "https://owned.invalid/v1", aiApiKey: randomUUID(), aiModel: "owned-model" }, false)!, ...extra };
}
function completion(value: unknown, finish = "stop"): Response {
  return Response.json({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(value) } }] });
}
function good(transportCount?: () => void): typeof fetch {
  return async (_input, init) => {
    transportCount?.();
    const request = JSON.parse(String(init?.body));
    const input = JSON.parse(request.messages[1].content);
    return completion({ cues: input.cues.map((cue: any) => ({ id: cue.id, text: `Vertaling ${cue.id}` })) });
  };
}
const batch = [{ id: 1, text: "Owned test." }, { id: 2, text: "Another owned test." }];

test("AI is opt-in and URLs forbid secrets, queries and redirects to implicit endpoints", () => {
  assert.equal(translationSettings({}, false), undefined);
  for (const url of ["file:///etc/passwd", "https://user:key@host/v1", "https://host/v1?api_key=secret", "https://host/v1#secret", "https://host/v1/chat/completions", "http://127.0.0.1:11434/v1"]) {
    assert.throws(() => normalizeBaseUrl(url));
  }
  assert.equal(normalizeBaseUrl("https://host/v1/"), "https://host/v1");
});

test("personal endpoints require an exact host allowlist, including explicit local endpoints", () => {
  const previous = process.env.AI_ALLOWED_BASE_URLS;
  const http = process.env.AI_ALLOW_HTTP;
  try {
    process.env.AI_ALLOWED_BASE_URLS = "https://owned.invalid/v1";
    const input = { aiEnabled: "true", aiBaseUrl: "https://owned.invalid/v1/", aiModel: "custom" };
    assert.equal(translationSettings(input, true)?.apiKey, "");
    for (const url of ["https://owned.invalid.evil/v1", "https://owned.invalid/private", "http://169.254.169.254/latest"]) {
      assert.throws(() => translationSettings({ ...input, aiBaseUrl: url }, true));
    }
    process.env.AI_ALLOW_HTTP = "true";
    process.env.AI_ALLOWED_BASE_URLS = "http://bifrost:8080/v1";
    assert.equal(translationSettings({ ...input, aiBaseUrl: "http://bifrost:8080/v1" }, true)?.baseUrl, "http://bifrost:8080/v1");
  } finally {
    if (previous === undefined) delete process.env.AI_ALLOWED_BASE_URLS; else process.env.AI_ALLOWED_BASE_URLS = previous;
    if (http === undefined) delete process.env.AI_ALLOW_HTTP; else process.env.AI_ALLOW_HTTP = http;
  }
});

test("extra headers are bounded and cannot override transport/authentication or spoof proxies", () => {
  const input = { aiEnabled: "true", aiBaseUrl: "https://owned.invalid/v1", aiModel: "custom" };
  assert.deepEqual(translationSettings({ ...input, aiHeaders: '{"X-API-Key":"owned","HTTP-Referer":"https://app.example"}' }, false)?.headers,
    { "x-api-key": "owned", "http-referer": "https://app.example" });
  for (const aiHeaders of ['{"Authorization":"secret"}', '{"Host":"internal"}', '{"Cookie":"a=b"}', '{"X-Forwarded-For":"internal"}', '{"X-Key":"bad\\nheader"}', '[]', 'bad-json']) {
    assert.throws(() => translationSettings({ ...input, aiHeaders }, false));
  }
});

test("minimal Chat Completions request sends text and IDs, never timestamps or tools", async () => {
  const cfg = settings({ headers: { "x-custom": "owned-header" } });
  const response = await translateBatch(batch, "en", "nl", cfg, new AbortController().signal, async (input, init) => {
    assert.equal(String(input), "https://owned.invalid/v1/chat/completions");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${cfg.apiKey}`);
    const value = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(value).sort(), ["max_tokens", "messages", "model", "stream"]);
    assert.equal(value.stream, false);
    assert.deepEqual(JSON.parse(value.messages[1].content), { source_language: "en", target_language: "nl", cues: batch });
    assert.ok(!String(init?.body).includes(cfg.apiKey));
    return completion({ cues: [{ id: 1, text: "Eigen regel." }, { id: 2, text: "Nog een regel." }] });
  });
  assert.deepEqual(response, ["Eigen regel.", "Nog een regel."]);
});

test("capability options are explicit; no model discovery or parameter retry", async () => {
  let calls = 0;
  await translateBatch(batch, "en", "nl", settings({ jsonMode: true, tokenParameter: "max_completion_tokens", apiKey: "" }), new AbortController().signal, async (_input, init) => {
    calls++;
    const value = JSON.parse(String(init?.body));
    assert.equal(value.max_tokens, undefined);
    assert.equal(value.max_completion_tokens, 4096);
    assert.deepEqual(value.response_format, { type: "json_object" });
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return completion({ cues: batch });
  });
  assert.equal(calls, 1);
});

for (const [name, output] of [
  ["missing", { cues: [{ id: 1, text: "one" }] }],
  ["duplicate", { cues: [{ id: 1, text: "one" }, { id: 1, text: "two" }] }],
  ["reordered", { cues: [{ id: 2, text: "two" }, { id: 1, text: "one" }] }],
  ["extra", { cues: [...batch, { id: 3, text: "three" }] }],
  ["timecodes", { cues: [{ id: 1, text: "one", start: 0 }, batch[1]] }],
  ["subtitle injection", { cues: [{ id: 1, text: "00:00:00,000 --> 00:00:01,000" }, batch[1]] }],
  ["blank", { cues: [{ id: 1, text: " " }, batch[1]] }],
] as const) {
  test(`rejects ${name} output without partial acceptance`, async () => {
    await assert.rejects(translateBatch(batch, "en", "nl", settings(), new AbortController().signal, async () => completion(output)), TranslationError);
  });
}
for (const finish of ["length", "content_filter", "tool_calls", null]) {
  test(`rejects incomplete finish_reason=${finish}`, async () => {
    await assert.rejects(translateBatch(batch, "en", "nl", settings(), new AbortController().signal,
      async () => completion({ cues: batch }, finish as string)), /incomplete/);
  });
}

test("invalid JSON and oversized/streamed responses never reach accepted output", async () => {
  const cfg = settings();
  for (const response of [new Response("not-json"), Response.json({ choices: [{ finish_reason: "stop", message: { content: "```json\\n{}\\n```" } }] }),
    new Response("small", { headers: { "Content-Length": String(600000) } })]) {
    await assert.rejects(translateBatch(batch, "en", "nl", cfg, new AbortController().signal, async () => response));
  }
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(600000)); }, cancel() { cancelled = true; } });
  await assert.rejects(translateBatch(batch, "en", "nl", cfg, new AbortController().signal, async () => new Response(stream)), /size limit/);
  assert.equal(cancelled, true);
});

test("provider errors and network/redirect failures cannot expose keys, bodies or URLs", async () => {
  for (const status of [400, 401, 403, 429, 503]) {
    let calls = 0;
    await assert.rejects(translateBatch(batch, "en", "nl", settings(), new AbortController().signal, async () => {
      calls++; return new Response("PRIVATE KEY RESPONSE", { status, headers: { "Retry-After": "123" } });
    }), (error: unknown) => error instanceof TranslationError && !error.message.includes("PRIVATE") &&
      (status !== 429 || error.retryAfterSeconds === 123));
    assert.equal(calls, 1);
  }
  await assert.rejects(translateBatch(batch, "en", "nl", settings(), new AbortController().signal,
    async () => { throw new Error("https://PRIVATE KEY"); }), /^TranslationError: AI request failed or timed out$/);
});

test("translation preserves timing exactly and shares concurrent and repeated work", async () => {
  let calls = 0;
  const cfg = settings();
  const transport = good(() => calls++);
  const [a, b] = await Promise.all([translatedCues(cues, "en", "nl", cfg, transport), translatedCues(cues, "en", "nl", cfg, transport)]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.deepEqual(a.map(({ start, end }) => [start, end]), cues.map(({ start, end }) => [start, end]));
  const retimed = cues.map((cue) => ({ ...cue, start: cue.start + 1000, end: cue.end + 1000 }));
  const reused = await translatedCues(retimed, "en", "nl", cfg, transport);
  assert.equal(reused[0]!.start, retimed[0]!.start);
  assert.equal(calls, 1, "reusable text must not impose old timings");
  assert.deepEqual(cues.map((cue) => cue.text), ["Owned line one.", "Owned line two.\nSecond line."]);
});

test("model, source revision and credentials separate the translation cache", async () => {
  let calls = 0;
  const cfg = settings();
  const transport = good(() => calls++);
  await translatedCues(cues, "en", "nl", cfg, transport);
  await translatedCues(cues, "en", "nl", { ...cfg, model: "different" }, transport);
  await translatedCues(cues, "en", "nl", { ...cfg, apiKey: "different-owned-key" }, transport);
  await translatedCues(cues.map((cue) => ({ ...cue, text: cue.text + " revised" })), "en", "nl", cfg, transport);
  assert.equal(calls, 4);
});

test("bounded batching preserves global IDs and a failed batch caches no completed subtitle", async () => {
  let calls = 0;
  const cfg = settings({ batchCues: 1 });
  await assert.rejects(translatedCues(cues, "en", "nl", cfg, async (_input, init) => {
    calls++;
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    assert.equal(input.cues[0].id, calls);
    return completion({ cues: calls === 1 ? input.cues : [] });
  }), /missing or extra/);
  await assert.rejects(translatedCues(cues, "en", "nl", cfg, good()), /cooling down/);
  assert.equal(calls, 2);
});

test("request timeout is abortable and produces a safe failure", async () => {
  await assert.rejects(translatedCues(cues, "en", "nl", settings({ requestTimeoutMs: 10 }), async (_input, init) => {
    return new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mock did not abort")), 200);
      init!.signal!.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("PRIVATE timeout")); }, { once: true });
    });
  }), /AI request failed or timed out/);
});

test("slow work returns Retry-After while the same bounded job continues for a later fetch", async () => {
  let calls = 0;
  const cfg = settings({ responseWaitMs: 2 });
  const transport: typeof fetch = async (input, init) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return good()(input, init);
  };
  await assert.rejects(translatedCues(cues, "en", "nl", cfg, transport), (error: unknown) => error instanceof TranslationError && error.status === 503 && error.retryAfterSeconds === 5);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((await translatedCues(cues, "en", "nl", cfg, transport))[0]?.text, "Vertaling 1");
  assert.equal(calls, 1);
});

test("source operations cannot be arbitrary URLs, recursive translations or malformed jobs", () => {
  const url = translationUrl("https://addon.example", "_", "https://addon.example/_/s/subdl~owned~file.en/test.srt", "nl", "exact", "test", "srt");
  const token = new URL(url).pathname.split("/")[4]!;
  assert.deepEqual(parseSourceJob(token), { kind: "s", file: { provider: "subdl", fileId: "owned~file", lang: "en" }, timing: "exact" });
  for (const path of ["https://evil.invalid", "t/nl/recursive", "s/../secret", "x/not-an-id/1.en"]) {
    assert.throws(() => parseSourceJob(Buffer.from(JSON.stringify({ path, timing: "exact" })).toString("base64url")));
  }
  assert.throws(() => parseSourceJob("x".repeat(4097)));
});

test("global worker limit rejects extra jobs without making another AI call", async () => {
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const first = translatedCues(cues, "en", "nl", settings({ concurrency: 1 }), async (input, init) => {
    calls++;
    await waiting;
    return good()(input, init);
  });
  try {
    await assert.rejects(translatedCues(cues, "en", "nl", settings({ concurrency: 1 }), good()), /worker is busy/);
  } finally { release!(); }
  await first;
  assert.equal(calls, 1);
});

test("limits reject oversized work and reserve a full job's call budget before spending", async () => {
  let calls = 0;
  const transport = good(() => calls++);
  await assert.rejects(translatedCues(cues, "en", "nl", settings({ maxCues: 1 }), transport), /exceeds AI limits/);
  await assert.rejects(translatedCues(cues, "en", "nl", settings({ batchCharacters: 2 }), transport), /batch limit/);
  await assert.rejects(translatedCues(cues, "en", "nl", settings({ batchCues: 1, hourlyCalls: 1 }), transport), /hourly request limit/);
  assert.equal(calls, 0);
});
