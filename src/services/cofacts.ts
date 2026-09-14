import { LIMITS } from "../config";
import { upstreamUnavailable } from "../errors";
import { fetchJson, type Fetcher } from "../http";
import { asRecord, safeSourceUrl, text } from "../input";
import type { Candidate, Evidence } from "./types";

async function queryCofacts(query: string, variables: Record<string, string>, fetcher: Fetcher) {
  const output = asRecord(
    await fetchJson(fetcher, "https://api.cofacts.tw/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
  );
  if (Array.isArray(output.errors) && output.errors.length) throw new Error("Cofacts 查詢失敗");
  return asRecord(output.data);
}

export async function searchCofactsCandidates(claim: string, fetcher: Fetcher): Promise<Candidate[]> {
  const query = `query Search($text: String!) { ListArticles(filter: { moreLikeThis: { like: $text, minimumShouldMatch: "30%" } }, orderBy: [{ _score: DESC }], first: ${LIMITS.candidates}) { edges { score node { id text } } } }`;
  try {
    const root = asRecord((await queryCofacts(query, { text: claim }, fetcher)).ListArticles);
    const seen = new Set<string>();
    return (Array.isArray(root.edges) ? root.edges : [])
      .slice(0, LIMITS.candidates)
      .flatMap((raw): Candidate[] => {
        const edge = asRecord(raw);
        const node = asRecord(edge.node);
        const articleId = text(node.id, 200);
        const candidateText = typeof node.text === "string" ? node.text.trim() : "";
        if (!candidateText) return [];
        if (seen.has(articleId)) throw new Error("重複文章 ID");
        seen.add(articleId);
        return [{ articleId, text: candidateText, searchScore: typeof edge.score === "number" && Number.isFinite(edge.score) ? edge.score : null }];
      });
  } catch {
    throw upstreamUnavailable("cofacts-search");
  }
}

const replyVerdicts: Record<string, string> = {
  NOT_RUMOR: "supports",
  RUMOR: "refutes",
  OPINIONATED: "opinion",
  NOT_ARTICLE: "unknown",
};

async function getArticleEvidence(candidate: Candidate, fetcher: Fetcher): Promise<Evidence[]> {
  const query = `query GetEvidence($id: String!) { GetArticle(id: $id) { id text articleReplies(statuses: [NORMAL]) { positiveFeedbackCount negativeFeedbackCount reply { text type reference hyperlinks { url normalizedUrl } } } aiReplies { status text } } }`;
  const article = asRecord((await queryCofacts(query, { id: candidate.articleId }, fetcher)).GetArticle);
  if (article.id !== candidate.articleId) throw new Error("文章 ID 不符");
  const common = {
    articleId: candidate.articleId,
    articleText: typeof article.text === "string" ? article.text.slice(0, LIMITS.evidenceText) : candidate.text.slice(0, LIMITS.evidenceText),
    cofactsUrl: `https://cofacts.tw/article/${encodeURIComponent(candidate.articleId)}`,
    ...(candidate.searchScore === null ? {} : { retrievalScore: candidate.searchScore }),
    ...(candidate.relevanceScore === undefined ? {} : { relevanceScore: candidate.relevanceScore }),
  };
  const evidence: Evidence[] = [];
  for (const raw of (Array.isArray(article.articleReplies) ? article.articleReplies : []).slice(0, LIMITS.repliesPerArticle)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const link = asRecord(raw);
    if (!link.reply || typeof link.reply !== "object" || Array.isArray(link.reply)) continue;
    const reply = asRecord(link.reply);
    const replyText = typeof reply.text === "string" ? reply.text.trim() : "";
    if (!replyText || !(String(reply.type) in replyVerdicts)) continue;
    const urls = (Array.isArray(reply.hyperlinks) ? reply.hyperlinks : []).flatMap((link): string[] => {
      const value = asRecord(link);
      const url = safeSourceUrl(value.normalizedUrl) ?? safeSourceUrl(value.url);
      return url ? [url] : [];
    });
    evidence.push({
      ...common,
      source: "cofacts-human",
      reliability: "human-community",
      text: replyText.slice(0, LIMITS.evidenceText),
      classification: String(reply.type),
      verdict: replyVerdicts[String(reply.type)],
      referenceText: typeof reply.reference === "string" ? reply.reference.slice(0, LIMITS.evidenceText) : undefined,
      sourceUrls: [...new Set(urls)].slice(0, 20),
      sourceUrl: urls[0],
    });
  }
  for (const raw of (Array.isArray(article.aiReplies) ? article.aiReplies : []).slice(0, LIMITS.repliesPerArticle)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const reply = asRecord(raw);
    if (reply.status === "SUCCESS" && typeof reply.text === "string" && reply.text.trim()) {
      evidence.push({ ...common, source: "cofacts-ai", reliability: "ai-generated", text: reply.text.trim().slice(0, LIMITS.evidenceText) });
    }
  }
  return evidence;
}

export async function getCofactsEvidence(candidates: Candidate[], fetcher: Fetcher) {
  const results = await Promise.allSettled(candidates.map((candidate) => getArticleEvidence(candidate, fetcher)));
  const evidence: Evidence[] = [];
  const failedArticleIds: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") evidence.push(...result.value);
    else failedArticleIds.push(candidates[index].articleId);
  });
  return { evidence, failedArticleIds };
}
