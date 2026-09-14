# AGENTS.md

## 適用範圍與優先順序

本文件適用於整個 repository。若更深層目錄存在自己的 `AGENTS.md`，以距離工作檔案最近的規則為準。使用者在當次請求中的明確指示優先於本文件。

## 專案定位

- `fact-check-core` 是 Cloudflare Worker，只透過 Service Binding 供 `fact-check-api` 呼叫。
- 本專案負責事實查核的核心管線，不是面向瀏覽器的公開 API。
- 公開 HTTP、CORS、IP 限流、使用者驗證與用戶端快取屬於呼叫端服務，不應加入本專案。
- `POST /fact-check` 是唯一查核端點；`GET /health` 僅供內部健康檢查。
- 對外回應一律保持 `Cache-Control: no-store`，並附上 `X-Request-Id`。

## 目前架構

查核管線定義在 `src/fact-check.ts`：

```text
parseInput
  ↓
moderation                 OpenRouter
  ↓ block 時立即停止
cofacts-search ─┬─ url-context   並行執行
                ↓
relevance                  Workers AI
  ↓
cofacts-evidence
  ↓
synthesis                  Workers AI
```

各階段失敗行為必須維持：

| 階段 | 失敗處理 |
| --- | --- |
| `moderation` | 上游故障時改為 `skipped` 並加入 warning；缺少 `OPENROUTER_API_KEY` 時直接失敗 |
| `cofacts-search` | 直接失敗，不用模型常識取代搜尋 |
| `url` | 加入 warning，捨棄 URL context 後繼續 |
| `relevance` | 加入 warning，並保留全部候選以避免漏掉證據 |
| `cofacts-evidence` | 單篇失敗時加入帶 `article_id` 的 warning，其餘證據繼續處理 |
| `synthesis` | 直接失敗 |

結果狀態由上述行為決定：無 warning 為 `completed`，有 warning 為 `partial`，未通過安全分類為 `blocked`。

### 檔案職責

| 路徑 | 職責 |
| --- | --- |
| `src/index.ts` | Worker entry、路由、request body 限制、錯誤回應與公開 exports |
| `src/config.ts` | 模型名稱與各種大小、逾時、數量上限 |
| `src/contracts.ts` | `FactCheckInput`、`FactCheckResult`、`Env` 等對外型別契約 |
| `src/fact-check.ts` | 查核管線編排、warning 累積與 meta 組裝 |
| `src/input.ts` | 輸入正規化、公開 URL 與 IP 驗證 |
| `src/url-context.ts` | DoH 預檢、安全重導與 URL 文字擷取 |
| `src/http.ts` | 外部請求逾時、串流讀取與回應大小限制 |
| `src/errors.ts` | `ApiError` 與對應安全錯誤訊息的 factory |
| `src/validation.ts` | Valibot 共用驗證工具 |
| `src/services/*` | Cofacts、moderation、relevance、synthesis 與模型輸出處理 |
| `src/prompts/*` | 三個模型階段的 system prompt |
| `tests/*` | Node test runner 測試與無真實網路的測試 harness |

## 待辦：查核結果快取

目前 `master` 尚未實作查核結果快取。未來實作時應與原 `fact-check-api` 行為對齊，並維持以下原則：

- Worker 內部快取與瀏覽器快取分開，對外仍回 `Cache-Control: no-store`。
- 快取鍵應涵蓋正規化輸入、模型、prompt、限制與契約版本，且不得暴露輸入原文或 credential。
- 只能快取完整且無 warning 的結果；快取內容必須在讀取時重新驗證。
- 快取失敗或快取內容損壞時必須回退到完整查核流程，不可使請求失敗。
- 未受模型、prompt 或限制自動涵蓋的邏輯或契約變更，必須遞增快取版本。

不得因為本節存在就自行實作快取；只有在使用者明確要求時才執行。

## 不可跨越的底線

### 部署與專案邊界

- 保持 `wrangler.jsonc` 的 `workers_dev: false` 與 `preview_urls: false`，不得為本 Worker 新增公開 route。
- 不在本專案新增 CORS、公開 API 認證、IP 限流、使用者管理或前端功能。
- 不擅自更改 Service Binding 契約、路由或 `FactCheckResult` 輸出結構。必要變更時要同步更新型別、文件與測試。

