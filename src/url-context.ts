import { LIMITS } from "./config";
import { upstreamUnavailable } from "./errors";
import { readText, withTimeout, type Fetcher } from "./http";
import { isPublicIp, validatePublicUrl } from "./input";
import { parseRecord } from "./validation";

export type UrlContext = {
  source: "provided-url";
  reliability: "user-provided" | "allowlisted-institution";
  evidenceText: string;
  sourceUrl: string;
};

const institutionDomains = ["gov.tw", "edu.tw"];

type HtmlElement = {
  remove(): void;
  before(text: string): void;
  after(text: string): void;
};

type HtmlRewriter = {
  on(selector: string, handlers: { element(element: HtmlElement): void }): HtmlRewriter;
  onDocument(handlers: { text(chunk: { text: string }): void }): HtmlRewriter;
  transform(response: Response): Response;
};

// HTMLRewriter 是 Cloudflare Workers 的原生 streaming HTML parser。
declare const HTMLRewriter: { new (): HtmlRewriter };

function allowlisted(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return institutionDomains.some((domain) => host === domain || host.endsWith(`.${domain}`)) ||
    (url.protocol === "https:" && host === "tfc-taiwan.org.tw");
}

async function assertPublicDns(url: URL, fetcher: Fetcher, signal: AbortSignal) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(":")) return;
  const answers = await Promise.all(["A", "AAAA"].map(async (type) => {
    const endpoint = new URL("https://cloudflare-dns.com/dns-query");
    endpoint.searchParams.set("name", url.hostname);
    endpoint.searchParams.set("type", type);
    const response = await fetcher(endpoint, { headers: { Accept: "application/dns-json" }, signal, redirect: "manual" });
    if (!response.ok) throw new Error("DNS 查詢失敗");
    const data = parseRecord(JSON.parse(await readText(response.body, 32_000, signal)));
    if (data.Status !== 0) throw new Error("DNS 解析失敗");
    return Array.isArray(data.Answer) ? data.Answer : [];
  }));
  // DoH 的 Answer 可能同時包含 CNAME 與最終 A／AAAA 紀錄；只有位址紀錄
  // 才應送入 IP 安全檢查，否則合法 CNAME 網域會被誤判成非公開 IP。
  const addresses = answers.flat().flatMap((answer): string[] => {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return [];
    const record = parseRecord(answer);
    return (record.type === 1 || record.type === 28) && typeof record.data === "string"
      ? [record.data]
      : [];
  });
  if (!addresses.length || addresses.some((address) => !isPublicIp(address))) throw new Error("非公開位址");
}

export async function extractHtmlText(html: string): Promise<string> {
  // 第一階段移除不可見／可執行節點並在區塊元素周圍加入分隔；第二階段只蒐集
  // parser 解析後的文字節點。不可用 regex，避免 attribute、entity 或非規則 HTML
  // 影響文字邊界。
  const stripped = new HTMLRewriter()
    .on("script, style, noscript, template, svg", {
      element(element) {
        element.remove();
      },
    })
    .on("p, div, br, li, tr, h1, h2, h3, section, article", {
      element(element) {
        element.before(" ");
        element.after(" ");
      },
    })
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  let result = "";
  await new HTMLRewriter()
    .onDocument({
      text(chunk) {
        result += chunk.text;
      },
    })
    .transform(stripped)
    .text();
  return result.replace(/\s+/g, " ").trim();
}

export async function fetchUrlContext(value: string, fetcher: Fetcher = fetch): Promise<UrlContext> {
  try {
    return await withTimeout(async (signal) => {
      let url = validatePublicUrl(value);
      const visited = new Set<string>();
      for (let count = 0; count <= LIMITS.redirects; count++) {
        if (visited.has(url.href)) throw new Error("重新導向循環");
        visited.add(url.href);
        await assertPublicDns(url, fetcher, signal);
        const response = await fetcher(url, {
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
        const evidenceText = (type === "text/html" ? await extractHtmlText(raw) : raw).slice(0, LIMITS.urlText);
        if (!evidenceText) throw new Error("沒有可用文字");
        return { source: "provided-url", reliability: allowlisted(url) ? "allowlisted-institution" : "user-provided", evidenceText, sourceUrl: url.href };
      }
      throw new Error("重新導向過多");
    }, LIMITS.fetchTimeoutMs);
  } catch (error) {
    throw upstreamUnavailable("url", error);
  }
}
