# AGENTS.md

`fact-check-core` 是一個 Cloudflare Worker，只透過 Service Binding 供 `fact-check-api` 呼叫，負責事實查核的核心邏輯。它**不是**面向瀏覽器的服務。

---

## 1. 指令與驗收流程

本專案用 `vp`（Vite+）跑 script，比 npm 快：

```bash
vp install              # 安裝依賴
vp run typecheck        # tsc --noEmit
vp run test             # node --import tsx --test tests/*.test.ts
vp run dev:remote       # wrangler dev --remote（連 Cloudflare 遠端資源）
vp run deploy           # wrangler deploy
vp run cf-typegen       # wrangler types，產生 worker-configuration.d.ts（已 gitignore）
```

只跑單一測試檔時直接用 Node 的 test runner：

```bash
node --import tsx --test tests/cache.test.ts
```

注意：`vp test`、`vp check`、`vp lint` 是 Vite+ 的內建指令，本專案**沒有**採用（跑 `vp run typecheck` 會看到 `This project does not use vite-plus` 的提示，屬正常）。測試一律走 `vp run test`，也就是 package.json 裡的 `node --import tsx --test`，不是 vitest。

**驗收標準：任何修改完成後，必須跑過 `vp run typecheck` 與 `vp run test`，兩者皆綠才算完成。**
測試不打真實網路，全部靠 `tests/helpers.ts` 的 `createHarness()` 注入假的 `fetcher` 與 `AI` binding。

CI（`.github/workflows/test.yml`）使用 `npm ci` + `npm test`，因此 `package.json` 的 script 定義必須維持能被 npm 直接執行，不可依賴 vp 專屬語法。

本機祕密放在 `.dev.vars`（已 gitignore，**絕不可提交**），範本見 `.dev.vars.example`。線上 `OPENROUTER_API_KEY` 以 Cloudflare secret 設定。

---

## 2. 架構與查核管線地圖

### 請求進出

`POST /fact-check`，body 為 `{ text, url? }`；`GET /health` 供內部健康檢查。
每個回應都帶 `X-Request-Id` 與 `Cache-Control: no-store`；查核成功另帶 `X-Fact-Check-Cache: HIT|MISS|BYPASS`（同值也寫在 `meta.cache.status`）。

### 管線（`src/fact-check.ts`）

```
parseInput
   ↓
moderation              OpenRouter · MODELS.moderation
   ↓ decision === "block" → 直接回 status: "blocked"，不跑下游
cofacts-search ─┬─ url（Promise.allSettled，兩者並行）
   ↓            └─ fetchUrlContext（僅當有帶 url）
relevance               Workers AI · MODELS.relevance（語意初篩）
   ↓
cofacts-evidence        p-limit 併發上限 LIMITS.cofactsEvidenceConcurrency
   ↓
synthesis               Workers AI · MODELS.synthesis → factuality / confidence / verdict / feedback
```

### 各階段失敗行為（改動時務必維持）

| 階段 | 失敗處理 |
| --- | --- |
| `moderation` | 記 warning，降級為 `decision: "skipped"` 繼續；但缺 `OPENROUTER_API_KEY`（`configError`）直接拋錯 |
| `cofacts-search` | **硬失敗**，拋 `UPSTREAM_UNAVAILABLE` |
| `url` | 記 warning，捨棄 URL context 繼續 |
| `relevance` | 記 warning，退回「全部候選都算相關」 |
| `cofacts-evidence` | 單篇失敗記一筆帶 `article_id` 的 warning，其餘照跑 |
| `synthesis` | **硬失敗**，拋 `UPSTREAM_UNAVAILABLE` |

`status` 由 warning 決定：無 warning 為 `completed`，有 warning 為 `partial`，被擋為 `blocked`。

### 檔案職責

| 路徑 | 職責 |
| --- | --- |
| `src/index.ts` | Worker entry：路由、method/content-type 檢查、錯誤轉 JSON、公開的 library exports |
| `src/config.ts` | `MODELS`、`RESULT_CACHE`、`LIMITS` — **所有常數的唯一來源** |
| `src/contracts.ts` | 對外型別契約：`FactCheckInput`、`FactCheckResult`、`Verdict`、`Env`、`AiBinding` |
| `src/fact-check.ts` | 管線編排、warning 累積、`meta` 組裝 |
| `src/cache.ts` | Cache API 包裝、快取鍵、快取條目的嚴格再驗證 |
| `src/input.ts` | 輸入解析、`validatePublicUrl`、`isPublicIp`、`safeSourceUrl` |
| `src/url-context.ts` | URL 抓取：DoH 預檢、手動 redirect、HTMLRewriter 抽文字、機構白名單 |
| `src/http.ts` | `withTimeout`、`readText`（串流大小上限）、`fetchJson`、`HttpError` 家族 |
| `src/errors.ts` | `ApiError` 與四個 factory；錯誤碼對應 HTTP status |
| `src/logging.ts` | `Logger` 型別與 `createStageRunner`（階段計時） |
| `src/validation.ts` | valibot 包裝：`parseRecord`、`parseText`、`textSchema` |
| `src/services/*` | `moderation`、`relevance`、`synthesis`、`cofacts`、`model-output`（模型輸出解析）、`types` |
| `src/prompts/*` | 三支 system prompt，純字串常數 |

