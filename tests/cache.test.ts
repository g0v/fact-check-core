import assert from "node:assert/strict";
import test from "node:test";
import { cachedFactCheck, createResultCacheKey, type ResultCache } from "../src/cache";
import { RESULT_CACHE } from "../src/config";
import worker from "../src/index";
import { claim, createHarness } from "./helpers";

function memoryCache(): ResultCache & { entries: Map<string, Response> } {
  const entries = new Map<string, Response>();
  return {
    entries,
    async match(request) {
      return entries.get(request.url)?.clone();
    },
    async put(request, response) {
      entries.set(request.url, response.clone());
    },
  };
}

test("相同輸入命中快取時不再呼叫任何查核上游", async () => {
  const harness = createHarness();
  const cache = memoryCache();
  const logs: Record<string, unknown>[] = [];
  let fetchCalls = 0;
  let modelCalls = 0;
  const fetcher = async (...args: Parameters<typeof harness.fetcher>) => {
    fetchCalls += 1;
    return harness.fetcher(...args);
  };
  const run = harness.env.AI!.run.bind(harness.env.AI);
  harness.env.AI!.run = async (...args) => {
    modelCalls += 1;
    return run(...args);
  };

  const first = await cachedFactCheck({ text: claim }, harness.env, {
    origin: "https://fact-check-core",
    requestId: "first-request",
    fetcher,
    cache,
    log: (event) => logs.push(event),
  });
  assert.deepEqual(first.meta.cache, { status: "miss" });
  assert.equal(cache.entries.size, 1);
  const calls = { fetchCalls, modelCalls };

  const second = await cachedFactCheck({ text: claim }, harness.env, {
    origin: "https://fact-check-core",
    requestId: "second-request",
    fetcher,
    cache,
    log: (event) => logs.push(event),
  });
  assert.equal(second.meta.cache?.status, "hit");
  assert.equal(second.meta.request_id, "second-request");
  assert.equal(fetchCalls, calls.fetchCalls);
  assert.equal(modelCalls, calls.modelCalls);
  assert.ok(second.meta.cache?.cached_at);
  assert.ok(second.meta.cache?.expires_at);

  const stored = [...cache.entries.values()][0];
  assert.equal(stored.headers.get("Cache-Control"), `public, max-age=${RESULT_CACHE.ttlSeconds}`);
  const entry = await stored.json() as { result: Record<string, unknown> };
  assert.equal("text" in entry.result, false);
  assert.equal("url" in entry.result, false);
  const meta = entry.result.meta as Record<string, unknown>;
  assert.equal("request_id" in meta, false);
  assert.equal("cache" in meta, false);
  assert.equal(JSON.stringify(logs).includes(claim), false);
  assert.equal(JSON.stringify(logs).includes("test-key"), false);
});

test("快取鍵隔離不同文字、網址與 origin，且不包含輸入明文", async () => {
  const base = await createResultCacheKey({ text: claim }, "https://fact-check-core");
  const values = await Promise.all([
    createResultCacheKey({ text: `${claim}不同` }, "https://fact-check-core"),
    createResultCacheKey({ text: claim, url: "https://example.org/" }, "https://fact-check-core"),
    createResultCacheKey({ text: claim }, "https://other-core"),
  ]);
  assert.ok(values.every((value) => value.url !== base.url));
  assert.match(
    new URL(base.url).pathname,
    new RegExp(`^/__fact-check-cache/${RESULT_CACHE.version}/[a-f0-9]{64}$`),
  );
  assert.equal(base.url.includes(encodeURIComponent(claim)), false);
  assert.deepEqual([...base.headers], []);
});

test("partial 結果不寫入快取", async () => {
  const harness = createHarness({ invalidRelevance: true });
  const cache = memoryCache();
  const result = await cachedFactCheck({ text: claim }, harness.env, {
    origin: "https://fact-check-core",
    fetcher: harness.fetcher,
    cache,
    log: () => undefined,
  });
  assert.equal(result.status, "partial");
  assert.equal(result.meta.cache?.status, "miss");
  assert.equal(cache.entries.size, 0);
});