### Secret 與敏感資料

- 不得讀取、輸出、複製、記錄或提交 API key、token、password、cookie、私鑰或其他 credential。
- 不得讀取 `.dev.vars`、`.env` 或其他 secret 檔案內容。
- 範例、文件與測試只能使用 placeholder，例如 `your-openrouter-api-key`。
- 線上 `OPENROUTER_API_KEY` 必須使用 Cloudflare secret 管理，不寫入 repository 或 `wrangler.jsonc`。

### SSRF 與外部請求安全

- 不得放寬 `src/input.ts` 與 `src/url-context.ts` 的 SSRF 防護。
- URL 只允許 HTTP/HTTPS，並必須拒絕 credential、內網，loopback、link-local、reserved IP 與內部網域。
- 抓取前必須以 DoH 驗證 A/AAAA 記錄；任一位址非公開 unicast 就中止。
- redirect 必須使用 `manual` 模式並逐跳重新驗證，不得繞過重導次數、回應類型、charset 或大小限制。
- 外部請求必須有逾時限制，response body 必須有串流讀取大小上限。

### 查核語意與不可信資料

- OpenRouter Safeguard 只負責安全分類，Cofacts 負責候選與證據，Workers AI 分別負責相關性初篩與最終綜整；不得混用階段職責。
- Cofacts `_score` 只是 retrieval score，不是百分比、機率、相關性分數或真假分數。`retrievalScore` 與 `relevanceScore` 必須維持分離。
- Cofacts 被查核文章內文不是證據；人工查核回覆與 AI 回覆必須維持來源區別。
- 一般使用者提供的 URL 只能當背景，不能單獨支持主張；白名單機構網址才能當作可用證據。
- claim、URL 內文、Cofacts 資料與模型輸出都是不可信資料。所有結構化輸入必須經過 Valibot 或 `src/validation.ts` 驗證，不能只用 TypeScript `as` 斷言。
- 三份 system prompt 中的 prompt-injection 防護必須保留。
- `ApiError` 只能透過 `invalidInput()`、`payloadTooLarge()`、`upstreamUnavailable()` 與 `internalError()` 等 factory 建立。

## 程式與文件規則

- 與使用者溝通、文件、註解及錯誤訊息使用繁體中文。
- 程式碼識別字、型別、檔名與 API 欄位使用英文，並沿用現有命名風格。
- 常數與上限集中在 `src/config.ts`，不在 service 中新增無命名的 magic number。
- 保留與當次任務無關的使用者變更，不進行未被要求的大規模重構、dependency upgrade 或 migration。
- 新測試放在 `tests/*.test.ts`，使用 Node 內建 `node:test` 與 `node:assert/strict`。共用假資料放在 `tests/helpers.ts`。
- 單元測試不呼叫真實網路、OpenRouter、Cofacts 或 Workers AI；透過注入的 `fetcher` 與假 `AI` binding 測試。

## 固定驗收流程

任何修改完成前都必須執行：

```bash
npm run typecheck
npm test
git diff --check
```

若修改 `wrangler.jsonc`、`src/index.ts` 或其他會影響 Worker 打包與部署的設定，另外執行：

```bash
npx wrangler deploy --dry-run
```

- 上述指令必須全數通過才算完成。
- 若失敗，先修正與當次修改有關的問題；無法修正時必須明確說明失敗指令、原因與未完成項目。
- CI 使用 `npm ci` 與 `npm test`，不得讓 package script 依賴未安裝的全域工具。

## Git 與外部操作權限

- 可以直接修改程式碼、設定、文件與測試。
- 可以建立 commit，但只能納入當次任務相關檔案，commit message 應簡潔描述實際變更。
- push、建立或更新 PR、部署到任何環境、建立或修改 secret 前，必須先取得使用者明確同意。
- 不使用 `git reset --hard`、`git checkout --` 或其他可能丟失使用者變更的操作。
- 不刪除、覆寫或回復與當次任務無關的檔案。