### 快取（`src/cache.ts`）

named cache `fact-check-results`，TTL 1 小時。
快取鍵 = SHA-256(`RESULT_CACHE.version` + `MODELS` + `LIMITS` + 三支 prompt + 正規化後的 `text`/`url`)，所以動到 model、prompt、limit 會自動換鍵。
**只有 `status === "completed"` 且零 warning 的結果才寫入。** 讀回時 `parseCacheEntry()` 會重跑一輪完整驗證（版本、TTL、證據狀態一致性、無證據時 confidence 上限），任何不符就當 miss。快取層任何錯誤都安全降級成完整查核，不會讓請求失敗。

### 證據可信度階層

`Evidence.reliability`：`human-community`（Cofacts 人工）> `allowlisted-institution`（`gov.tw` / `edu.tw` / `https://tfc-taiwan.org.tw`）> `ai-generated`（Cofacts AI）> `user-provided`。
沒有可用證據時（`meta.no_relevant_evidence`），`parseSynthesis` 會把 `confidence` 壓到 `0.5` 以下，且不把證據送進模型。一般使用者網址**不能單獨當證據**；只有白名單機構網址可以。

---

## 3. 硬性規則與禁止事項

### 不要加公開層功能

CORS、IP 限流、每日用量預算、使用者驗證、API key 驗證——**全部屬於 `fact-check-api`，不屬於這裡。**
`wrangler.jsonc` 的 `workers_dev: false` 與 `preview_urls: false` 必須保持，也不要為這個 Worker 設定公開 route。Service Binding 本身就是存取控制。看到「順手加個 CORS header」的衝動請忍住。

### 改契約要遞增 `RESULT_CACHE.version`

`src/config.ts` 目前是 `v7`。只要改動查核邏輯或回應契約（`FactCheckResult` 的欄位、判定規則、證據挑選方式……），就必須遞增這個版本號，否則會讀到舊格式的快取結果。
（model、prompt、`LIMITS` 的改動已自動納入快取鍵，不需另外遞增。）

### 不可放寬 SSRF 防護

`src/input.ts` 與 `src/url-context.ts` 的以下機制是安全契約，不是風格選擇：

- `validatePublicUrl()`：只收 http/https、拒絕帶帳密的 URL、拒絕私有／保留 IP（`ipaddr.js` 的 `range() === "unicast"`，fail closed）、拒絕 `.localhost`/`.internal`/`.lan` 等內部尾綴
- `assertPublicDns()`：抓取前先用 DoH（`cloudflare-dns.com`）解析 A/AAAA，任一位址非公網就中止
- `redirect: "manual"` + 自行逐跳驗證，上限 `LIMITS.redirects`，並偵測重導循環
- 回應限制：只收 `text/html` / `text/plain`、charset 限 utf-8/us-ascii、大小上限 `LIMITS.urlBytes`

`tests/parity.test.ts` 只對其中一項有斷言（`assert.equal(init?.redirect, "manual")`）——其餘三項沒有測試網保護，改動時請自行確認不會打開內網存取面。

### 其他不要動的東西

- `factCheck()` 第三參數的 `options | Fetcher` union 是刻意保留的向下相容（原始碼有註解），不要「整理掉」
- 三支 prompt 都內含 prompt injection 防護（明示使用者內容為資料而非指令），修改時務必保留
- `ApiError` 的 constructor 是 private，一律用 `invalidInput()` / `payloadTooLarge()` / `upstreamUnavailable()` / `internalError()` 建立

---

## 4. 程式風格慣例

- **所有不可信資料一律先驗證。** 上游回應（Cofacts、OpenRouter、DoH）、模型輸出、快取條目，都要經過 `src/validation.ts` 的 `parseRecord()` / `parseText()`，不要直接 `as` 斷言。模型輸出走 `services/model-output.ts` 的 `parseModelJson()`（會處理 ```json 圍欄與 `finish_reason`）。
- **常數集中在 `src/config.ts`。** 不要在各檔案散落 magic number；新增上限請加進 `LIMITS`（它同時是快取鍵的一部分）。
- **繁體中文使用者可見訊息。** 錯誤訊息、prompt、feedback 一律繁中；程式註解也用繁中，且只在「為什麼這樣寫」不明顯時才寫。
- **結構化 JSON log。** 一律 `log({ event, request_id, ... })`，值受 `LogValue` 型別限制。**不要 log 使用者主張原文或任何祕密**——現有 log 只記長度、ID、分數、布林旗標，請照這個模式。跨階段計時用 `createStageRunner()`。
- **逾時與大小上限是必要的，不是選配。** 所有外部呼叫走 `withTimeout()`，所有 response body 走 `readText(body, maxBytes, signal)`，不要直接 `await response.text()`。
- **錯誤分類**：`HttpError`（傳輸層）、`ModelOutputError`（模型輸出）在 service 內部轉成 `ApiError`，由 `src/index.ts` 統一轉成 JSON 回應。
- `Env` 是手寫在 `src/contracts.ts`，不依賴 `worker-configuration.d.ts`（那個檔案 gitignore，由 `vp run cf-typegen` 產生）。
- 測試用 Node 內建 test runner + `tsx`，沒有 vitest/jest。新測試放 `tests/*.test.ts`，共用 harness 放 `tests/helpers.ts`。
