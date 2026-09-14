import assert from "node:assert/strict";
import test from "node:test";
import { LIMITS, MODELS } from "../src/config";
import { factCheck } from "../src/fact-check";
import { normalizeCofactsEvidence } from "../src/services/cofacts";
import { claim, createHarness } from "./helpers";

test("Safeguard 使用 strict JSON schema，相關性使用現行輸出額度", async () => {
  const harness = createHarness();
  const requests: Array<{ model: string; input: Record<string, unknown> }> = [];
  const run = harness.env.AI!.run.bind(harness.env.AI);
  harness.env.AI!.run = async (model, input) => {
    requests.push({ model, input });
    return run(model, input);
  };
  let moderationBody: Record<string, unknown> | undefined;
  const fetcher = async (...args: Parameters<typeof harness.fetcher>) => {
    if (String(args[0]).includes("openrouter.ai")) {
      moderationBody = JSON.parse(String(args[1]?.body));
    }
    return harness.fetcher(...args);
  };
  await factCheck({ text: claim }, harness.env, { fetcher, log: () => undefined });
  assert.equal((moderationBody?.response_format as { type: string }).type, "json_schema");
  assert.equal(((moderationBody?.response_format as { json_schema: { strict: boolean } }).json_schema.strict), true);
  const relevance = requests.find((request) => request.model === MODELS.relevance)!;
  assert.equal(relevance.input.max_tokens, LIMITS.relevanceMaxTokens);
});

test("Cofacts 引文只採人工回覆引用，不把原始文章來源當查核引文", () => {
  const evidence = normalizeCofactsEvidence({
    id: "article-1",
    text: "被查核內容",
    references: [{ type: "URL", permalink: "https://example.org/original" }],
    articleReplies: [{
      positiveFeedbackCount: 2,
      negativeFeedbackCount: 1,
      reply: {
        text: "查核回覆，引用 https://example.org/report",
        type: "RUMOR",
        reference: "參考 https://example.org/report",
        hyperlinks: [],
      },
    }],
    aiReplies: [],
  }, {
    articleId: "article-1",
    text: "候選內容",
    searchScore: 0.02,
    relevanceScore: 0.9,
  });
  assert.deepEqual(evidence[0].articleReferences, ["https://example.org/original"]);
  assert.deepEqual(evidence[0].sourceUrls, ["https://example.org/report"]);
  assert.equal(evidence[0].sourceUrl, "https://example.org/report");
  assert.equal(evidence[0].positiveFeedback, 2);
  assert.equal(evidence[0].negativeFeedback, 1);
});

test("Safeguard 回 allow 但附分類時改判 block，且停止下游", async () => {
  const harness = createHarness();
  let calls = 0;
  const result = await factCheck({ text: claim }, harness.env, {
    log: () => undefined,
    fetcher: async (input, init) => {
      calls += 1;
      if (String(input).includes("openrouter.ai")) {
        return Response.json({ choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify({ decision: "allow", categories: ["hate"], reason: "含分類。" }) },
        }] });
      }
      return harness.fetcher(input, init);
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.moderation.decision, "block");
  assert.equal(calls, 1);
});

async function urlOnly(url: string) {
  const modelPayloads: Array<Record<string, unknown>> = [];
  const env = {
    OPENROUTER_API_KEY: "test-key",
    AI: {
      async run(model: string, input: { messages: Array<{ content: string }> }) {
        assert.equal(model, MODELS.synthesis);
        modelPayloads.push(JSON.parse(input.messages[1].content));
        return { response: JSON.stringify({
          factuality: 0.7,
          confidence: 0.8,
          verdict: "mostly_supported",
          feedback: "測試結果。",
        }) };
      },
    },
  };
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(input));
    if (target.hostname === "openrouter.ai") {
      return Response.json({ choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({ decision: "allow", categories: [], reason: "可查核。" }) },
      }] });
    }
    if (target.hostname === "api.cofacts.tw") {
      return Response.json({ data: { ListArticles: { edges: [] } } });
    }
    if (target.hostname === "cloudflare-dns.com") {
      return Response.json({ Status: 0, Answer: target.searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.215.14" }] : [] });
    }
    assert.equal(init?.redirect, "manual");
    return new Response("使用者提供的網址內容。", { headers: { "Content-Type": "text/plain" } });
  };
  return {
    result: await factCheck({ text: claim, url }, env, { fetcher, log: () => undefined }),
    payload: modelPayloads[0],
  };
}

test("一般網址不可單獨當證據；白名單機構網址可作參考證據", async () => {
  const ordinary = await urlOnly("https://example.org/report");
  assert.equal(ordinary.result.meta.url_context_used, true);
  assert.equal(ordinary.result.meta.no_relevant_evidence, true);
  assert.equal(ordinary.result.confidence, 0.5);
  assert.deepEqual(ordinary.payload.evidence, []);

  const institution = await urlOnly("https://agency.gov.tw/report");
  assert.equal(institution.result.meta.url_context_allowlisted, true);
  assert.equal(institution.result.meta.no_relevant_evidence, false);
  assert.equal(institution.result.confidence, 0.8);
  assert.equal((institution.payload.evidence as unknown[]).length, 1);
});
