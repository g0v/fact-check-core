import type { Env } from "./contracts";
import { ApiError, internalError, invalidInput, payloadTooLarge } from "./errors";
import { factCheck } from "./fact-check";
import { BodyTooLargeError, readText, withTimeout } from "./http";
import { parseInput } from "./input";
import { LIMITS } from "./config";

function json(value: unknown, status = 200, requestId?: string) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(requestId ? { "X-Request-Id": requestId } : {}),
    },
  });
}

async function requestInput(request: Request) {
  if (request.method !== "POST") {
    throw invalidInput("核心服務只接受 POST /fact-check。");
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw invalidInput("請使用 application/json 格式。");
  }
  if (Number(request.headers.get("content-length")) > LIMITS.requestBytes) {
    throw payloadTooLarge();
  }
  try {
    const raw = await withTimeout((signal) => readText(request.body, LIMITS.requestBytes, signal), LIMITS.fetchTimeoutMs);
    return parseInput(JSON.parse(raw));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof BodyTooLargeError) throw payloadTooLarge();
    throw invalidInput("JSON 格式不正確或無法讀取。");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return json({ status: "ok" }, 200, requestId);
    try {
      if (path !== "/fact-check") throw invalidInput("找不到內部服務端點。");
      const result = await factCheck(await requestInput(request), env);
      return json(result, 200, result.meta.request_id);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : internalError(error);
      const body = {
        status: "error",
        error: apiError.code,
        message: apiError.message,
        ...(apiError.stage ? { stage: apiError.stage } : {}),
        request_id: requestId,
      };
      console.info(JSON.stringify({
        event: "error",
        request_id: requestId,
        status: apiError.status,
        code: apiError.code,
        stage: apiError.stage,
        ...(apiError.cause === undefined
          ? {}
          : { cause_type: apiError.cause instanceof Error ? apiError.cause.name : typeof apiError.cause }),
      }));
      return json(body, apiError.status, requestId);
    }
  },
};

export { factCheck } from "./fact-check";
export type { Env, FactCheckInput, FactCheckResult } from "./contracts";
