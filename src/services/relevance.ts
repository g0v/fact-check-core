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

export type RelevanceSelection = {
  selected: Candidate[];
  hadFailures: boolean;
};

async function selectRelevantBatch(claim: string, candidates: Candidate[], ai: NonNullable<Env["AI"]>) {
  const modelCandidates = candidates.map((item) => ({
    articleId: item.articleId,
    text: item.text.slice(0, LIMITS.candidateText),
  }));
  const output = await withTimeout(
    () =>
      ai.run(MODELS.relevance, {
        messages: [
          { role: "system", content: relevancePrompt },
          { role: "user", content: JSON.stringify({ claim, candidates: modelCandidates }) },
        ],
        stream: false,
        temperature: 0,
        max_tokens: LIMITS.relevanceMaxTokens,
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
    return result.relevant && result.relevance >= LIMITS.relevanceThreshold
      ? [{ ...byId.get(id)!, relevanceScore: result.relevance }]
      : [];
  });
  if (seen.size !== candidates.length) throw new Error("初篩遺漏文章");
  return selected;
}

export async function selectRelevant(
  claim: string,
  candidates: Candidate[],
  env: Env,
): Promise<RelevanceSelection> {
  if (!candidates.length) return { selected: [], hadFailures: false };
  if (!env.AI) throw new Error("未設定 Workers AI");
  const ai = env.AI;

  const batches: Candidate[][] = [];
  for (let index = 0; index < candidates.length; index += LIMITS.relevanceBatchSize) {
    batches.push(candidates.slice(index, index + LIMITS.relevanceBatchSize));
  }
  const results = await Promise.allSettled(
    batches.map((batch) => selectRelevantBatch(claim, batch, ai)),
  );
  const successful: Candidate[] = [];
  const failed: Candidate[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") successful.push(...result.value);
    else failed.push(...batches[index]);
  });

  return {
    // 成功批次維持全域選取上限；失敗批次全部放行，避免漏掉可能的證據。
    selected: [
      ...successful.sort((a, b) => b.relevanceScore! - a.relevanceScore!).slice(0, LIMITS.relevant),
      ...failed,
    ],
    hadFailures: failed.length > 0,
  };
}
