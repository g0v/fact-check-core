import { LIMITS } from "./config";

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function withTimeout<T>(
  action: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function readText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) throw new Error("逾時");
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("回應過大");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
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
