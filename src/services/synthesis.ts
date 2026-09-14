import { LIMITS, MODELS } from "../config";
import { verdicts, type Env, type FactCheckInput, type Moderation, type Verdict } from "../contracts";
import { upstreamUnavailable } from "../errors";
import { HttpError, withTimeout } from "../http";
import type { Logger, LogValue } from "../logging";
import { synthesisPrompt } from "../prompts/synthesis";
import { parseRecord, parseText } from "../validation";
import { ModelOutputError, parseModelJson } from "./model-output";
import type { Evidence } from "./types";

const synthesisErrorMessages = {
  missing_binding: "尚未設定 Workers AI。",
  timeout: "綜整模型回應逾時。",
  model_error: "Workers AI 綜整呼叫失敗。",
  invalid_synthesis: "綜整結果不符合 factuality／confidence／verdict 契約。",
} as const;

function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numericMetadata(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function responseMetadata(value: unknown): Record<string, LogValue> {
  const output = optionalRecord(value);
  const choices = Array.isArray(output.choices) ? output.choices : [];
  const choice = optionalRecord(choices[0]);
  const message = optionalRecord(choice.message);
  const usage = optionalRecord(output.usage);
  const finishReason = choice.finish_reason;
  const known = ["stop", "length", "content_filter", "tool_calls", "function_call", "error"];
  return {
    choices_count: choices.length,
    finish_reason: finishReason == null ? null : typeof finishReason === "string" && known.includes(finishReason) ? finishReason : "unknown",
    content_length: typeof message.content === "string" ? message.content.length : null,
    has_reasoning: Boolean(message.reasoning) || Boolean(message.reasoning_content) || (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0),
    prompt_tokens: numericMetadata(usage.prompt_tokens),
    completion_tokens: numericMetadata(usage.completion_tokens),
    reasoning_tokens: numericMetadata(optionalRecord(usage.completion_tokens_details).reasoning_tokens),
  };
}

export type SynthesisResult = {
  factuality: number;
  confidence: number;
  verdict: Verdict;
  feedback: string;
};

export function parseSynthesis(value: unknown, hasUsableEvidence: boolean): SynthesisResult {
  const data = parseRecord(value);
  if (typeof data.factuality !== "number" || !Number.isFinite(data.factuality) || data.factuality < 0 || data.factuality > 1) throw new Error();
  if (typeof data.confidence !== "number" || !Number.isFinite(data.confidence) || data.confidence < 0 || data.confidence > 1) throw new Error();
  if (typeof data.verdict !== "string" || !verdicts.includes(data.verdict as Verdict)) throw new Error();
  return {
    factuality: data.factuality,
    confidence: hasUsableEvidence ? data.confidence : Math.min(data.confidence, 0.5),
    verdict: data.verdict as Verdict,
    feedback: parseText(data.feedback, 6_000),
  };
}

export async function synthesize(
  input: FactCheckInput,
  moderation: Moderation,
  evidence: Evidence[],
  env: Env,
  log: Logger = () => undefined,
): Promise<SynthesisResult> {
  const start = Date.now();
  let reason: keyof typeof synthesisErrorMessages = "missing_binding";
  try {
    if (!env.AI) throw new Error(synthesisErrorMessages.missing_binding);
    const hasUsableEvidence = evidence.some(
      (item) => item.source === "cofacts-human" || item.source === "cofacts-ai" || item.reliability === "allowlisted-institution",
    );
    const textBudget = Math.min(LIMITS.evidenceText, Math.floor(60_000 / Math.max(evidence.length, 1)));
    const modelEvidence = (hasUsableEvidence ? evidence : []).map((item) => ({
      source: item.source,
      reliability: item.reliability,
      evidenceText: item.evidenceText.slice(0, textBudget),
      ...(item.source !== "provided-url" && item.articleText
        ? { untrustedArticleText: item.articleText.slice(0, Math.floor(textBudget / 2)) }
        : {}),
      articleId: item.articleId,
      verdict: item.verdict,
      classification: item.classification,
      referenceText: item.referenceText?.slice(0, Math.floor(textBudget / 2)),
      sourceUrl: item.sourceUrl,
      sourceUrls: item.sourceUrls?.slice(0, 3),
      cofactsUrl: item.cofactsUrl,
      retrievalScore: item.retrievalScore,
      relevanceScore: item.relevanceScore,
      positiveFeedback: item.positiveFeedback,
      negativeFeedback: item.negativeFeedback,
    }));
    const messages = [
      { role: "system" as const, content: synthesisPrompt },
      { role: "user" as const, content: JSON.stringify({ claim: input.text, moderation, evidence: modelEvidence }) },
    ];
    reason = "model_error";
    const output = await withTimeout(
      () => env.AI!.run(MODELS.synthesis, {
        messages,
        stream: false,
        temperature: 0,
        max_completion_tokens: 4_096,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_object" },
      }),
      LIMITS.modelTimeoutMs,
    );
    log({ event: "synthesis_response", stage: "synthesis", model: MODELS.synthesis, ...responseMetadata(output), latency_ms: Date.now() - start });
    reason = "invalid_synthesis";
    return parseSynthesis(parseModelJson(output), hasUsableEvidence);
  } catch (error) {
    const isTimeout = error instanceof HttpError && error.reason === "timeout";
    log({
      event: "synthesis_error",
      stage: "synthesis",
      model: MODELS.synthesis,
      reason: error instanceof ModelOutputError ? error.reason : isTimeout ? "timeout" : reason,
      finish_reason: error instanceof ModelOutputError ? error.finishReason : null,
      message: error instanceof ModelOutputError ? error.message : synthesisErrorMessages[isTimeout ? "timeout" : reason],
      latency_ms: Date.now() - start,
    });
    throw upstreamUnavailable("synthesis", error);
  }
}
