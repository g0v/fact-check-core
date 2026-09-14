import { LIMITS, MODELS } from "../config";
import type { Env, Moderation } from "../contracts";
import { upstreamUnavailable } from "../errors";
import { fetchJson, HttpError, type Fetcher } from "../http";
import type { Logger, LogValue } from "../logging";
import { moderationPrompt } from "../prompts/moderation";
import { parseRecord, parseText } from "../validation";

const moderationResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["allow", "review", "block"] },
    categories: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["decision", "categories", "reason"],
} as const;

const moderationErrorMessages = {
  missing_api_key: "尚未設定 OPENROUTER_API_KEY。",
  upstream_error: "OpenRouter 回傳錯誤物件。",
  invalid_completion: "OpenRouter 回應缺少有效的 choices 或 message。",
  choice_error: "安全分類模型的 choice 帶有錯誤。",
  incomplete_completion: "安全分類模型未完整輸出結果，請檢查 finish_reason 與 token 用量。",
  invalid_content: "安全分類模型的 content 為空、型別錯誤或超過長度限制。",
  invalid_content_json: "安全分類模型的 content 不是有效 JSON。",
  invalid_moderation: "安全分類判定不符合 decision／categories／reason 格式。",
} as const;

function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numericMetadata(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function completionMetadata(output: Record<string, unknown>): Record<string, LogValue> {
  const choices = Array.isArray(output.choices) ? output.choices : [];
  const choice = optionalRecord(choices[0]);
  const message = optionalRecord(choice.message);
  const usage = optionalRecord(output.usage);
  const finishReason = choice.finish_reason;
  const knownFinishReasons = ["stop", "length", "content_filter", "tool_calls", "function_call", "error"];
  return {
    choices_count: choices.length,
    has_upstream_error: Boolean(output.error),
    upstream_error_code: numericMetadata(optionalRecord(output.error).code),
    has_choice_error: Boolean(choice.error),
    choice_error_code: numericMetadata(optionalRecord(choice.error).code),
    finish_reason:
      finishReason == null
        ? null
        : typeof finishReason === "string" && knownFinishReasons.includes(finishReason)
          ? finishReason
          : "unknown",
    content_length: typeof message.content === "string" ? message.content.length : null,
    has_reasoning: Boolean(message.reasoning) || (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0),
    prompt_tokens: numericMetadata(usage.prompt_tokens),
    completion_tokens: numericMetadata(usage.completion_tokens),
    reasoning_tokens: numericMetadata(optionalRecord(usage.completion_tokens_details).reasoning_tokens),
  };
}

export function parseModeration(value: unknown): Moderation {
  const data = parseRecord(value);
  if (!Array.isArray(data.categories) || data.categories.length > 10) throw new Error("安全分類格式不正確。");
  if (typeof data.decision !== "string" || !["allow", "review", "block"].includes(data.decision)) {
    throw new Error("安全分類格式不正確。");
  }
  const categories = data.categories.map((category) => parseText(category, 100));
  const reason = data.reason === undefined || data.reason === null || data.reason === ""
    ? undefined
    : parseText(data.reason, 2_000);
  const decision = data.decision as "allow" | "review" | "block";
  return {
    decision: decision === "allow" && categories.length ? "block" : decision,
    categories,
    ...(reason ? { reason } : {}),
  };
}

export async function moderate(
  text: string,
  env: Env,
  fetcher: Fetcher = fetch,
  log: Logger = () => undefined,
): Promise<Moderation> {
  const start = Date.now();
  const diagnostics: Record<string, LogValue> = {
    stage: "moderation",
    model: MODELS.moderation,
    upstream_status: null,
  };
  let reason: keyof typeof moderationErrorMessages = "missing_api_key";
  try {
    log({ ...diagnostics, event: "moderation_config", step: "before_read" });
    const apiKey = env.OPENROUTER_API_KEY;
    const configured = typeof apiKey === "string" && Boolean(apiKey.trim());
    log({
      ...diagnostics,
      event: "moderation_config",
      step: "after_read",
      api_key_present: apiKey != null,
      api_key_is_string: typeof apiKey === "string",
      api_key_configured: configured,
    });
    if (!configured) throw new Error(moderationErrorMessages[reason]);
    const messages = [
      { role: "system", content: moderationPrompt },
      { role: "user", content: JSON.stringify({ text }) },
    ];
    log({
      ...diagnostics,
      event: "moderation_request",
      api_key_configured: configured,
      timeout_ms: LIMITS.modelTimeoutMs,
      max_tokens: 1_600,
      reasoning_effort: "low",
      response_format: "json_schema",
    });
    const output = await fetchJson(
      fetcher,
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODELS.moderation,
          messages,
          stream: false,
          temperature: 0,
          max_tokens: 1_600,
          reasoning: { effort: "low" },
          response_format: {
            type: "json_schema",
            json_schema: { name: "fact_check_moderation_decision", strict: true, schema: moderationResponseSchema },
          },
        }),
      },
      LIMITS.modelTimeoutMs,
      (status) => {
        diagnostics.upstream_status = status;
        log({ ...diagnostics, event: "moderation_http_response", latency_ms: Date.now() - start });
      },
    );
    reason = "invalid_completion";
    const response = parseRecord(output);
    Object.assign(diagnostics, completionMetadata(response));
    log({ ...diagnostics, event: "moderation_response", latency_ms: Date.now() - start });
    if (response.error) {
      reason = "upstream_error";
      throw new Error();
    }
    if (!Array.isArray(response.choices)) throw new Error();
    const choice = parseRecord(response.choices[0]);
    if (choice.error) {
      reason = "choice_error";
      throw new Error();
    }
    if (choice.finish_reason !== "stop") {
      reason = "incomplete_completion";
      throw new Error();
    }
    reason = "invalid_content";
    const content = parseText(parseRecord(choice.message).content, 64_000);
    reason = "invalid_content_json";
    const decision: unknown = JSON.parse(content);
    reason = "invalid_moderation";
    return parseModeration(decision);
  } catch (error) {
    log({
      ...diagnostics,
      event: "moderation_error",
      reason: error instanceof HttpError ? error.reason : reason,
      message: error instanceof HttpError ? error.message : moderationErrorMessages[reason],
      latency_ms: Date.now() - start,
    });
    throw upstreamUnavailable(
      "moderation",
      error,
      !(error instanceof HttpError) && reason === "missing_api_key",
    );
  }
}
