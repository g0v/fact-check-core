# Fact Check Core

供 `fact-check-api` 透過 Cloudflare Service Binding 呼叫的事實查核核心 Worker。它不提供瀏覽器 API；公開 HTTP、CORS、IP 限流、使用者驗證與用戶端快取應留在呼叫端服務。

核心保留查核所需的安全與領域行為：輸入與網址驗證、URL SSRF 防護、OpenRouter 安全分類、Cofacts 候選／證據、Workers AI 語意初篩與證據綜整。回應沿用既有的事實查核結果契約。

## Service Binding 契約

唯一查核端點是 `POST /fact-check`，內容為 JSON：

```json
{ "text": "待查核主張", "url": "https://example.org/optional-context" }
```

`GET /health` 僅供內部健康檢查。每個回應都有 `X-Request-Id`，且一律 `Cache-Control: no-store`。

在 `fact-check-api` 的 `wrangler.jsonc` 新增 binding：

```jsonc
{
  "services": [
    { "binding": "FACT_CHECK_CORE", "service": "fact-check-core" }
  ]
}
```

呼叫端以 Service Binding 轉送已通過其公開層檢查的 request：

```ts
const response = await env.FACT_CHECK_CORE.fetch(
  new Request("https://fact-check-core/fact-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, url }),
  }),
);
```

`workers_dev: false` 表示部署時不建立 `workers.dev` 公開網址；請勿為這個 Worker 配置公開 route。Service Binding 不需要額外 shared secret，Cloudflare 會限制為已配置 binding 的 Worker 才能呼叫。

## 設定

在 Cloudflare 將 `OPENROUTER_API_KEY` 設為 secret；Workers AI 綁定名稱為 `AI`。本機可從 `.dev.vars.example` 複製建立 `.dev.vars`，但不可提交真實金鑰。
