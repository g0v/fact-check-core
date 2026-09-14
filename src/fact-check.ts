import { LIMITS } from "./config";
import type { Env, FactCheckInput, FactCheckResult, Moderation, RelatedCheck, Warning } from "./contracts";
import { ApiError, upstreamUnavailable, type ApiErrorStage } from "./errors";
import type { Fetcher } from "./http";
import { createStageRunner, type Logger } from "./logging";
import { getCofactsEvidence, searchCofactsCandidates } from "./services/cofacts";
import { moderate } from "./services/moderation";
import { filterRelevantCandidates } from "./services/relevance";
import { synthesize } from "./services/synthesis";
import type { Candidate, Evidence, RelevantCandidate } from "./services/types";
import { fetchUrlContext } from "./url-context";

export async function factCheck(
  input: FactCheckInput,
  env: Env,
  options: { requestId?: string; fetcher?: Fetcher; log?: Logger } | Fetcher = {},
): Promise<FactCheckResult> {
  // 向下相容舊有第三參數直接傳 fetcher 的呼叫方式。
  const normalizedOptions = typeof options === "function" ? { fetcher: options } : options;
  const requestId = normalizedOptions.requestId ?? crypto.randomUUID();
  const fetcher = normalizedOptions.fetcher ?? fetch;
  const log: Logger = normalizedOptions.log ?? ((event) => console.info(JSON.stringify(event)));
  const stage = createStageRunner(requestId, log);
  const warnings: Warning[] = [];
  const warn = (name: Exclude<ApiErrorStage, "synthesis">, articleId?: string) => {
    warnings.push({
      stage: name,
      code: "UPSTREAM_UNAVAILABLE",
      ...(articleId ? { article_id: articleId } : {}),
    });
  };
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
  log({
    event: "request",
    request_id: requestId,
    text_length: [...input.text].length,
    has_url: Boolean(input.url),
    openrouter_api_key_present: env.OPENROUTER_API_KEY != null,
  });

  let moderation: Moderation;
  try {
    moderation = await stage("moderation", () =>
      moderate(input.text, env, fetcher, (event) => log({ ...event, request_id: requestId })),
    );
  } catch (error) {
    if (error instanceof ApiError && error.configError) throw error;
    warn("moderation");
    moderation = {
      decision: "skipped",
      categories: [],
      reason: "安全分類服務暫時無法使用，本次未執行安全檢查。",
    };
  }
  log({ event: "moderation", request_id: requestId, decision: moderation.decision });
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

  const [searchResult, urlResult] = await Promise.allSettled([
    stage("cofacts-search", () => searchCofactsCandidates(input.text, fetcher)),
    input.url ? stage("url", () => fetchUrlContext(input.url!, fetcher)) : Promise.resolve(null),
  ]);
  const urlContext = urlResult.status === "fulfilled" ? urlResult.value : null;
  if (urlResult.status === "rejected") warn("url");
  meta.url_context_used = Boolean(urlContext);
  meta.url_context_allowlisted = urlContext?.reliability === "allowlisted-institution";
  let candidates: Candidate[] = [];
  if (searchResult.status === "fulfilled") candidates = searchResult.value;
  else throw upstreamUnavailable("cofacts-search", searchResult.reason);
  meta.cofacts_candidates = candidates.length;
  log({
    event: "candidates",
    request_id: requestId,
    count: candidates.length,
    article_ids: candidates.map((item) => item.articleId),
    retrieval_scores: candidates.map((item) => item.searchScore),
  });

  let selected: RelevantCandidate[] = [];
  if (candidates.length) {
    try {
      const relevance = await stage("relevance", () =>
        filterRelevantCandidates(
          input.text,
          candidates,
          env,
          (event) => log({ ...event, request_id: requestId }),
        ),
      );
      selected = relevance.selected;
      log({
        event: "relevance",
        request_id: requestId,
        candidate_count: candidates.length,
        article_ids: relevance.results.map((item) => item.articleId),
        relevant_flags: relevance.results.map((item) => item.relevant),
        relevance_scores: relevance.results.map((item) => item.relevance),
        relevance_threshold: LIMITS.relevanceThreshold,
        selection_limit: LIMITS.relevant,
        selected_count: selected.length,
        selected_article_ids: selected.map((item) => item.articleId),
      });
    } catch {
      warn("relevance");
      selected = candidates.map((candidate) => ({ ...candidate }));
      log({
        event: "relevance_fallback",
        request_id: requestId,
        candidate_count: candidates.length,
        article_ids: candidates.map((item) => item.articleId),
        selected_count: selected.length,
      });
    }
  }
  meta.cofacts_relevant = selected.length;

  const details = selected.length
    ? await stage("cofacts-evidence", () => getCofactsEvidence(selected, fetcher))
    : { evidence: [], failedArticleIds: [] };
  details.failedArticleIds.forEach((articleId) => warn("cofacts-evidence", articleId));
  const evidence: Evidence[] = [...details.evidence, ...(urlContext ? [urlContext] : [])];
  meta.cofacts_human_checks = details.evidence.filter((item) => item.source === "cofacts-human").length;
  meta.cofacts_ai_checks = details.evidence.filter((item) => item.source === "cofacts-ai").length;
  meta.no_relevant_evidence =
    details.evidence.length === 0 && urlContext?.reliability !== "allowlisted-institution";
  log({
    event: "evidence",
    request_id: requestId,
    human_count: meta.cofacts_human_checks,
    ai_count: meta.cofacts_ai_checks,
    has_url_context: Boolean(urlContext),
    url_context_allowlisted: meta.url_context_allowlisted,
    no_relevant_evidence: meta.no_relevant_evidence,
  });

  const result = await stage("synthesis", () =>
    synthesize(input, moderation, evidence, env, (event) => log({ ...event, request_id: requestId })),
  );
  const relatedChecks: RelatedCheck[] = details.evidence.map((item) => ({
    type: item.source === "cofacts-human" ? "cofacts_human" : "cofacts_ai",
    text: item.evidenceText,
    url: item.cofactsUrl!,
    reference_url: item.sourceUrl,
    reference_urls: item.sourceUrls,
    classification: item.classification,
    retrieval_score: item.retrievalScore,
    relevance_score: item.relevanceScore,
  }));
  const status = warnings.length ? "partial" : "completed";
  log({
    event: "result",
    request_id: requestId,
    status,
    verdict: result.verdict,
    factuality: result.factuality,
    confidence: result.confidence,
  });
  return { ...input, status, moderation, ...result, related_checks: relatedChecks, meta };
}
