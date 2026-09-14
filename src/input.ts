import { LIMITS } from "./config";
import type { FactCheckInput } from "./contracts";
import { invalidInput } from "./errors";

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("必須為物件");
  return value as Record<string, unknown>;
}

export function text(value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error("必須為文字");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error("文字不正確");
  return trimmed;
}

export function parseInput(value: unknown): FactCheckInput {
  try {
    const input = asRecord(value);
    const claim = text(input.text, 100_000);
    if ([...claim].length > LIMITS.text) throw new Error("文字過長");
    if (input.url === undefined) return { text: claim };
    return { text: claim, url: validatePublicUrl(text(input.url, LIMITS.url)).href };
  } catch {
    throw invalidInput();
  }
}

function ipv4IsPublic(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return false;
  const [a, b] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}

function ipv6IsPublic(host: string): boolean {
  try {
    if (host.includes(".")) return false;
    const [left, right = ""] = host.toLowerCase().split("::");
    if (host.split("::").length > 2) return false;
    const leftParts = left ? left.split(":") : [];
    const rightParts = right ? right.split(":") : [];
    if (leftParts.length + rightParts.length > 8 || (!host.includes("::") && leftParts.length !== 8)) return false;
    const groups = [...leftParts, ...Array(8 - leftParts.length - rightParts.length).fill("0"), ...rightParts];
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
    const value = groups.reduce((total, group) => (total << 16n) + BigInt(`0x${group}`), 0n);
    const prefix = (bits: number) => value >> BigInt(128 - bits);
    const is = (base: bigint, bits: number) => prefix(bits) === base >> BigInt(128 - bits);
    return is(0x20000000000000000000000000000000n, 3) &&
      !is(0x20010000000000000000000000000000n, 23) &&
      !is(0x20010db8000000000000000000000000n, 32) &&
      !is(0x20020000000000000000000000000000n, 16) &&
      !is(0x3fff0000000000000000000000000000n, 20);
  } catch {
    return false;
  }
}

export function isPublicIp(host: string): boolean {
  return host.includes(":") ? ipv6IsPublic(host) : ipv4IsPublic(host);
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
