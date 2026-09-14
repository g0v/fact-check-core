import { LIMITS, MODELS } from "../config";
import type { Env, FactCheckInput, Moderation, Verdict } from "../contracts";
import { upstreamUnavailable } from "../errors";
import { withTimeout } from "../http";
import { text } from "../input";
import { synthesisPrompt } from "../prompts/synthesis";
import { parseJsonCompletion } from "./model-output";
import type { Evidence } from "./types";

const verdicts: Verdict[] = [
  "supported",
  "mostly_supported",
  "mixed",
  "mostly_refuted",
  "refuted",
  "insufficient_evidence",
];

function hasUsableEvidence(evidence: Evidence[]) {
  return evidence.some((item) => item.source !== "provided-url" || item.reliability === "allowlisted-institution");
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
    const value = parseJsonCompletion(output);
    if (
      typeof value.factuality !== "number" ||
      value.factuality < 0 ||
      value.factuality > 1 ||
      typeof value.confidence !== "number" ||
      value.confidence < 0 ||
      value.confidence > 1 ||
      !verdicts.includes(value.verdict as Verdict)
    ) {
      throw new Error("綜整格式不正確");
    }
    return {
      factuality: value.factuality,
      confidence: hasEvidence ? value.confidence : Math.min(value.confidence, 0.5),
      verdict: value.verdict as Verdict,
      feedback: text(value.feedback, 6_000),
      hasEvidence,
    };
  } catch {
    throw upstreamUnavailable("synthesis");
  }
}
