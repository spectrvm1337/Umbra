import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// calc.js is a classic browser script, so load it into a sandbox and pull its functions out.
const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../src/calc.js", import.meta.url), "utf8"), ctx);
const { calcEvaluate, parseCalcQuery, formatCalcResult } = ctx;

test("follows operator precedence, brackets and powers", () => {
  assert.equal(calcEvaluate("2+2*3"), 8);
  assert.equal(calcEvaluate("(2+2)*3"), 12);
  assert.equal(calcEvaluate("2^3^2"), 512);
  assert.equal(calcEvaluate("-2^2"), -4);
  assert.equal(calcEvaluate("2^-1"), 0.5);
  assert.equal(calcEvaluate("2*-3"), -6);
  assert.equal(calcEvaluate("10/4"), 2.5);
  assert.equal(calcEvaluate("3 × 4 ÷ 2"), 6);
  assert.equal(calcEvaluate("1,5*2"), 3);
});

test("percent works like a desk calculator", () => {
  assert.equal(calcEvaluate("200+10%"), 220);
  assert.equal(calcEvaluate("200-10%"), 180);
  assert.equal(calcEvaluate("50*10%"), 5);
  assert.equal(calcEvaluate("15%"), 0.15);
});

test("rejects what is not an expression", () => {
  for (const q of ["2+", "(1+2", "1.2.3", "2**3", "1/0", "", "abc"]) {
    assert.equal(calcEvaluate(q), null, q);
  }
});

test("only real expressions turn into a calculator card", () => {
  assert.equal(parseCalcQuery("42"), null);
  assert.equal(parseCalcQuery("-5"), null);
  assert.equal(parseCalcQuery("192.168.1.1"), null);
  assert.equal(parseCalcQuery("100 usd"), null);
  assert.equal(parseCalcQuery("2+2").value, 4);
  assert.equal(parseCalcQuery(" 7% ").value, 0.07);
});

test("results are free of float noise", () => {
  assert.equal(formatCalcResult(calcEvaluate("0.1+0.2")), "0.3");
  assert.equal(formatCalcResult(1 / 3), "0.3333333333");
  assert.equal(formatCalcResult(2e20), "200000000000000000000");
});
