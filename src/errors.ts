export class ApiError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "PAYLOAD_TOO_LARGE" | "UPSTREAM_UNAVAILABLE" | "INTERNAL_ERROR",
    message: string,
    public readonly status: 400 | 413 | 500 | 502,
    public readonly stage?: string,
  ) {
    super(message);
  }
}

export const invalidInput = () =>
  new ApiError(
    "INVALID_INPUT",
    "text 必填且不得超過 10,000 字；url 選填且須為公開 HTTP／HTTPS 網址。",
    400,
  );

export const upstreamUnavailable = (stage: string) =>
  new ApiError("UPSTREAM_UNAVAILABLE", "查核上游服務暫時無法使用，請稍後再試。", 502, stage);
