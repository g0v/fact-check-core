import * as v from "valibot";

export { v };

const recordSchema = v.objectWithRest({}, v.unknown());

export function parseRecord(value: unknown): Record<string, unknown> {
  return v.parse(recordSchema, value);
}

export function textSchema(max: number) {
  return v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(max));
}

export function parseText(value: unknown, max: number): string {
  return v.parse(textSchema(max), value);
}
