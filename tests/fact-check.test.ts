import assert from "node:assert/strict";
import test from "node:test";
import { factCheck } from "../src/fact-check";
import { getCofactsEvidence } from "../src/services/cofacts";
import { claim, createHarness } from "./helpers";

test("完整 Cofacts 與模型回應產生 completed 結果", async () => {
  const { env, fetcher } = createHarness();
  const result = await factCheck({ text: claim }, env, fetcher);
  assert.equal(result.status, "completed");
  assert.equal(result.meta.cofacts_candidates, 1);
  assert.equal(result.meta.cofacts_relevant, 1);
  assert.equal(result.related_checks[0].relevance_score, 0.9);
});

test("相關性模型輸出不完整時保留候選並標記 partial", async () => {
  const { env, fetcher } = createHarness({ invalidRelevance: true });
  const result = await factCheck({ text: claim }, env, fetcher);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.meta.warnings, [{ stage: "relevance", code: "UPSTREAM_UNAVAILABLE" }]);
  assert.equal(result.related_checks[0].relevance_score, undefined);
});

test("Cofacts 詳細資料格式錯誤時保留其他流程並限制常識判斷信心值", async () => {
  const { env, fetcher } = createHarness({ malformedEvidence: true });
  const result = await factCheck({ text: claim }, env, fetcher);
  assert.equal(result.status, "partial");
  assert.equal(result.meta.warnings[0].stage, "cofacts-evidence");
  assert.equal(result.meta.no_relevant_evidence, true);
  assert.equal(result.confidence, 0.5);
});

test("綜整模型違反輸出契約時回傳 synthesis 上游錯誤", async () => {
  const { env, fetcher } = createHarness({ invalidSynthesis: true });
  await assert.rejects(
    factCheck({ text: claim }, env, fetcher),
    (error: unknown) => error instanceof Error && "stage" in error && error.stage === "synthesis",
  );
});

test("Cofacts 詳情請求的併發數受限於五筆", async () => {
  let activeRequests = 0;
  let peakRequests = 0;
  const candidates = Array.from({ length: 15 }, (_, index) => ({
    articleId: `article-${index}`,
    text: `候選文章 ${index}`,
    searchScore: null,
  }));

  const result = await getCofactsEvidence(candidates, async (_input, init) => {
    activeRequests += 1;
    peakRequests = Math.max(peakRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeRequests -= 1;
    const { id } = JSON.parse(String(init?.body)).variables as { id: string };
    return Response.json({
      data: { GetArticle: { id, text: "", articleReplies: [], aiReplies: [] } },
    });
  });

  assert.equal(peakRequests, 5);
  assert.deepEqual(result.failedArticleIds, []);
});
