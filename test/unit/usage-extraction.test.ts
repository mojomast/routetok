import assert from "node:assert/strict";
import test from "node:test";
import { extractUsage } from "../../src/proxy.js";

test("usage.cost null or junk is treated as absent so estimation still runs", () => {
  const absent = extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: null } });
  assert.equal(absent.reportedCostUsd, undefined, "a null cost must not report a $0.00 cost");
  assert.equal(absent.costUsd, undefined);
  const junk = extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: "not-a-number" } });
  assert.equal(junk.reportedCostUsd, undefined, "an unparsable string cost must not report $0.00");
  const object = extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: { amount: 5 } } });
  assert.equal(object.reportedCostUsd, undefined);
  const absent2 = extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
  assert.equal(absent2.reportedCostUsd, undefined);
});

test("usage.cost finite numbers and numeric strings are reported verbatim", () => {
  const zero = extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } });
  assert.equal(zero.reportedCostUsd, 0, "a literal $0.00 cost remains a reported zero");
  const number = extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0012 } });
  assert.equal(number.reportedCostUsd, 0.0012);
  const string = extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: "1.5" } });
  assert.equal(string.reportedCostUsd, 1.5);
  const stringZero = extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: "0" } });
  assert.equal(stringZero.reportedCostUsd, 0);
  const negative = extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: -0.5 } });
  assert.equal(negative.reportedCostUsd, -0.5);
});

test("usage.cost non-finite numbers are treated as absent", () => {
  const nan = extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: NaN } });
  assert.equal(nan.reportedCostUsd, undefined);
  const infinity = extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: Infinity } });
  assert.equal(infinity.reportedCostUsd, undefined);
});

test("token and cny extraction keeps its existing semantics", () => {
  const usage = extractUsage({
    usage: { prompt_tokens: 2, completion_tokens: 3 },
    billing: { request: { cost_cny: { total: "0.42" } } }
  });
  assert.equal(usage.input, 2);
  assert.equal(usage.output, 3);
  assert.equal(usage.costCny, 0.42);
});
