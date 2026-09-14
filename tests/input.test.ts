import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/errors";
import { parseInput, validatePublicUrl } from "../src/input";

test("輸入正規化會保留文字並移除網址 fragment", () => {
  assert.deepEqual(parseInput({ text: "  測試主張  ", url: "https://example.org/path#fragment" }), {
    text: "測試主張",
    url: "https://example.org/path",
  });
});

test("輸入拒絕空白文字、私有位址與含 credential 的網址", () => {
  for (const value of [
    { text: " " },
    { text: "測試", url: "http://127.0.0.1" },
    { text: "測試", url: "http://localhost" },
    { text: "測試", url: "https://user:password@example.org" },
  ]) {
    assert.throws(() => parseInput(value), ApiError);
  }
  assert.throws(() => validatePublicUrl("http://192.168.1.1"), ApiError);
});

test("IP 範圍分類只接受公開 unicast 位址", () => {
  for (const value of [
    "http://192.88.99.1", // 已保留的 6to4 relay anycast 範圍
    "http://[2001:20::1]", // ORCHIDv2 特殊用途 IPv6 範圍
    "http://[::1]",
  ]) {
    assert.throws(() => validatePublicUrl(value), ApiError);
  }

  assert.equal(validatePublicUrl("https://8.8.8.8").hostname, "8.8.8.8");
  assert.equal(validatePublicUrl("https://[2606:4700:4700::1111]").hostname, "[2606:4700:4700::1111]");
});
