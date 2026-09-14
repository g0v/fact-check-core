import pLimit from "p-limit";
import { LIMITS } from "../config";
import { upstreamUnavailable } from "../errors";
import { fetchJson, type Fetcher } from "../http";
import { safeSourceUrl } from "../input";
import { parseRecord, parseText } from "../validation";
import type { Candidate, Evidence, RelevantCandidate } from "./types";

async function queryCofacts(
  query: string,
  variables: Record<string, string>,
  fetcher: Fetcher,
): Promise<Record<string, unknown>> {
  const output = parseRecord(
    await fetchJson(fetcher, "https://api.cofacts.tw/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
  );
  if (output.errors !== undefined && (!Array.isArray(output.errors) || output.errors.length)) {
    throw new Error("Cofacts 查詢失敗。");
  }
  return parseRecord(output.data);
}

export const searchQuery = `query Search($text: String!) {
  ListArticles(filter: { moreLikeThis: { like: $text, minimumShouldMatch: "30%" } },
    orderBy: [{ _score: DESC }], first: ${LIMITS.candidates}) {
    edges { score node { id text } }
  }
}`;

export async function searchCofactsCandidates(
  text: string,
  fetcher: Fetcher = fetch,
): Promise<Candidate[]> {
  try {
    const data = await queryCofacts(searchQuery, { text }, fetcher);
    const root = parseRecord(data.ListArticles);
    if (!Array.isArray(root.edges)) throw new Error("候選清單格式不正確。");
    const candidates: Candidate[] = [];
    const ids = new Set<string>();
    for (const edgeValue of root.edges.slice(0, LIMITS.candidates)) {
      const edge = parseRecord(edgeValue);
      const node = parseRecord(edge.node);
      const articleId = parseText(node.id, 200);
      if (node.text === null || node.text === "") continue;
      if (ids.has(articleId)) throw new Error("候選文章 ID 重複。");
      ids.add(articleId);
      if (typeof edge.score !== "number" && edge.score !== null) throw new Error("搜尋分數格式不正確。");
      if (typeof edge.score === "number" && !Number.isFinite(edge.score)) throw new Error("搜尋分數格式不正確。");
      candidates.push({
        articleId,
        text: parseText(node.text, 1_000_000),
        searchScore: edge.score,
      });
    }
    return candidates;
  } catch (error) {
    throw upstreamUnavailable("cofacts-search", error);
  }
}

export const evidenceQuery = `query GetEvidence($id: String!) {
  GetArticle(id: $id) {
    id text
    references { type permalink }
    articleReplies(statuses: [NORMAL]) {
      replyType positiveFeedbackCount negativeFeedbackCount
      reply { id text type reference hyperlinks { url normalizedUrl title } }
    }
    aiReplies { status text createdAt }
  }
}`;

const replyVerdicts = {
  NOT_RUMOR: "supports",
  RUMOR: "refutes",
  OPINIONATED: "opinion",
  NOT_ARTICLE: "unknown",
} as const;

function optionalText(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error("文字格式不正確。");
  return value.trim() || undefined;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("數值格式不正確。");
  return value;
}

export function normalizeCofactsEvidence(value: unknown, candidate: RelevantCandidate): Evidence[] {
  const article = parseRecord(value);
  if (article.id !== candidate.articleId) throw new Error("查核證據的文章 ID 不符。");
  const references = article.references ?? [];
  if (!Array.isArray(references)) throw new Error("文章來源格式不正確。");
  const common = {
    articleId: candidate.articleId,
    articleText: (optionalText(article.text) ?? candidate.text).slice(0, LIMITS.evidenceText),
    cofactsUrl: `https://cofacts.tw/article/${encodeURIComponent(candidate.articleId)}`,
    ...(candidate.searchScore === null ? {} : { retrievalScore: candidate.searchScore }),
    ...(candidate.relevanceScore === undefined ? {} : { relevanceScore: candidate.relevanceScore }),
    articleReferences: references
      .filter((item) => item !== null)
      .map((item) => safeSourceUrl(parseRecord(item).permalink))
      .filter((url): url is string => Boolean(url)),
  };
  if (!Array.isArray(article.articleReplies) || !Array.isArray(article.aiReplies)) {
    throw new Error("查核回覆格式不正確。");
  }
  const evidence: Evidence[] = [];
  for (const value of article.articleReplies.slice(0, LIMITS.repliesPerArticle)) {
    const link = parseRecord(value);
    if (link.reply === null) continue;
    const reply = parseRecord(link.reply);
    const text = optionalText(reply.text);
    if (!text) continue;
    if (typeof reply.type !== "string" || !(reply.type in replyVerdicts)) {
      throw new Error("查核分類格式不正確。");
    }
    const classification = reply.type as keyof typeof replyVerdicts;
    const referenceText = optionalText(reply.reference);
    const hyperlinks = reply.hyperlinks ?? [];
    if (!Array.isArray(hyperlinks)) throw new Error("查核連結格式不正確。");
    const hyperlinkUrls = hyperlinks
      .filter((item) => item !== null)
      .map((item) => {
        const hyperlink = parseRecord(item);
        return safeSourceUrl(hyperlink.normalizedUrl) ?? safeSourceUrl(hyperlink.url);
      });
    const referenceLinks = (referenceText?.match(/https?:\/\/[^\s<>"）)]+/g) ?? []).map(safeSourceUrl);
    const sourceUrls = [
      ...new Set([...referenceLinks, ...hyperlinkUrls].filter((url): url is string => Boolean(url))),
    ].slice(0, 20);
    evidence.push({
      ...common,
      source: "cofacts-human",
      reliability: "human-community",
      evidenceText: text.slice(0, LIMITS.evidenceText),
      classification,
      verdict: replyVerdicts[classification],
      referenceText: referenceText?.slice(0, LIMITS.evidenceText),
      sourceUrls,
      sourceUrl: sourceUrls[0],
      positiveFeedback: finiteNumber(link.positiveFeedbackCount),
      negativeFeedback: finiteNumber(link.negativeFeedbackCount),
    });
  }
  for (const value of article.aiReplies.slice(0, LIMITS.repliesPerArticle)) {
    const reply = parseRecord(value);
    if (reply.status !== "SUCCESS") continue;
    const text = optionalText(reply.text);
    if (!text) continue;
    parseText(reply.createdAt, 100);
    evidence.push({
      ...common,
      source: "cofacts-ai",
      reliability: "ai-generated",
      evidenceText: text.slice(0, LIMITS.evidenceText),
    });
  }
  return evidence;
}

export async function getCofactsEvidence(
  candidates: RelevantCandidate[],
  fetcher: Fetcher = fetch,
): Promise<{ evidence: Evidence[]; failedArticleIds: string[] }> {
  const limit = pLimit(LIMITS.cofactsEvidenceConcurrency);
  const results = await Promise.allSettled(
    candidates.map((candidate) =>
      limit(async () => {
        const data = await queryCofacts(evidenceQuery, { id: candidate.articleId }, fetcher);
        return normalizeCofactsEvidence(data.GetArticle, candidate);
      }),
    ),
  );
  const evidence: Evidence[] = [];
  const failedArticleIds: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") evidence.push(...result.value);
    else failedArticleIds.push(candidates[index].articleId);
  });
  return { evidence, failedArticleIds };
}
