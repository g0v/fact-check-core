import { asRecord, text } from "../input";

export function parseJsonCompletion(value: unknown): Record<string, unknown> {
  const output = asRecord(value);
  if (typeof output.response === "string") return asRecord(JSON.parse(output.response));
  if (!Array.isArray(output.choices) || output.choices.length === 0) {
    throw new Error("模型回應不正確");
  }
  const choice = asRecord(output.choices[0]);
  if (choice.finish_reason !== "stop") throw new Error("模型未完整輸出");
  return asRecord(JSON.parse(text(asRecord(choice.message).content, 64_000)));
}

export function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error("陣列格式不正確");
  return value.map((item) => text(item, maxLength));
}
