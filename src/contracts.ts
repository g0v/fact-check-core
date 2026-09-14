export type FactCheckInput = { text: string; url?: string };

export type Verdict =
  | "supported"
  | "mostly_supported"
  | "mixed"
  | "mostly_refuted"
  | "refuted"
  | "insufficient_evidence";

export type Moderation = {
  decision: "allow" | "review" | "block" | "skipped";
  categories: string[];
  reason?: string;
};

export type Warning = {
  stage: "moderation" | "cofacts-search" | "relevance" | "cofacts-evidence" | "url";
  code: "UPSTREAM_UNAVAILABLE";
  article_id?: string;
};

export type RelatedCheck = {
  type: "cofacts_human" | "cofacts_ai";
  text: string;
  url: string;
  reference_url?: string;
  reference_urls?: string[];
  classification?: string;
  retrieval_score?: number;
  relevance_score?: number;
};

export type FactCheckResult = FactCheckInput & {
  status: "completed" | "partial" | "blocked";
  moderation: Moderation;
  factuality: number | null;
  confidence: number | null;
  verdict: Verdict | null;
  related_checks: RelatedCheck[];
  feedback: string;
  meta: {
    request_id: string;
    cofacts_candidates: number;
    cofacts_relevant: number;
    cofacts_human_checks: number;
    cofacts_ai_checks: number;
    url_context_used: boolean;
    url_context_allowlisted: boolean;
    no_relevant_evidence: boolean;
    warnings: Warning[];
  };
};

export type AiBinding = {
  run(
    model: string,
    input: {
      messages: Array<{ role: "system" | "user"; content: string }>;
      stream: false;
      temperature: number;
      max_tokens?: number;
      max_completion_tokens?: number;
      chat_template_kwargs?: { enable_thinking: boolean };
      response_format: { type: "json_object" };
    },
  ): Promise<unknown>;
};

export type Env = { AI?: AiBinding; OPENROUTER_API_KEY?: string };
