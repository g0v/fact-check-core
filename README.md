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

在 Cloudflare 將 `OPENROUTER_API_KEY` 設為 secret；Workers AI 綁定名稱為 `AI`。本機可從 `.dev.vars.example` 複製建立 `.dev.vars`，但不可在git版本控制中，提交真實金鑰。

## 近端開發流程

請先安裝 Node.js，並完成 Cloudflare 登入。接著在專案根目錄執行：

```bash
# 安裝依賴
npm install

# 執行型別檢查與測試
npm run typecheck
npm run test

# 啟動使用 Cloudflare 遠端資源的本機開發伺服器
npm run dev:remote
```

`dev:remote` 會執行 `wrangler dev --remote`。啟動後依終端機顯示的網址測試 Worker；需要本機密碼時，請在專案根目錄建立 `.dev.vars`，填入 `OPENROUTER_API_KEY`，且不要將該檔案提交至版本庫。

確認變更可用後部署：

```bash
vp run deploy
```

部署前建議再次執行 `vp run typecheck` 與 `vp run test`。部署需要具備對應 Cloudflare 帳號與 Worker 權限，且會更新 `fact-check-core` 的線上版本。
