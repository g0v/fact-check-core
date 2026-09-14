import { LIMITS, MODELS } from "../config";
import type { Env, Moderation } from "../contracts";
import { upstreamUnavailable } from "../errors";
import type { Fetcher } from "../http";
import { withTimeout } from "../http";
import { asRecord } from "../input";
import { moderationPrompt } from "../prompts/moderation";
import { parseJsonCompletion, stringArray } from "./model-output";

function parseModeration(value: unknown): Moderation {
  const result = asRecord(value);
  const decision = result.decision;
  if (decision !== "allow" && decision !== "review" && decision !== "block") {
    throw new Error("分類不正確");
  }
  const categories = stringArray(result.categories, 10, 100);
  const reason = typeof result.reason === "string" ? result.reason.trim().slice(0, 2_000) : undefined;
  return {
    decision: decision === "allow" && categories.length ? "block" : decision,
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
  } catch {
    throw upstreamUnavailable("moderation");
  }
}
