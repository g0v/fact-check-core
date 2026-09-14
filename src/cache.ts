import { LIMITS, MODELS, RESULT_CACHE } from "./config";
import type { Env, FactCheckInput, FactCheckResult } from "./contracts";
import { factCheck } from "./fact-check";
import { readText, withTimeout, type Fetcher } from "./http";
import type { Logger } from "./logging";
import { moderationPrompt } from "./prompts/moderation";
import { relevancePrompt } from "./prompts/relevance";
import { synthesisPrompt } from "./prompts/synthesis";
import { parseModeration } from "./services/moderation";
import { parseSynthesis } from "./services/synthesis";
import { parseRecord, parseText } from "./validation";

export type ResultCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

type CachedResult = Omit<FactCheckResult, "text" | "url" | "meta"> & {
  meta: Omit<FactCheckResult["meta"], "request_id" | "cache">;
};
type CacheEntry = { version: string; cachedAt: number; result: CachedResult };

export async function createResultCacheKey(input: FactCheckInput, origin: string): Promise<Request> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: RESULT_CACHE.version,
      models: MODELS,
      limits: LIMITS,
      prompts: [moderationPrompt, relevancePrompt, synthesisPrompt],
      text: input.text,
      url: input.url ?? null,
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return new Request(new URL(`/__fact-check-cache/${RESULT_CACHE.version}/${hash}`, origin), {
    method: "GET",
  });
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("資料必須為陣列。");
  return value;
}

function unitNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("數值格式不正確。");
  }
  return value;
}

function parseCacheEntry(value: unknown): CacheEntry {
  const entry = parseRecord(value);
  const result = parseRecord(entry.result);
  const meta = parseRecord(result.meta);
  if (
    entry.version !== RESULT_CACHE.version ||
    typeof entry.cachedAt !== "number" ||
    !Number.isSafeInteger(entry.cachedAt) ||
    entry.cachedAt > Date.now() ||
    entry.cachedAt + RESULT_CACHE.ttlSeconds * 1_000 <= Date.now() ||
    result.status !== "completed" ||
    array(meta.warnings).length !== 0 ||
    typeof meta.url_context_used !== "boolean" ||
    typeof meta.url_context_allowlisted !== "boolean" ||
    typeof meta.no_relevant_evidence !== "boolean"
  ) {
    throw new Error("快取已過期或格式不正確。");
  }
  for (const key of ["cofacts_candidates", "cofacts_relevant", "cofacts_human_checks", "cofacts_ai_checks"]) {
    if (typeof meta[key] !== "number" || !Number.isSafeInteger(meta[key]) || meta[key] < 0) {
      throw new Error("快取計數不正確。");
    }
  }
  if (parseModeration(result.moderation).decision === "block") {
    throw new Error("不可採用封鎖結果的快取。");
  }
  const checks = array(result.related_checks);
  if (
    (checks.length > 0 && meta.no_relevant_evidence) ||
    (checks.length === 0 && !meta.no_relevant_evidence && !meta.url_context_allowlisted) ||
    (meta.url_context_allowlisted && !meta.url_context_used)
  ) {
    throw new Error("快取證據狀態不一致。");
  }
  parseSynthesis(result, !meta.no_relevant_evidence);
  if (meta.no_relevant_evidence && unitNumber(result.confidence) > 0.5) {
    throw new Error("快取在無證據時信心值超過上限。");
  }
  for (const value of checks) {
    const check = parseRecord(value);
    if (check.type !== "cofacts_human" && check.type !== "cofacts_ai") throw new Error("快取類型不正確。");
    parseText(check.text, LIMITS.evidenceText);
    parseText(check.url, LIMITS.url);
    for (const key of ["reference_url", "classification"]) {
      if (check[key] !== undefined) parseText(check[key], LIMITS.url);
    }
    if (check.reference_urls !== undefined) array(check.reference_urls).forEach((url) => parseText(url, LIMITS.url));
    if (check.retrieval_score !== undefined && (typeof check.retrieval_score !== "number" || !Number.isFinite(check.retrieval_score))) {
      throw new Error("快取搜尋分數不正確。");
    }
    if (check.relevance_score !== undefined) unitNumber(check.relevance_score);
  }
  return value as CacheEntry;
}

export async function cachedFactCheck(
  input: FactCheckInput,
  env: Env,
  options: {
    origin: string;
    requestId?: string;
    fetcher?: Fetcher;
    log?: Logger;
    cache?: ResultCache | null;
    waitUntil?: (task: Promise<void>) => void;
  },
): Promise<FactCheckResult> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const log: Logger = options.log ?? ((event) => console.info(JSON.stringify(event)));
  const cacheLog = (status: string, operation: string) =>
    log({ event: "cache", request_id: requestId, status, operation });
  let cache: ResultCache | undefined;
  let key: Request | undefined;
  let cacheStatus: "miss" | "bypass" = "bypass";
  try {
    cache = options.cache === null
      ? undefined
      : (options.cache ?? (typeof caches === "undefined"
        ? undefined
        : await withTimeout(() => caches.open(RESULT_CACHE.namespace), RESULT_CACHE.timeoutMs)));
    if (cache) {
      key = await createResultCacheKey(input, options.origin);
      cacheStatus = "miss";
      const entry = await withTimeout(async (signal) => {
        const response = await cache!.match(key!);
        if (!response) return null;
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        return parseCacheEntry(JSON.parse(await readText(response.body, LIMITS.upstreamBytes, signal)));
      }, RESULT_CACHE.timeoutMs);
      if (entry) {
        cacheLog("hit", "read");
        return {
          ...entry.result,
          ...input,
          meta: {
            ...entry.result.meta,
            request_id: requestId,
            cache: {
              status: "hit",
              cached_at: new Date(entry.cachedAt).toISOString(),
              expires_at: new Date(entry.cachedAt + RESULT_CACHE.ttlSeconds * 1_000).toISOString(),
            },
          },
        };
      }
      cacheLog("miss", "read");
    } else {
      cacheLog("bypass", "read");
    }
  } catch {
    cacheLog("error", "read");
  }

  const schedule = async (task: Promise<void>) => {
    if (!options.waitUntil) return task;
    try {
      options.waitUntil(task);
    } catch {
      cacheLog("error", "schedule");
      await task;
    }
  };

  const result = await factCheck(input, env, {
    requestId,
    fetcher: options.fetcher,
    log,
  });
  if (cache && key && result.status === "completed" && result.meta.warnings.length === 0) {
    const { request_id: _requestId, cache: _cache, ...meta } = result.meta;
    const { text: _text, url: _url, meta: _meta, ...content } = result;
    const entry: CacheEntry = {
      version: RESULT_CACHE.version,
      cachedAt: Date.now(),
      result: { ...content, meta },
    };
    const write = async () => {
      try {
        const body = JSON.stringify(entry);
        if (new TextEncoder().encode(body).byteLength > LIMITS.upstreamBytes) {
          cacheLog("bypass", "write");
          return;
        }
        await withTimeout(
          () => cache!.put(key!, new Response(body, {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": `public, max-age=${RESULT_CACHE.ttlSeconds}`,
            },
          })),
          RESULT_CACHE.timeoutMs,
        );
        cacheLog("stored", "write");
      } catch {
        cacheLog("error", "write");
      }
    };
    await schedule(write());
  } else {
    cacheLog("bypass", "write");
  }
  return { ...result, meta: { ...result.meta, cache: { status: cacheStatus } } };
}
