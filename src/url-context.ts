import { LIMITS } from "./config";
import { upstreamUnavailable } from "./errors";
import { readText, withTimeout, type Fetcher } from "./http";
import { isPublicIp, validatePublicUrl } from "./input";
import type { Evidence } from "./services/types";
import { parseRecord } from "./validation";

const institutionDomains = ["gov.tw", "edu.tw"] as const;

export function isAllowlistedInstitutionUrl(url: URL): boolean {
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  return institutionDomains.some((domain) => host === domain || host.endsWith(`.${domain}`)) ||
    (url.protocol === "https:" && host === "tfc-taiwan.org.tw");
}

type HtmlElement = { remove(): void; before(text: string): void; after(text: string): void };
type HtmlRewriter = {
  on(selector: string, handlers: { element(element: HtmlElement): void }): HtmlRewriter;
  onDocument(handlers: { text(chunk: { text: string }): void }): HtmlRewriter;
  transform(response: Response): Response;
};
declare const HTMLRewriter: { new (): HtmlRewriter };

export async function extractHtmlText(html: string): Promise<string> {
  const stripped = new HTMLRewriter()
    .on("script, style, noscript, template, svg", {
      element(element) { element.remove(); },
    })
    .on("p, div, br, li, tr, h1, h2, h3, section, article", {
      element(element) { element.before(" "); element.after(" "); },
    })
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  let text = "";
  await new HTMLRewriter()
    .onDocument({ text(chunk) { text += chunk.text; } })
    .transform(stripped)
    .text();
  return text;
}

async function assertPublicDns(url: URL, fetcher: Fetcher, signal: AbortSignal) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.startsWith("[")) return;
  const answers = await Promise.all(["A", "AAAA"].map(async (type) => {
    const endpoint = new URL("https://cloudflare-dns.com/dns-query");
    endpoint.searchParams.set("name", url.hostname);
    endpoint.searchParams.set("type", type);
    const response = await fetcher(endpoint, { headers: { Accept: "application/dns-json" }, signal, redirect: "manual" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("DNS 查詢失敗");
    }
    const data = parseRecord(JSON.parse(await readText(response.body, 32_000, signal)));
    if (data.Status !== 0) throw new Error("DNS 解析失敗");
    if (data.Answer === undefined) return [];
    if (!Array.isArray(data.Answer)) throw new Error("DNS 回應格式不正確");
    return data.Answer.map(parseRecord);
  }));
  const addresses = answers.flat()
    .filter((answer) => answer.type === 1 || answer.type === 28)
    .map((answer) => {
      if (typeof answer.data !== "string" || answer.data.length > 100) throw new Error("DNS 位址格式不正確");
      return answer.data;
    });
  if (!addresses.length || addresses.some((address) => !isPublicIp(address))) throw new Error("非公開位址");
}

export async function fetchUrlContext(value: string, fetcher: Fetcher = fetch): Promise<Evidence> {
  try {
    return await withTimeout(async (signal) => {
      let url = validatePublicUrl(value);
      const visited = new Set<string>();
      for (let count = 0; count <= LIMITS.redirects; count++) {
        if (visited.has(url.href)) throw new Error("重新導向循環");
        visited.add(url.href);
        await assertPublicDns(url, fetcher, signal);
        const response = await fetcher(url, {
          method: "GET",
          headers: { Accept: "text/html, text/plain;q=0.9", "User-Agent": "FactCheckCore/0.1" },
          redirect: "manual",
          signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw new Error("缺少重新導向網址");
          url = validatePublicUrl(new URL(location, url).href);
          continue;
        }
        const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        const size = Number(response.headers.get("content-length") ?? 0);
        const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(response.headers.get("content-type") ?? "")?.[1].toLowerCase();
        if (!response.ok || !["text/html", "text/plain"].includes(type ?? "") || size > LIMITS.urlBytes || (charset && !["utf-8", "utf8", "us-ascii"].includes(charset))) {
          await response.body?.cancel();
          throw new Error("不支援的 URL 回應");
        }
        const raw = await readText(response.body, LIMITS.urlBytes, signal);
        // HTMLRewriter 的 document text callback 回傳已解碼的文字節點。
        const evidenceText = (type === "text/html" ? await extractHtmlText(raw) : raw)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, LIMITS.urlText);
        if (!evidenceText) throw new Error("沒有可用文字");
        return {
          source: "provided-url",
          reliability: isAllowlistedInstitutionUrl(url) ? "allowlisted-institution" : "user-provided",
          evidenceText,
          sourceUrl: url.href,
        };
      }
      throw new Error("重新導向過多");
    }, LIMITS.fetchTimeoutMs);
  } catch (error) {
    throw upstreamUnavailable("url", error);
  }
}

export type UrlContext = Evidence & { source: "provided-url" };
