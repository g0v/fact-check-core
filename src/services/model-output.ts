import { parseRecord, textSchema, v } from "../validation";

const workersAiCompletionSchema = v.object({ response: v.string() });
const openRouterCompletionSchema = v.object({
  choices: v.pipe(v.array(v.object({
    finish_reason: v.literal("stop"),
    message: v.object({ content: textSchema(64_000) }),
  })), v.minLength(1)),
});

export function parseJsonCompletion(value: unknown): Record<string, unknown> {
  const workersAi = v.safeParse(workersAiCompletionSchema, value);
  if (workersAi.success) return parseRecord(JSON.parse(workersAi.output.response));
  const openRouter = v.parse(openRouterCompletionSchema, value);
  return parseRecord(JSON.parse(openRouter.choices[0].message.content));
}

export function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  return v.parse(v.pipe(v.array(textSchema(maxLength)), v.maxLength(maxItems)), value);
}
