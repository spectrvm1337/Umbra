// Calculator in the search box: "2+2*3", "(1.5+2)^2", "200+10%". A small
// recursive-descent parser (the CSP rules out eval, and that is a good thing).
// Percent works like a desk calculator: a + b% adds b% of a, a * b% is a * b / 100,
// a lone b% is b / 100.

const CALC_CHARS_RE = /^[\d\s.,+\-*/×÷^%()]+$/;

function calcTokens(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " ") { i++; continue; }
    if (/[\d.,]/.test(c)) {
      let j = i;
      while (j < src.length && /[\d.,]/.test(src[j])) j++;
      const raw = src.slice(i, j).replace(",", ".");
      if (!/^(\d+\.?\d*|\.\d+)$/.test(raw)) return null; // "1.2.3", "1,000,5"
      tokens.push({ num: Number(raw) });
      i = j;
      continue;
    }
    tokens.push({ op: c === "×" ? "*" : c === "÷" ? "/" : c });
    i++;
  }
  return tokens;
}

// Evaluates the expression, or returns null when it is not one (or not finite).
function calcEvaluate(src) {
  const tokens = calcTokens(String(src).trim());
  if (!tokens || !tokens.length) return null;
  let pos = 0;
  const peek = () => tokens[pos] && tokens[pos].op;
  const fail = () => { throw new Error("calc"); };
  // Each value carries pct when it was written as "n%", so + and - can scale it.
  function primary() {
    const t = tokens[pos];
    if (!t) fail();
    if (t.num !== undefined) { pos++; return { v: t.num }; }
    if (t.op === "(") {
      pos++;
      const v = expr();
      if (peek() !== ")") fail();
      pos++;
      return { v: v.v };
    }
    return fail();
  }
  function postfix() {
    const x = primary();
    if (peek() === "%") { pos++; return { v: x.v / 100, pct: true }; }
    return x;
  }
  // ^ binds tighter than a leading minus: -2^2 is -4, 2^-1 is 0.5.
  function power() {
    const base = postfix();
    if (peek() === "^") { pos++; const exp = unary(); return { v: Math.pow(base.v, exp.v) }; }
    return base;
  }
  function unary() {
    if (peek() === "-") { pos++; const x = unary(); return { v: -x.v, pct: x.pct }; }
    if (peek() === "+") { pos++; return unary(); }
    return power();
  }
  function term() {
    let x = unary();
    while (peek() === "*" || peek() === "/") {
      const op = tokens[pos++].op;
      const y = unary();
      x = { v: op === "*" ? x.v * y.v : x.v / y.v };
    }
    return x;
  }
  function expr() {
    let x = term();
    while (peek() === "+" || peek() === "-") {
      const op = tokens[pos++].op;
      const y = term();
      const amount = y.pct ? x.v * y.v : y.v;
      x = { v: op === "+" ? x.v + amount : x.v - amount };
    }
    return x;
  }
  try {
    const result = expr();
    if (pos !== tokens.length || !Number.isFinite(result.v)) return null;
    return result.v;
  } catch {
    return null;
  }
}

// Only real expressions: an operator somewhere past a leading sign, so a bare
// number, "-5" or an IP address stays an ordinary search.
function parseCalcQuery(query) {
  const q = String(query).trim();
  if (!CALC_CHARS_RE.test(q) || !/\d/.test(q)) return null;
  if (!/[+\-*/×÷^%(]/.test(q.slice(1))) return null;
  const value = calcEvaluate(q);
  return value === null ? null : { expr: q, value };
}

// At most 10 decimals, no float noise ("0.1+0.2" is 0.3), plain digits for copying.
function formatCalcResult(v) {
  if (Math.abs(v) >= 1e15 || (v !== 0 && Math.abs(v) < 1e-9)) return String(Number(v.toPrecision(12)));
  return String(Number(v.toFixed(10)));
}

function handleCalcCommand(query) {
  const p = parseCalcQuery(query);
  if (!p) return false;
  const result = formatCalcResult(p.value);
  specialSection.classList.remove("hidden");
  resultsSection.classList.add("hidden");
  pinsSection.classList.add("hidden");
  specialContent.innerHTML = `
    <div class="special-card">
      <div class="special-action calc-card">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><path d="M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h.01M12 19h.01M16 19h.01"/></svg>
        <span>${escapeHtml(p.expr)} = <b>${escapeHtml(result)}</b></span>
        <span class="special-hint">${escapeHtml(t("calcCopy"))}</span>
      </div>
    </div>`;
  specialContent.querySelector(".calc-card").addEventListener("click", () => copyPath(result));
  // Enter copies the result (a "copy" row, see activateItem).
  selectableItems = [{ name: result, path: result, kind: "copy", icon_data: null, pinned: false }];
  selectedIndex = 0;
  return true;
}
