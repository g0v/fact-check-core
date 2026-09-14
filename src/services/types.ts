export type Candidate = {
  articleId: string;
  text: string;
  searchScore: number | null;
};

export type RelevanceResult = {
  articleId: string;
  relevant: boolean;
  relevance: number;
  reason: string;
};

export type RelevantCandidate = Candidate & {
  relevanceScore?: number;
  relevanceReason?: string;
};

export type Evidence = {
  source: "cofacts-human" | "cofacts-ai" | "provided-url";
  articleId?: string;
  articleText?: string;
  evidenceText: string;
  verdict?: "supports" | "refutes" | "mixed" | "opinion" | "unknown";
  classification?: string;
  referenceText?: string;
  sourceUrl?: string;
  sourceUrls?: string[];
  articleReferences?: string[];
  cofactsUrl?: string;
  retrievalScore?: number;
  relevanceScore?: number;
  positiveFeedback?: number;
  negativeFeedback?: number;
  reliability: "human-community" | "ai-generated" | "user-provided" | "allowlisted-institution";
};
