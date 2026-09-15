import type { Env, FactCheckInput, FactCheckResult, Moderation, RelatedCheck, Warning } from "./contracts";
import { ApiError } from "./errors";
import type { Fetcher } from "./http";
import { fetchUrlContext, type UrlContext } from "./url-context";
import { getCofactsEvidence, searchCofactsCandidates } from "./services/cofacts";
import { moderate } from "./services/moderation";
import { selectRelevant } from "./services/relevance";
import { synthesize } from "./services/synthesis";
import type { Candidate, Evidence } from "./services/types";

export type Logger = (event: Record<string, unknown>) => void;

export type FactCheckOptions = {
  requestId?: string;
  fetcher?: Fetcher;
  log?: Logger;
};

export async function factCheck(
  input: FactCheckInput,
  env: Env,
  options: FactCheckOptions | Fetcher = {},
): Promise<FactCheckResult> {
  // 向下相容既有第三參數直接傳 fetcher 的呼叫方式。
  const normalizedOptions = typeof options === "function" ? { fetcher: options } : options;
  const requestId = normalizedOptions.requestId ?? crypto.randomUUID();
  const fetcher = normalizedOptions.fetcher ?? fetch;
  const log: Logger = normalizedOptions.log ?? ((event) => console.info(JSON.stringify(event)));
  const warnings: Warning[] = [];
  const meta: FactCheckResult["meta"] = {
    request_id: requestId,
    cofacts_candidates: 0,
    cofacts_relevant: 0,
    cofacts_human_checks: 0,
    cofacts_ai_checks: 0,
    url_context_used: false,
    url_context_allowlisted: false,
    no_relevant_evidence: false,
    warnings,
  };
  log({ event: "request", request_id: requestId, text_length: [...input.text].length, has_url: Boolean(input.url) });

  let moderation: Moderation;
  try {
    moderation = await moderate(input.text, env, fetcher);
  } catch (error) {
    // 缺少金鑰是部署設定問題，不能靜默跳過安全分類。
    if (error instanceof ApiError && !env.OPENROUTER_API_KEY?.trim()) throw error;
    moderation = { decision: "skipped", categories: [], reason: "安全分類服務暫時無法使用，本次未執行安全檢查。" };
    warnings.push({ stage: "moderation", code: "UPSTREAM_UNAVAILABLE" });
  }
  if (moderation.decision === "block") {
    return {
      ...input,
      status: "blocked",
      moderation,
      factuality: null,
      confidence: null,
      verdict: null,
      related_checks: [],
      feedback: "此內容未通過安全檢查，已停止查核。",
      meta,
    };
  }

  const [search, url] = await Promise.allSettled([
    searchCofactsCandidates(input.text, fetcher),
    input.url ? fetchUrlContext(input.url, fetcher) : Promise.resolve(null),
  ]);
  if (search.status === "rejected") throw search.reason;
  const urlContext: UrlContext | null = url.status === "fulfilled" ? url.value : null;
  if (url.status === "rejected") warnings.push({ stage: "url", code: "UPSTREAM_UNAVAILABLE" });
  meta.url_context_used = Boolean(urlContext);
  meta.url_context_allowlisted = urlContext?.reliability === "allowlisted-institution";

  const candidates = search.value;
  meta.cofacts_candidates = candidates.length;
  let selected: Candidate[];
  try {
    selected = await selectRelevant(input.text, candidates, env);
  } catch {
    // 相關性服務只負責排除候選；故障時保留全部候選，避免漏掉證據。
    selected = candidates;
    if (candidates.length) warnings.push({ stage: "relevance", code: "UPSTREAM_UNAVAILABLE" });
  }
  meta.cofacts_relevant = selected.length;

  const details = await getCofactsEvidence(selected, fetcher);
  details.failedArticleIds.forEach((articleId) => {
    warnings.push({ stage: "cofacts-evidence", code: "UPSTREAM_UNAVAILABLE", article_id: articleId });
  });
  const evidence: Evidence[] = [...details.evidence];
  if (urlContext) {
    evidence.push({
      source: "provided-url",
      reliability: urlContext.reliability,
      text: urlContext.evidenceText,
      sourceUrl: urlContext.sourceUrl,
    });
  }
  meta.cofacts_human_checks = evidence.filter((item) => item.source === "cofacts-human").length;
  meta.cofacts_ai_checks = evidence.filter((item) => item.source === "cofacts-ai").length;

  const result = await synthesize(input, moderation, evidence, env);
  meta.no_relevant_evidence = !result.hasEvidence;
  const related_checks: RelatedCheck[] = evidence
    .filter((item) => item.source !== "provided-url")
    .map((item) => ({
      type: item.source === "cofacts-human" ? "cofacts_human" : "cofacts_ai",
      text: item.text,
      url: item.cofactsUrl!,
      reference_url: item.sourceUrl,
      reference_urls: item.sourceUrls,
      classification: item.classification,
      retrieval_score: item.retrievalScore,
      relevance_score: item.relevanceScore,
    }));
  const status = warnings.length ? "partial" : "completed";
  log({ event: "result", request_id: requestId, status, verdict: result.verdict });
  return {
    ...input,
    status,
    moderation,
    factuality: result.factuality,
    confidence: result.confidence,
    verdict: result.verdict,
    feedback: result.feedback,
    related_checks,
    meta,
  };
}
