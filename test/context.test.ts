import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import { baseUrl, runWithRequest } from "../src/context";

/** Just enough of an Express request for the origin to be read from it. */
function requestTo(host: string): Request {
  return {
    headers: { host },
    protocol: "http",
    get: (name: string) => (name.toLowerCase() === "host" ? host : undefined),
  } as unknown as Request;
}

function withBaseUrl<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.BASE_URL;
  if (value === undefined) delete process.env.BASE_URL;
  else process.env.BASE_URL = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = saved;
  }
}

test("links follow the address the client connected to when BASE_URL is unset", () => {
  withBaseUrl(undefined, () => {
    assert.equal(runWithRequest(requestTo("192.168.1.16:7000"), baseUrl), "http://192.168.1.16:7000");
  });
});

test("a loopback BASE_URL does not send another device back to itself", () => {
  withBaseUrl("http://127.0.0.1:7000", () => {
    // A TV on the local network gets links to the address it used.
    assert.equal(runWithRequest(requestTo("192.168.1.16:7000"), baseUrl), "http://192.168.1.16:7000");
    // The machine running the addon still gets the configured value.
    assert.equal(runWithRequest(requestTo("127.0.0.1:7000"), baseUrl), "http://127.0.0.1:7000");
    assert.equal(runWithRequest(requestTo("localhost:7000"), baseUrl), "http://127.0.0.1:7000");
  });
});

test("a BASE_URL that is not loopback always wins, as behind a proxy", () => {
  withBaseUrl("https://subs.example.com/", () => {
    assert.equal(runWithRequest(requestTo("10.0.0.5:7000"), baseUrl), "https://subs.example.com");
  });
});
