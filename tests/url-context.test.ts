import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/errors";
import { fetchUrlContext } from "../src/url-context";

test("URL context 在 DNS 解析到私有位址時停止抓取", async () => {
  let requestedTarget = false;
  await assert.rejects(
    fetchUrlContext("https://example.org/article", async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "cloudflare-dns.com") return Response.json({ Status: 0, Answer: [{ type: 1, data: "127.0.0.1" }] });
      requestedTarget = true;
      return new Response("不應被抓取");
    }),
    (error: unknown) => error instanceof ApiError && error.stage === "url",
  );
  assert.equal(requestedTarget, false);
});

test("DNS 回應中的 CNAME 不會被當成 IP 而拒絕合法目標", async () => {
  let targetRequests = 0;
  const context = await fetchUrlContext("https://example.org/article", async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "cloudflare-dns.com") {
      return Response.json({
        Status: 0,
        Answer: [
          { type: 5, data: "edge.example.net" },
          { type: 1, data: "93.184.216.34" },
        ],
      });
    }
    targetRequests += 1;
    return new Response("可供查核的公開內容。", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  });

  assert.equal(targetRequests, 1);
  assert.equal(context.evidenceText, "可供查核的公開內容。");
});
