import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index";
import { LIMITS } from "../src/config";
import { ApiError, internalError, invalidInput, payloadTooLarge, upstreamUnavailable } from "../src/errors";

test("API error factories 固定對應安全的代碼與 HTTP 狀態", () => {
  assert.deepEqual(
    [invalidInput(), payloadTooLarge(), upstreamUnavailable("synthesis"), internalError()].map((error) => [error.code, error.status]),
    [
      ["INVALID_INPUT", 400],
      ["PAYLOAD_TOO_LARGE", 413],
      ["UPSTREAM_UNAVAILABLE", 502],
      ["INTERNAL_ERROR", 500],
    ],
  );
});

test("API error 保留原因供安全的伺服端診斷，且維持統一類別", () => {
  const cause = new Error("upstream timeout");
  const error = upstreamUnavailable("url", cause);

  assert.ok(error instanceof ApiError);
  assert.equal(error.name, "ApiError");
  assert.equal(error.cause, cause);
  assert.equal(error.stage, "url");
});

test("未提供 Content-Length 的超大請求本文仍回傳 413", async () => {
  const request = new Request("https://example.test/fact-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "測".repeat(LIMITS.requestBytes) }),
  });
  assert.equal(request.headers.get("content-length"), null);

  const response = await worker.fetch(request, {});
  const body = await response.json() as { error: string };

  assert.equal(response.status, 413);
  assert.equal(body.error, "PAYLOAD_TOO_LARGE");
});
