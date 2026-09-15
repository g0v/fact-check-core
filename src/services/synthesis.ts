import { LIMITS, MODELS } from "../config";
import { verdicts, type Env, type FactCheckInput, type Moderation } from "../contracts";
import { upstreamUnavailable } from "../errors";
import { withTimeout } from "../http";
import { synthesisPrompt } from "../prompts/synthesis";
import { parseJsonCompletion } from "./model-output";
import type { Evidence } from "./types";
import { textSchema, v } from "../validation";

const synthesisSchema = v.object({
  factuality: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  confidence: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  verdict: v.picklist(verdicts),
  feedback: textSchema(6_000),
});

function hasUsableEvidence(evidence: Evidence[]) {
  return evidence.some((item) => item.source !== "provided-url" || item.reliability === "allowlisted-institution");
}

export function parseSynthesis(value: unknown, hasEvidence: boolean) {
  const result = v.parse(synthesisSchema, value);
  return {
    ...result,
    confidence: hasEvidence ? result.confidence : Math.min(result.confidence, 0.5),
  };
}

export async function synthesize(
  input: FactCheckInput,
  moderation: Moderation,
  evidence: Evidence[],
  env: Env,
) {
  if (!env.AI) throw upstreamUnavailable("synthesis");
  try {
    const hasEvidence = hasUsableEvidence(evidence);
    const modelEvidence = (hasEvidence ? evidence : []).map((item) => ({
      source: item.source,
      reliability: item.reliability,
      evidenceText: item.text.slice(0, LIMITS.evidenceText),
      articleId: item.articleId,
      untrustedArticleText: item.articleText?.slice(0, 3_000),
      classification: item.classification,
      sourceUrls: item.sourceUrls?.slice(0, 3),
      relevanceScore: item.relevanceScore,
    }));
    const output = await withTimeout(
      () =>
        env.AI!.run(MODELS.synthesis, {
          messages: [
            { role: "system", content: synthesisPrompt },
            { role: "user", content: JSON.stringify({ claim: input.text, moderation, evidence: modelEvidence }) },
          ],
          stream: false,
          temperature: 0,
          max_completion_tokens: 4_096,
          chat_template_kwargs: { enable_thinking: false },
          response_format: { type: "json_object" },
        }),
      LIMITS.modelTimeoutMs,
    );
    const value = parseSynthesis(parseJsonCompletion(output), hasEvidence);
    return {
      factuality: value.factuality,
      confidence: value.confidence,
      verdict: value.verdict,
      feedback: value.feedback,
      hasEvidence,
    };
  } catch (error) {
    throw upstreamUnavailable("synthesis", error);
  }
}
