import type { Env } from "./contracts";
import { ApiError } from "./errors";
import { factCheck } from "./fact-check";
import { readText, withTimeout } from "./http";
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
    throw new ApiError("INVALID_INPUT", "核心服務只接受 POST /fact-check。", 400);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError("INVALID_INPUT", "請使用 application/json 格式。", 400);
  }
  if (Number(request.headers.get("content-length")) > LIMITS.requestBytes) {
    throw new ApiError("PAYLOAD_TOO_LARGE", "請求內容過大。", 413);
  }
  try {
    const raw = await withTimeout((signal) => readText(request.body, LIMITS.requestBytes, signal), LIMITS.fetchTimeoutMs);
    return parseInput(JSON.parse(raw));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("INVALID_INPUT", "JSON 格式不正確、內容過大或無法讀取。", 400);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return json({ status: "ok" }, 200, requestId);
    try {
      if (path !== "/fact-check") throw new ApiError("INVALID_INPUT", "找不到內部服務端點。", 400);
      const result = await factCheck(await requestInput(request), env);
      return json(result, 200, result.meta.request_id);
    } catch (error) {
      const known = error instanceof ApiError;
      const status = known ? error.status : 500;
      const body = {
        status: "error",
        error: known ? error.code : "INTERNAL_ERROR",
        message: known ? error.message : "查核服務發生錯誤。",
        ...(known && error.stage ? { stage: error.stage } : {}),
        request_id: requestId,
      };
      console.info(JSON.stringify({ event: "error", request_id: requestId, status, stage: known ? error.stage : undefined }));
      return json(body, status, requestId);
    }
  },
};

export { factCheck } from "./fact-check";
export type { Env, FactCheckInput, FactCheckResult } from "./contracts";
