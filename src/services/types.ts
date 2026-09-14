export type Candidate = {
  articleId: string;
  text: string;
  searchScore: number | null;
  relevanceScore?: number;
};

export type Evidence = {
  source: "cofacts-human" | "cofacts-ai" | "provided-url";
  reliability: "human-community" | "ai-generated" | "user-provided" | "allowlisted-institution";
  text: string;
  articleId?: string;
  articleText?: string;
  cofactsUrl?: string;
  referenceText?: string;
  sourceUrls?: string[];
  sourceUrl?: string;
  classification?: string;
  verdict?: string;
  retrievalScore?: number;
  relevanceScore?: number;
};
