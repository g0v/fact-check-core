import ipaddr from "ipaddr.js";
import { LIMITS } from "./config";
import type { FactCheckInput } from "./contracts";
import { invalidInput } from "./errors";
import { parseRecord, parseText } from "./validation";

export function parseInput(value: unknown): FactCheckInput {
  try {
    const input = parseRecord(value);
    const claim = parseText(input.text, 100_000);
    if ([...claim].length > LIMITS.text) throw new Error("文字過長");
    if (input.url === undefined) return { text: claim };
    return { text: claim, url: validatePublicUrl(parseText(input.url, LIMITS.url)).href };
  } catch {
    throw invalidInput();
  }
}

export function isPublicIp(host: string): boolean {
  try {
    // 僅允許可在公網路由的位址；private、reserved、loopback、link-local 等
    // 所有特殊範圍一律 fail closed。
    return ipaddr.parse(host).range() === "unicast";
  } catch {
    return false;
  }
}

export function validatePublicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidInput();
  }
  if (
    value.length > LIMITS.url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw invalidInput();
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
  if (isIp ? !isPublicIp(host) : !host.includes(".") || /(^|\.)(localhost|local|internal|lan|home|invalid|test)$/.test(host)) {
    throw invalidInput();
  }
  url.hostname = host;
  url.hash = "";
  return url;
}

export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return validatePublicUrl(value).href;
  } catch {
    return undefined;
  }
}
