import { LIMITS, MODELS } from "../config";
import type { Env, Moderation } from "../contracts";
import { upstreamUnavailable } from "../errors";
import type { Fetcher } from "../http";
import { withTimeout } from "../http";
import { moderationPrompt } from "../prompts/moderation";
import { parseJsonCompletion, stringArray } from "./model-output";
import { v } from "../validation";

const moderationSchema = v.object({
  decision: v.picklist(["allow", "review", "block"]),
  categories: v.unknown(),
  reason: v.optional(v.pipe(v.string(), v.trim(), v.transform((value) => value.slice(0, 2_000)))),
});

function parseModeration(value: unknown): Moderation {
  const result = v.parse(moderationSchema, value);
  const categories = stringArray(result.categories, 10, 100);
  const reason = result.reason;
  return {
    decision: result.decision === "allow" && categories.length ? "block" : result.decision,
    categories,
    ...(reason ? { reason } : {}),
  };
}

export async function moderate(text: string, env: Env, fetcher: Fetcher): Promise<Moderation> {
  if (!env.OPENROUTER_API_KEY?.trim()) throw upstreamUnavailable("moderation");
  try {
    const output = await withTimeout(async (signal) => {
      const response = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
        body: JSON.stringify({
          model: MODELS.moderation,
          messages: [
            { role: "system", content: moderationPrompt },
            { role: "user", content: JSON.stringify({ text }) },
          ],
          temperature: 0,
          max_tokens: 1600,
          reasoning: { effort: "low" },
          response_format: { type: "json_object" },
        }),
      });
      if (!response.ok) throw new Error("安全分類上游失敗");
      return response.json();
    }, LIMITS.modelTimeoutMs);
    return parseModeration(parseJsonCompletion(output));
  } catch (error) {
    throw upstreamUnavailable("moderation", error);
  }
}
