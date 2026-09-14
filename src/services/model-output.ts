import { parseRecord, parseText } from "../validation";

const modelOutputErrorMessages = {
  invalid_completion: "模型回應缺少有效的輸出結構。",
  incomplete_completion: "模型未完整輸出結果，請檢查 finish_reason 與輸出 token 上限。",
  invalid_content: "模型輸出內容為空、型別錯誤或超過長度限制。",
  invalid_content_json: "模型輸出不是有效 JSON。",
} as const;

export type ModelOutputErrorReason = keyof typeof modelOutputErrorMessages;
const knownFinishReasons = ["stop", "length", "content_filter", "tool_calls", "function_call", "error"];

export class ModelOutputError extends Error {
  constructor(
    public readonly reason: ModelOutputErrorReason,
    public readonly finishReason: string | null = null,
  ) {
    super(modelOutputErrorMessages[reason]);
    this.name = "ModelOutputError";
  }
}

export function parseModelJson(value: unknown): unknown {
  let reason: ModelOutputErrorReason = "invalid_completion";
  let finishReason: string | null = null;
  try {
    const output = parseRecord(value);
    let content: string;
    if (typeof output.response === "string") {
      reason = "invalid_content";
      content = parseText(output.response, 64_000);
    } else {
      if (!Array.isArray(output.choices)) throw new Error();
      const choice = parseRecord(output.choices[0]);
      if (typeof choice.finish_reason === "string") {
        finishReason = knownFinishReasons.includes(choice.finish_reason) ? choice.finish_reason : "unknown";
      }
      if (choice.finish_reason && choice.finish_reason !== "stop") {
        reason = "incomplete_completion";
        throw new Error();
      }
      reason = "invalid_content";
      content = parseText(parseRecord(choice.message).content, 64_000);
    }
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(content);
    reason = "invalid_content_json";
    return JSON.parse(fenced ? fenced[1] : content);
  } catch {
    throw new ModelOutputError(reason, finishReason);
  }
}

export function parseJsonCompletion(value: unknown): Record<string, unknown> {
  return parseRecord(parseModelJson(value));
}
