import type { Env } from "../src/contracts";
import { MODELS } from "../src/config";
import type { Fetcher } from "../src/http";

export const claim = "測試主張：國中小自學生缺乏普遍補助。";

type HarnessOptions = {
  invalidRelevance?: boolean;
  malformedEvidence?: boolean;
  invalidSynthesis?: boolean;
};

function modelResponse(value: unknown) {
  return { response: JSON.stringify(value) };
}

export function createHarness(options: HarnessOptions = {}) {
  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "openrouter.ai") {
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ decision: "allow", categories: [], reason: "可進行查核。" }) },
          },
        ],
      });
    }
    if (url.hostname !== "api.cofacts.tw") throw new Error(`未預期的網址：${url}`);
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes("ListArticles")) {
      return Response.json({
        data: {
          ListArticles: {
            edges: [{ score: 1, node: { id: "article-1", text: "國中小自學補助的相關查核文章。" } }],
          },
        },
      });
    }
    return Response.json({
      data: {
        GetArticle: options.malformedEvidence
          ? null
          : {
              id: "article-1",
              text: "被查核的原始文章。",
              references: [],
              articleReplies: [
                {
                  positiveFeedbackCount: 1,
                  negativeFeedbackCount: 0,
                  reply: {
                    type: "NOT_RUMOR",
                    text: "人工查核回覆。",
                    reference: "https://example.org/reference",
                    hyperlinks: [{ normalizedUrl: "https://example.org/reference" }],
                  },
                },
              ],
              aiReplies: [],
            },
      },
    });
  };
  const env: Env = {
    OPENROUTER_API_KEY: "test-key",
    AI: {
      async run(model) {
        if (model === MODELS.relevance) {
          return modelResponse(
            options.invalidRelevance
              ? { results: [] }
              : { results: [{ article_id: "article-1", relevant: true, relevance: 0.9, reason: "直接相關。" }] },
          );
        }
        if (model === MODELS.synthesis) {
          return modelResponse(
            options.invalidSynthesis
              ? { factuality: 2, confidence: 0.8, verdict: "supported", feedback: "無效分數" }
              : { factuality: 0.8, confidence: 0.7, verdict: "mostly_supported", feedback: "證據大致支持主張。" },
          );
        }
        throw new Error(`未預期的模型：${model}`);
      },
    },
  };
  return { env, fetcher };
}
