export type ApiErrorStage =
  | "moderation"
  | "cofacts-search"
  | "cofacts-evidence"
  | "relevance"
  | "synthesis"
  | "url";

const statusByCode = {
  INVALID_INPUT: 400,
  PAYLOAD_TOO_LARGE: 413,
  UPSTREAM_UNAVAILABLE: 502,
  INTERNAL_ERROR: 500,
} as const;

export type ApiErrorCode = keyof typeof statusByCode;

export class ApiError extends Error {
  public readonly status: 400 | 413 | 500 | 502;

  private constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly stage?: ApiErrorStage,
    public readonly configError = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiError";
    this.status = statusByCode[code];
  }

  static invalidInput(message = "text 必填且不得超過 10,000 字；url 選填且須為公開 HTTP／HTTPS 網址。") {
    return new ApiError("INVALID_INPUT", message);
  }

  static payloadTooLarge() {
    return new ApiError("PAYLOAD_TOO_LARGE", "請求內容過大。");
  }

  static upstreamUnavailable(stage: ApiErrorStage, cause?: unknown, configError = false) {
    return new ApiError(
      "UPSTREAM_UNAVAILABLE",
      "查核上游服務暫時無法使用，請稍後再試。",
      stage,
      configError,
      { cause },
    );
  }

  static internalError(cause?: unknown) {
    return new ApiError("INTERNAL_ERROR", "查核服務發生錯誤。", undefined, false, { cause });
  }
}

export const invalidInput = (message?: string) => ApiError.invalidInput(message);
export const payloadTooLarge = () => ApiError.payloadTooLarge();
export const upstreamUnavailable = (
  stage: ApiErrorStage,
  cause?: unknown,
  configError = false,
) => ApiError.upstreamUnavailable(stage, cause, configError);
export const internalError = (cause?: unknown) => ApiError.internalError(cause);
