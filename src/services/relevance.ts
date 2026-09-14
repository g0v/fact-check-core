import { LIMITS, MODELS } from "../config";
import type { Env } from "../contracts";
import { withTimeout } from "../http";
import { relevancePrompt } from "../prompts/relevance";
import { parseJsonCompletion } from "./model-output";
import type { Candidate } from "./types";
import { textSchema, v } from "../validation";

const relevanceSchema = v.object({
  results: v.array(v.object({
    article_id: textSchema(200),
    relevant: v.boolean(),
    relevance: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  })),
});

export async function selectRelevant(claim: string, candidates: Candidate[], env: Env): Promise<Candidate[]> {
  if (!candidates.length) return [];
  if (!env.AI) throw new Error("未設定 Workers AI");
  const modelCandidates = candidates.map((item) => ({
    articleId: item.articleId,
    text: item.text.slice(0, LIMITS.candidateText),
  }));
  const output = await withTimeout(
    () =>
      env.AI!.run(MODELS.relevance, {
        messages: [
          { role: "system", content: relevancePrompt },
          { role: "user", content: JSON.stringify({ claim, candidates: modelCandidates }) },
        ],
        stream: false,
        temperature: 0,
        max_tokens: 16_384,
        response_format: { type: "json_object" },
      }),
    LIMITS.modelTimeoutMs,
  );
  const { results } = v.parse(relevanceSchema, parseJsonCompletion(output));
  if (results.length !== candidates.length) {
    throw new Error("初篩結果不完整");
  }
  const byId = new Map(candidates.map((candidate) => [candidate.articleId, candidate]));
  const seen = new Set<string>();
  const selected = results.flatMap((result): Candidate[] => {
    const id = result.article_id;
    if (seen.has(id) || !byId.has(id)) throw new Error("初篩格式不正確");
    seen.add(id);
    return result.relevant && result.relevance >= 0.65
      ? [{ ...byId.get(id)!, relevanceScore: result.relevance }]
      : [];
  });
  if (seen.size !== candidates.length) throw new Error("初篩遺漏文章");
  return selected.sort((a, b) => b.relevanceScore! - a.relevanceScore!).slice(0, LIMITS.relevant);
}
