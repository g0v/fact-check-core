import { LIMITS } from "./config";

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class TimeoutError extends Error {
  constructor() {
    super("上游服務回應逾時。");
    this.name = "TimeoutError";
  }
}

export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super("回應過大");
    this.name = "BodyTooLargeError";
  }
}

export async function withTimeout<T>(
  action: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError());
    }, timeoutMs);
  });
  try {
    // AI.run 目前不接受 AbortSignal；Promise.race 仍需立即結束對呼叫端的等待，
    // 同時 abort 可取消支援 signal 的 fetch 與 response body 讀取。
    return await Promise.race([Promise.resolve().then(() => action(controller.signal)), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function readText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) throw new Error("逾時");
      const { done, value } = await reader.read();
      if (done) {
        if (signal?.aborted) throw new TimeoutError();
        return text + decoder.decode();
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new BodyTooLargeError(maxBytes);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function fetchJson(fetcher: Fetcher, url: string, init: RequestInit): Promise<unknown> {
  return withTimeout(async (signal) => {
    const response = await fetcher(url, { ...init, signal, redirect: "manual" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("上游回應失敗");
    }
    return JSON.parse(await readText(response.body, LIMITS.upstreamBytes, signal));
  }, LIMITS.fetchTimeoutMs);
}
