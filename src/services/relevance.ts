import { LIMITS, MODELS } from "../config";
import type { Env } from "../contracts";
import { withTimeout } from "../http";
import { asRecord, text } from "../input";
import { relevancePrompt } from "../prompts/relevance";
import { parseJsonCompletion } from "./model-output";
import type { Candidate } from "./types";

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
  const results = asRecord(parseJsonCompletion(output)).results;
  if (!Array.isArray(results) || results.length !== candidates.length) {
    throw new Error("初篩結果不完整");
  }
  const byId = new Map(candidates.map((candidate) => [candidate.articleId, candidate]));
  const seen = new Set<string>();
  const selected = results.flatMap((raw): Candidate[] => {
    const result = asRecord(raw);
    const id = text(result.article_id, 200);
    if (
      seen.has(id) ||
      !byId.has(id) ||
      typeof result.relevant !== "boolean" ||
      typeof result.relevance !== "number" ||
      !Number.isFinite(result.relevance) ||
      result.relevance < 0 ||
      result.relevance > 1
    ) {
      throw new Error("初篩格式不正確");
    }
    seen.add(id);
    return result.relevant && result.relevance >= 0.65
      ? [{ ...byId.get(id)!, relevanceScore: result.relevance }]
      : [];
  });
  if (seen.size !== candidates.length) throw new Error("初篩遺漏文章");
  return selected.sort((a, b) => b.relevanceScore! - a.relevanceScore!).slice(0, LIMITS.relevant);
}
