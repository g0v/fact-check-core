import { LIMITS } from "./config";

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const httpErrorMessages = {
  timeout: "服務回應逾時。",
  network_error: "上游請求無法送出，請檢查連線與請求參數。",
  http_error: "上游服務回應失敗。",
  response_read_error: "無法讀取上游回應。",
  response_too_large: "回應內容超過大小限制。",
  invalid_response_json: "上游回應不是有效 JSON。",
} as const;

export class HttpError extends Error {
  constructor(public readonly reason: keyof typeof httpErrorMessages) {
    super(httpErrorMessages[reason]);
    this.name = "HttpError";
  }
}

// 保留既有匯出名稱，讓使用端能精確辨識 timeout 與大小限制。
export class TimeoutError extends HttpError {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

export class BodyTooLargeError extends HttpError {
  constructor(public readonly limit: number) {
    super("response_too_large");
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
      if (signal?.aborted) throw new TimeoutError();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new BodyTooLargeError(maxBytes);
      text += decoder.decode(value, { stream: true });
    }
    if (signal?.aborted) throw new TimeoutError();
    return text + decoder.decode();
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export const readLimitedText = readText;

export async function fetchJson(
  fetcher: Fetcher,
  url: string | URL,
  init: RequestInit,
  timeoutMs: number = LIMITS.fetchTimeoutMs,
  onResponse?: (status: number) => void,
): Promise<unknown> {
  return withTimeout(async (signal) => {
    let response: Response;
    try {
      response = await fetcher(url, { ...init, signal, redirect: "manual" });
    } catch {
      throw new HttpError("network_error");
    }
    if (signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      throw new TimeoutError();
    }
    onResponse?.(response.status);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError("http_error");
    }
    let body: string;
    try {
      body = await readText(response.body, LIMITS.upstreamBytes, signal);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError("response_read_error");
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new HttpError("invalid_response_json");
    }
  }, timeoutMs);
}
