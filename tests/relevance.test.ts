import assert from "node:assert/strict";
import test from "node:test";
import { LIMITS, MODELS } from "../src/config";
import type { Env } from "../src/contracts";
import { selectRelevant } from "../src/services/relevance";
import type { Candidate } from "../src/services/types";

function candidates(count: number): Candidate[] {
  return Array.from({ length: count }, (_, index) => ({
    articleId: `article-${index}`,
    text: `候選文章 ${index}`,
    searchScore: null,
  }));
}

function inputCandidates(input: Parameters<NonNullable<Env["AI"]>["run"]>[1]) {
  const content = input.messages.find((message) => message.role === "user")?.content;
  return (JSON.parse(content ?? "{}").candidates ?? []) as Array<{ articleId: string; text: string }>;
}

test("相關性初篩每五筆分批並行，成功結果仍套用全域選取上限", async () => {
  let active = 0;
  let peak = 0;
  const batchSizes: number[] = [];
  const env: Env = {
    AI: {
      async run(model, input) {
        assert.equal(model, MODELS.relevance);
        const batch = inputCandidates(input);
        batchSizes.push(batch.length);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          response: JSON.stringify({
            results: batch.map(({ articleId }) => ({
              article_id: articleId,
              relevant: true,
              relevance: 0.9,
            })),
          }),
        };
      },
    },
  };

  const result = await selectRelevant("測試主張", candidates(12), env);

  assert.deepEqual(batchSizes, [5, 5, 2]);
  assert.equal(peak, 3);
  assert.equal(result.hadFailures, false);
  assert.equal(result.selected.length, LIMITS.relevant);
  assert.deepEqual(result.selected.map((item) => item.articleId), [
    "article-0",
    "article-1",
    "article-2",
    "article-3",
    "article-4",
  ]);
});

test("單一相關性批次失敗時只放行該批候選並回報失敗", async () => {
  const env: Env = {
    AI: {
      async run(_model, input) {
        const batch = inputCandidates(input);
        if (batch.some(({ articleId }) => articleId === "article-5")) {
          throw new Error("批次失敗");
        }
        return {
          response: JSON.stringify({
            results: batch.map(({ articleId }) => ({
              article_id: articleId,
              relevant: true,
              relevance: 0.9,
            })),
          }),
        };
      },
    },
  };

  const result = await selectRelevant("測試主張", candidates(12), env);

  assert.equal(result.hadFailures, true);
  assert.deepEqual(result.selected.map((item) => item.articleId), [
    "article-0",
    "article-1",
    "article-2",
    "article-3",
    "article-4",
    "article-5",
    "article-6",
    "article-7",
    "article-8",
    "article-9",
  ]);
  assert.ok(result.selected.slice(0, LIMITS.relevant).every((item) => item.relevanceScore === 0.9));
  assert.ok(result.selected.slice(LIMITS.relevant).every((item) => item.relevanceScore === undefined));
});