test("損壞與過期快取都會重跑 pipeline，不將例外內容寫入 log", async () => {
  for (const kind of ["invalid-json", "expired"] as const) {
    const harness = createHarness();
    const cache = memoryCache();
    const logs: Record<string, unknown>[] = [];
    await cachedFactCheck({ text: claim }, harness.env, {
      origin: "https://fact-check-core",
      fetcher: harness.fetcher,
      cache,
      log: (event) => logs.push(event),
    });
    const [key, stored] = [...cache.entries.entries()][0];
    if (kind === "invalid-json") {
      cache.entries.set(key, new Response("{secret-cache-error"));
    } else {
      const entry = await stored.json() as { cachedAt: number };
      entry.cachedAt = Date.now() - RESULT_CACHE.ttlSeconds * 1_000;
      cache.entries.set(key, Response.json(entry));
    }
    const result = await cachedFactCheck({ text: claim }, harness.env, {
      origin: "https://fact-check-core",
      fetcher: harness.fetcher,
      cache,
      log: (event) => logs.push(event),
    });
    assert.equal(result.meta.cache?.status, "miss");
    assert.ok(logs.some((event) =>
      event.event === "cache" && event.operation === "read" && event.status === "error"
    ));
    assert.equal(JSON.stringify(logs).includes("secret-cache-error"), false);
  }
});

test("快取讀寫失敗時仍回傳正常查核結果", async () => {
  for (const operation of ["read", "write"] as const) {
    const harness = createHarness();
    const logs: Record<string, unknown>[] = [];
    const cache: ResultCache = {
      async match() {
        if (operation === "read") throw new Error("secret-cache-error");
        return undefined;
      },
      async put() {
        if (operation === "write") throw new Error("secret-cache-error");
      },
    };
    const result = await cachedFactCheck({ text: claim }, harness.env, {
      origin: "https://fact-check-core",
      fetcher: harness.fetcher,
      cache,
      log: (event) => logs.push(event),
    });
    assert.equal(result.status, "completed");
    assert.ok(logs.some((event) =>
      event.event === "cache" && event.operation === operation && event.status === "error"
    ));
    assert.equal(JSON.stringify(logs).includes("secret-cache-error"), false);
  }
});

test("waitUntil 承接快取寫入，不阻塞查核回應", async () => {
  const harness = createHarness();
  const cache = memoryCache();
  const tasks: Promise<void>[] = [];
  let finish!: () => void;
  cache.put = async () => new Promise<void>((resolve) => {
    finish = resolve;
  });

  const result = await cachedFactCheck({ text: claim }, harness.env, {
    origin: "https://fact-check-core",
    fetcher: harness.fetcher,
    cache,
    waitUntil: (task) => tasks.push(task),
    log: () => undefined,
  });
  assert.equal(result.status, "completed");
  assert.equal(tasks.length, 1);
  finish();
  await Promise.all(tasks);
});

test("Worker 成功回應同步輸出 cache header、meta 與同一個 request ID", async () => {
  const harness = createHarness();
  const cache = memoryCache();
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { open: async () => cache },
  });
  globalThis.fetch = harness.fetcher;
  try {
    const request = () => new Request("https://fact-check-core/fact-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: claim }),
    });
    const first = await worker.fetch(request(), harness.env);
    const firstBody = await first.json() as {
      meta: { request_id: string; cache: { status: string } };
    };
    assert.equal(first.headers.get("X-Fact-Check-Cache"), "MISS");
    assert.equal(first.headers.get("Cache-Control"), "no-store");
    assert.equal(firstBody.meta.cache.status, "miss");
    assert.equal(first.headers.get("X-Request-Id"), firstBody.meta.request_id);

    const second = await worker.fetch(request(), harness.env);
    const secondBody = await second.json() as {
      meta: { request_id: string; cache: { status: string } };
    };
    assert.equal(second.headers.get("X-Fact-Check-Cache"), "HIT");
    assert.equal(second.headers.get("Cache-Control"), "no-store");
    assert.equal(secondBody.meta.cache.status, "hit");
    assert.equal(second.headers.get("X-Request-Id"), secondBody.meta.request_id);
    assert.notEqual(secondBody.meta.request_id, firstBody.meta.request_id);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else Reflect.deleteProperty(globalThis, "caches");
  }
});
