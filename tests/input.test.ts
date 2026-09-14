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
