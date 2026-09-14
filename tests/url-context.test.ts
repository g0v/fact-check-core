import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/errors";
import { fetchUrlContext } from "../src/url-context";

test("URL context 在 DNS 解析到私有位址時停止抓取", async () => {
  let requestedTarget = false;
  await assert.rejects(
    fetchUrlContext("https://example.org/article", async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "cloudflare-dns.com") return Response.json({ Status: 0, Answer: [{ data: "127.0.0.1" }] });
      requestedTarget = true;
      return new Response("不應被抓取");
    }),
    (error: unknown) => error instanceof ApiError && error.stage === "url",
  );
  assert.equal(requestedTarget, false);
});
