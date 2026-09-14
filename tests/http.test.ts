import assert from "node:assert/strict";
import test from "node:test";
import { TimeoutError, withTimeout } from "../src/http";

test("withTimeout 在 action 未結束時立即 reject 並 abort signal", async () => {
  let aborted = false;
  const pending = withTimeout(
    (signal) =>
      new Promise<never>(() => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
      }),
    10,
  );

  await assert.rejects(pending, TimeoutError);
  assert.equal(aborted, true);
});

test("withTimeout 不會讓已完成的 action 被 timeout 影響", async () => {
  await assert.doesNotReject(() => withTimeout(async () => "done", 10));
  assert.equal(await withTimeout(async () => "done", 10), "done");
});
