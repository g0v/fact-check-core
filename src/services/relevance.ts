import { LIMITS, MODELS } from "../config";
import type { Env } from "../contracts";
import { upstreamUnavailable } from "../errors";
import { withTimeout } from "../http";
import type { Logger } from "../logging";
import { relevancePrompt } from "../prompts/relevance";
import { parseRecord, parseText } from "../validation";
import { parseModelJson } from "./model-output";
import type { Candidate, RelevanceResult, RelevantCandidate } from "./types";

export async function filterRelevantCandidates(
  text: string,
  candidates: Candidate[],
  env: Env,
  log: Logger = () => undefined,
): Promise<{ selected: RelevantCandidate[]; results: RelevanceResult[] }> {
  if (!candidates.length) return { selected: [], results: [] };
  try {
    if (!env.AI) throw new Error("尚未設定 Workers AI。");
    const modelCandidates = candidates.map(({ articleId, text: candidateText }) => ({
      articleId,
      text: candidateText.slice(0, LIMITS.candidateText),
    }));
    log({
      event: "relevance_model_request",
      model: MODELS.relevance,
      candidate_count: modelCandidates.length,
      distinct_text_count: new Set(modelCandidates.map((item) => item.text)).size,
      article_ids: modelCandidates.map((item) => item.articleId),
      source_text_lengths: candidates.map((item) => item.text.length),
      sent_text_lengths: modelCandidates.map((item) => item.text.length),
    });
    const output = await withTimeout(
      () =>
        env.AI!.run(MODELS.relevance, {
          messages: [
            { role: "system", content: relevancePrompt },
            { role: "user", content: JSON.stringify({ claim: text, candidates: modelCandidates }) },
          ],
          stream: false,
          temperature: 0,
          max_tokens: LIMITS.relevanceMaxTokens,
          response_format: { type: "json_object" },
        }),
      LIMITS.modelTimeoutMs,
    );
    const candidateMap = new Map(candidates.map((candidate) => [candidate.articleId, candidate]));
    const parsed = parseRecord(parseModelJson(output));
    if (!Array.isArray(parsed.results)) throw new Error("初篩結果格式不正確。");
    const modelItems = parsed.results.map(parseRecord);
    log({
      event: "relevance_model_response",
      model: MODELS.relevance,
      result_count: modelItems.length,
      article_ids: modelItems.map((item) =>
        typeof item.article_id === "string" && candidateMap.has(item.article_id) ? item.article_id : "unknown",
      ),
      model_relevance_scores: modelItems.map((item) =>
        typeof item.relevance === "number" && Number.isFinite(item.relevance) ? item.relevance : null,
      ),
      model_relevant_count: modelItems.filter((item) => item.relevant === true).length,
    });
    const seen = new Set<string>();
    const results = modelItems.map((item): RelevanceResult => {
      const articleId = parseText(item.article_id, 200);
      if (!candidateMap.has(articleId) || seen.has(articleId) || typeof item.relevant !== "boolean") {
        throw new Error("初篩回應的文章 ID 或相關性格式不正確。");
      }
      if (typeof item.relevance !== "number" || !Number.isFinite(item.relevance) || item.relevance < 0 || item.relevance > 1) {
        throw new Error("初篩分數格式不正確。");
      }
      seen.add(articleId);
      return {
        articleId,
        relevant: item.relevant,
        relevance: item.relevance,
        reason: parseText(item.reason, 1_000),
      };
    });
    if (seen.size !== candidates.length) throw new Error("初篩回應遺漏文章。");
    const selected = results
      .filter((item) => item.relevant && item.relevance >= LIMITS.relevanceThreshold)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, LIMITS.relevant)
      .map((item) => ({
        ...candidateMap.get(item.articleId)!,
        relevanceScore: item.relevance,
        relevanceReason: item.reason,
      }));
    return { selected, results };
  } catch (error) {
    throw upstreamUnavailable("relevance", error);
  }
}

export async function selectRelevant(text: string, candidates: Candidate[], env: Env) {
  return (await filterRelevantCandidates(text, candidates, env)).selected;
}
